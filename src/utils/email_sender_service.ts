/**
 * Email Sender Service — payload schema formatting
 *
 * Normalises an outbound alert into one canonical payload and serialises it
 * against a named shape template, so every consumer (transport adapter, audit
 * log, webhook) reads exactly the same fields in exactly the same order.
 *
 * Nothing here performs I/O: the service layer decides when to hand the
 * serialised payload to a provider.
 */

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
