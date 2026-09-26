/**
 * email_sender_service – Email alert processor.
 *
 * - Payload schema formatting: normalises an outbound alert into one canonical
 *   payload and serialises it against a named shape template, so every
 *   consumer (transport adapter, audit log, webhook) reads exactly the same
 *   fields in exactly the same order. These helpers perform no I/O.
 * - Outbound signing and timeouts: signs outbound webhook notifications with
 *   an HMAC secret so clients can verify authenticity, and enforces connection
 *   timeouts so stalled requests to external mail/webhook servers fail fast
 *   with a warning.
 */

import { createHmac, timingSafeEqual } from "crypto";
import logger from "./logger.js";

// ---------------------------------------------------------------------------
// Payload schema formatting (#524)
// ---------------------------------------------------------------------------

export const EMAIL_SENDER_ERRORS = {
  INVALID_PAYLOAD: "ESS_INVALID_PAYLOAD",
  INVALID_RECIPIENT: "ESS_INVALID_RECIPIENT",
  UNKNOWN_SHAPE: "ESS_UNKNOWN_SHAPE",
  SERIALIZE_FAILURE: "ESS_SERIALIZE_FAILURE",
} as const;

export type EmailSenderErrorCode =
  (typeof EMAIL_SENDER_ERRORS)[keyof typeof EMAIL_SENDER_ERRORS];

/** An outbound email alert as callers supply it. */
export type EmailPayload = {
  to: string | string[];
  subject: string;
  template: string;
  from?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  variables?: Record<string, string | number | boolean | null>;
};

/** The canonical shape every payload is normalised into. */
export type CanonicalEmailPayload = {
  from: string | null;
  replyTo: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  template: string;
  variables: Record<string, string | number | boolean | null>;
};

export type PayloadField = keyof CanonicalEmailPayload;

/**
 * A config template describing the exact fields (and their order) a given
 * consumer expects. Serialisation always follows the template, so a new field
 * can never leak into a shape that was not designed for it.
 */
export type PayloadShapeTemplate = {
  name: string;
  fields: readonly PayloadField[];
};

export const PAYLOAD_SHAPES: Record<string, PayloadShapeTemplate> = {
  /** Full internal shape, used by the audit trail. */
  canonical: {
    name: "canonical",
    fields: ["from", "replyTo", "to", "cc", "bcc", "subject", "template", "variables"],
  },
  /** What the SMTP transport adapter consumes. */
  transport: {
    name: "transport",
    fields: ["from", "replyTo", "to", "cc", "bcc", "subject", "variables"],
  },
  /** Compact shape for activity rows and webhooks. */
  audit: {
    name: "audit",
    fields: ["to", "subject", "template"],
  },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SUBJECT_LENGTH = 998;

function normaliseAddress(value: unknown, field: string): string | { error: string } {
  if (typeof value !== "string") {
    return { error: `${field} must be a string address` };
  }

  // Accept the common `Name <addr@host>` form and keep only the address.
  const match = value.match(/<([^>]+)>\s*$/);
  const address = (match ? match[1] : value).trim();

  if (!EMAIL_RE.test(address)) {
    return { error: `${field} "${value}" is not a valid email address` };
  }

  return address.toLowerCase();
}

function normaliseAddressList(value: unknown, field: string): string[] | { error: string } {
  if (value === undefined || value === null) return [];

  const list = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const addresses: string[] = [];

  for (const entry of list) {
    const normalised = normaliseAddress(entry, field);
    if (typeof normalised !== "string") return normalised;
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    addresses.push(normalised);
  }

  return addresses;
}

export type NormaliseResult =
  | { ok: true; payload: CanonicalEmailPayload }
  | { ok: false; error: string; code: EmailSenderErrorCode };

/** Validate and normalise an alert into the canonical payload shape. */
export function normaliseEmailPayload(input: EmailPayload): NormaliseResult {
  if (typeof input !== "object" || input === null) {
    return {
      ok: false,
      error: "payload must be an object",
      code: EMAIL_SENDER_ERRORS.INVALID_PAYLOAD,
    };
  }

  const to = normaliseAddressList(input.to, "to");
  if (!Array.isArray(to)) {
    return { ok: false, error: to.error, code: EMAIL_SENDER_ERRORS.INVALID_RECIPIENT };
  }
  if (to.length === 0) {
    return {
      ok: false,
      error: "to must contain at least one recipient",
      code: EMAIL_SENDER_ERRORS.INVALID_RECIPIENT,
    };
  }

  const cc = normaliseAddressList(input.cc, "cc");
  if (!Array.isArray(cc)) {
    return { ok: false, error: cc.error, code: EMAIL_SENDER_ERRORS.INVALID_RECIPIENT };
  }

  const bcc = normaliseAddressList(input.bcc, "bcc");
  if (!Array.isArray(bcc)) {
    return { ok: false, error: bcc.error, code: EMAIL_SENDER_ERRORS.INVALID_RECIPIENT };
  }

  let from: string | null = null;
  if (input.from !== undefined && input.from !== null && input.from !== "") {
    const normalised = normaliseAddress(input.from, "from");
    if (typeof normalised !== "string") {
      return { ok: false, error: normalised.error, code: EMAIL_SENDER_ERRORS.INVALID_RECIPIENT };
    }
    from = normalised;
  }

  let replyTo: string | null = null;
  if (input.replyTo !== undefined && input.replyTo !== null && input.replyTo !== "") {
    const normalised = normaliseAddress(input.replyTo, "replyTo");
    if (typeof normalised !== "string") {
      return { ok: false, error: normalised.error, code: EMAIL_SENDER_ERRORS.INVALID_RECIPIENT };
    }
    replyTo = normalised;
  }

  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  if (subject.length === 0) {
    return {
      ok: false,
      error: "subject is required",
      code: EMAIL_SENDER_ERRORS.INVALID_PAYLOAD,
    };
  }
  if (subject.length > MAX_SUBJECT_LENGTH) {
    return {
      ok: false,
      error: `subject exceeds ${MAX_SUBJECT_LENGTH} characters`,
      code: EMAIL_SENDER_ERRORS.INVALID_PAYLOAD,
    };
  }

  if (typeof input.template !== "string" || input.template.trim().length === 0) {
    return {
      ok: false,
      error: "template is required",
      code: EMAIL_SENDER_ERRORS.INVALID_PAYLOAD,
    };
  }

  // Variable keys are sorted so two equivalent payloads serialise identically.
  const variables: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(input.variables ?? {}).sort()) {
    const value = (input.variables ?? {})[key];
    if (value === undefined) continue;
    variables[key] = value;
  }

  return {
    ok: true,
    payload: {
      from,
      replyTo,
      to: [...to].sort(),
      cc: [...cc].sort(),
      bcc: [...bcc].sort(),
      subject,
      template: input.template.trim(),
      variables,
    },
  };
}

