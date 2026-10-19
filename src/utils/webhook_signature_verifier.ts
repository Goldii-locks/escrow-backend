/**
 * webhook_signature_verifier – secret signature creator for outbound
 * notifications (webhooks, push messages).
 *
 * Signatures are HMAC-SHA256 over `${timestamp}.${body}` so a receiver can
 * authenticate the body and reject replays of old deliveries. The values are
 * sent in two headers, matching the scheme used by email_sender_service:
 *
 *   X-Webhook-Timestamp: <unix seconds>
 *   X-Webhook-Signature: sha256=<hex digest>
 */

import { createHmac, timingSafeEqual } from "crypto";

export const WEBHOOK_SIGNATURE_HEADER = "X-Webhook-Signature";
export const WEBHOOK_TIMESTAMP_HEADER = "X-Webhook-Timestamp";
export const WEBHOOK_SIGNATURE_SCHEME = "sha256";

/** Minimum secret length; shorter secrets are trivially brute-forced. */
export const WEBHOOK_SECRET_MIN_LENGTH = 32;

export const SIGNATURE_ERROR_CODES = {
  MISSING_SECRET: "WEBHOOK_SIGNATURE_MISSING_SECRET",
  WEAK_SECRET: "WEBHOOK_SIGNATURE_WEAK_SECRET",
  INVALID_TIMESTAMP: "WEBHOOK_SIGNATURE_INVALID_TIMESTAMP",
} as const;

export type SignatureErrorCode =
  (typeof SIGNATURE_ERROR_CODES)[keyof typeof SIGNATURE_ERROR_CODES];

export class WebhookSignatureError extends Error {
  readonly code: SignatureErrorCode;

  constructor(code: SignatureErrorCode, message: string) {
    super(message);
    this.name = "WebhookSignatureError";
    this.code = code;
  }
}

export type SignedPayload = {
  /** Unix timestamp (seconds) bound into the signature. */
  timestamp: number;
  /** Hex HMAC-SHA256 digest. */
  signature: string;
  /** Headers to attach to the outgoing request. */
  headers: Record<string, string>;
};

/**
 * Throw a WebhookSignatureError unless `secret` is a string of at least
 * WEBHOOK_SECRET_MIN_LENGTH characters.
 */
export function assertValidSigningSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new WebhookSignatureError(
      SIGNATURE_ERROR_CODES.MISSING_SECRET,
      "A signing secret is required to sign outgoing notifications"
    );
  }
  if (secret.length < WEBHOOK_SECRET_MIN_LENGTH) {
    throw new WebhookSignatureError(
      SIGNATURE_ERROR_CODES.WEAK_SECRET,
      `Signing secret must be at least ${WEBHOOK_SECRET_MIN_LENGTH} characters`
    );
  }
}

function assertValidTimestamp(timestamp: number): void {
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new WebhookSignatureError(
      SIGNATURE_ERROR_CODES.INVALID_TIMESTAMP,
      "Signature timestamp must be a positive integer (unix seconds)"
    );
  }
}

/** Hex HMAC-SHA256 of `${timestamp}.${body}`. */
export function computeSignature(
  body: string,
  secret: string,
  timestamp: number
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");
}

/**
 * Sign a serialized body. Validates the secret and timestamp first.
 */
export function signPayload(
  body: string,
  secret: unknown,
  timestamp: number = Math.floor(Date.now() / 1000)
): SignedPayload {
  assertValidSigningSecret(secret);
  assertValidTimestamp(timestamp);
  const signature = computeSignature(body, secret, timestamp);
  return {
    timestamp,
    signature,
    headers: {
      [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
      [WEBHOOK_SIGNATURE_HEADER]: `${WEBHOOK_SIGNATURE_SCHEME}=${signature}`,
    },
  };
}

/**
 * Constant-time check that `signature` (hex, optionally `sha256=`-prefixed)
 * matches the body, secret and timestamp. Never throws.
 */
export function verifySignature(
  body: string,
  secret: string,
  timestamp: number,
  signature: string
): boolean {
  if (typeof body !== "string" || typeof signature !== "string" || !secret) {
    return false;
  }
  const prefix = `${WEBHOOK_SIGNATURE_SCHEME}=`;
  const providedHex = signature.startsWith(prefix)
    ? signature.slice(prefix.length)
    : signature;
  if (!/^[0-9a-f]{64}$/i.test(providedHex)) return false;

  const expected = Buffer.from(computeSignature(body, secret, timestamp), "hex");
  const provided = Buffer.from(providedHex, "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
