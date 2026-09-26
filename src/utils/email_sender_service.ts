/**
 * email_sender_service – Email alert processor.
 *
 * Signs outbound webhook notifications with an HMAC secret so clients can
 * verify authenticity, and enforces connection timeouts so stalled requests
 * to external mail/webhook servers fail fast with a warning.
 */

import { createHmac, timingSafeEqual } from "crypto";
import logger from "./logger.js";

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