export function resolveShape(shape: string | PayloadShapeTemplate): PayloadShapeTemplate {
  if (typeof shape !== "string") return shape;
  const template = PAYLOAD_SHAPES[shape];
  if (!template) {
    throw new Error(`${EMAIL_SENDER_ERRORS.UNKNOWN_SHAPE}: "${shape}" is not a known payload shape`);
  }
  return template;
}

/**
 * Project a canonical payload onto a shape template. Fields the template does
 * not declare are dropped rather than passed through.
 */
export function toShape(
  payload: CanonicalEmailPayload,
  shape: string | PayloadShapeTemplate
): Record<string, unknown> {
  const template = resolveShape(shape);
  const projected: Record<string, unknown> = {};

  for (const field of template.fields) {
    switch (field) {
      case "to":
      case "cc":
      case "bcc":
        projected[field] = [...payload[field]];
        break;
      case "variables":
        projected[field] = { ...payload.variables };
        break;
      default:
        projected[field] = payload[field];
    }
  }

  return projected;
}

export type SerializeResult =
  | { ok: true; json: string; shape: string; fields: readonly PayloadField[] }
  | { ok: false; error: string; code: EmailSenderErrorCode };

/**
 * Validate, normalise and serialise an alert against a shape template.
 * The resulting JSON has exactly the template's keys, in template order.
 */
export function serializeEmailPayload(
  input: EmailPayload,
  shape: string | PayloadShapeTemplate = "canonical"
): SerializeResult {
  let template: PayloadShapeTemplate;
  try {
    template = resolveShape(shape);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: EMAIL_SENDER_ERRORS.UNKNOWN_SHAPE,
    };
  }

  const normalised = normaliseEmailPayload(input);
  if (!normalised.ok) return normalised;

  try {
    return {
      ok: true,
      json: JSON.stringify(toShape(normalised.payload, template)),
      shape: template.name,
      fields: template.fields,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: EMAIL_SENDER_ERRORS.SERIALIZE_FAILURE,
    };
  }
}

/**
 * Confirm a serialised payload carries exactly the template's keys — the check
 * callers use to assert an output matches its configured shape.
 */
export function matchesShape(serialised: string, shape: string | PayloadShapeTemplate): boolean {
  const template = resolveShape(shape);

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialised);
  } catch {
    return false;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;

  const keys = Object.keys(parsed as Record<string, unknown>);
  if (keys.length !== template.fields.length) return false;
  return template.fields.every((field, index) => keys[index] === field);
}

// ---------------------------------------------------------------------------
// Outbound signing and timeouts (#520–#523)
// ---------------------------------------------------------------------------

/** Default outbound call timeout (ms). Overridable via EMAIL_SENDER_TIMEOUT_MS. */
export const DEFAULT_EMAIL_SENDER_TIMEOUT_MS = 5_000;

/** Header name carrying the HMAC-SHA256 hex signature. */
export const WEBHOOK_SIGNATURE_HEADER = "X-Webhook-Signature";

/** Prefix used in the signature header value (e.g. sha256=<hex>). */
export const SIGNATURE_SCHEME = "sha256";

export class EmailSenderTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, url: string) {
    super(
      `email_sender_service request timed out after ${timeoutMs}ms calling ${url}`
    );
    this.name = "EmailSenderTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class EmailSenderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailSenderConfigError";
  }
}

export type SignedWebhookPayload = {
  /** Canonical JSON body that was signed. */
  body: string;
  /** Hex-encoded HMAC-SHA256 digest. */
  signatureHex: string;
  /** Full header value: `sha256=<hex>`. */
  signatureHeader: string;
};

export type SendEmailAlertInput = {
  /** Destination webhook / alert endpoint. */
  webhookUrl: string;
  /** Alert payload (will be JSON-serialized). */
  payload: Record<string, unknown>;
  /** HMAC secret used to sign the outbound body. */
  secret?: string;
  /** Override connection timeout in milliseconds. */
  timeoutMs?: number;
};

export type SendEmailAlertResult = {
  ok: boolean;
  status?: number;
  signatureHeader: string;
  timedOut: boolean;
};

/**
 * Resolve the active timeout from an explicit override or env, falling back
 * to {@link DEFAULT_EMAIL_SENDER_TIMEOUT_MS}.
 */
export function resolveEmailSenderTimeoutMs(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const fromEnv = Number(process.env.EMAIL_SENDER_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.floor(fromEnv);
  }
  return DEFAULT_EMAIL_SENDER_TIMEOUT_MS;
}

/**
 * Resolve the signing secret from an explicit value or EMAIL_WEBHOOK_SECRET.
 */
export function resolveWebhookSigningSecret(explicit?: string): string {
  const secret = explicit ?? process.env.EMAIL_WEBHOOK_SECRET ?? "";
  if (!secret) {
    throw new EmailSenderConfigError(
      "EMAIL_WEBHOOK_SECRET (or explicit secret) is required to sign outgoing webhooks"
    );
  }
  return secret;
}

/**
 * Sign a payload body with HMAC-SHA256 using the provided secret.
 * Clients verify with the same algorithm / header format.
 */
export function signOutgoingWebhook(
  payload: Record<string, unknown> | string,
  secret: string
): SignedWebhookPayload {
  if (!secret) {
    throw new EmailSenderConfigError("Signing secret must be a non-empty string");
  }

  const body =
    typeof payload === "string" ? payload : JSON.stringify(payload);
  const signatureHex = createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("hex");

  return {
    body,
    signatureHex,
    signatureHeader: `${SIGNATURE_SCHEME}=${signatureHex}`,
  };
}

/**
 * Verify a client-received signature against the raw body and secret.
 * Accepts either a bare hex digest or a `sha256=<hex>` header value.
 * Uses timing-safe comparison to avoid leaking digest length mismatches.
 */
export function verifyWebhookSignature(
  body: string,
  signature: string,
  secret: string
): boolean {
  if (!secret || !signature || typeof body !== "string") {
    return false;
  }

  const providedHex = signature.includes("=")
    ? signature.split("=").slice(1).join("=").trim()
    : signature.trim();

  if (!/^[0-9a-f]+$/i.test(providedHex)) {
    return false;
  }

  const expectedHex = createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("hex");

  try {
    const provided = Buffer.from(providedHex, "hex");
    const expected = Buffer.from(expectedHex, "hex");
    if (provided.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

/**
 * POST an email alert notification to an external webhook URL.
 * Signs the body, enforces a connection timeout, and warns on stalls.
 */
export async function sendEmailAlert(
  input: SendEmailAlertInput
): Promise<SendEmailAlertResult> {
  const secret = resolveWebhookSigningSecret(input.secret);
  const timeoutMs = resolveEmailSenderTimeoutMs(input.timeoutMs);
  const signed = signOutgoingWebhook(input.payload, secret);

  logger.debug("email_sender_service sending alert", {
    webhookUrl: input.webhookUrl,
    timeoutMs,
    payloadBytes: Buffer.byteLength(signed.body, "utf8"),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(input.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [WEBHOOK_SIGNATURE_HEADER]: signed.signatureHeader,
      },
      body: signed.body,
      signal: controller.signal,
    });

    logger.info("email_sender_service alert delivered", {
      webhookUrl: input.webhookUrl,
      status: response.status,
      ok: response.ok,
    });

    return {
      ok: response.ok,
      status: response.status,
      signatureHeader: signed.signatureHeader,
      timedOut: false,
    };
  } catch (err) {
    const aborted =
      (err instanceof Error && err.name === "AbortError") ||
      controller.signal.aborted;

    if (aborted) {
      logger.warn("email_sender_service call timeout threshold exceeded", {
        webhookUrl: input.webhookUrl,
        timeoutMs,
        thresholdMs: timeoutMs,
      });
      throw new EmailSenderTimeoutError(timeoutMs, input.webhookUrl);
    }

    const message = err instanceof Error ? err.message : String(err);
    logger.error("email_sender_service alert delivery failed", {
      webhookUrl: input.webhookUrl,
      error: message,
    });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
