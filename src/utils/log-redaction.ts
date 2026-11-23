import { createHash } from "crypto";
import type { Request } from "express";
import type { ZodError } from "zod";

/**
 * Privacy-first log metadata (#680).
 *
 * Request bodies carry wallet addresses, amounts and signed transaction
 * envelopes. A signed XDR in a log is a replayable transaction for anyone
 * with log access, so validation failures record only the shape of what was
 * rejected, never the values.
 */

/** Hex characters of the SHA-256 digest kept as an XDR fingerprint. */
const XDR_HASH_PREFIX_LENGTH = 12;

export interface RejectedBodyLogMeta {
  /** Top-level keys present in the body (names only, no values). */
  bodyKeys: string[];
  /** Size of the JSON-serialised body in bytes. */
  bodyBytes: number;
  /** Dotted Zod issue paths, e.g. `["amount", "milestones.0.amount"]`. */
  issuePaths: string[];
}

function byteLength(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
  } catch {
    return 0;
  }
}

/** Shape-only description of a rejected request body. */
export function describeRejectedBody(
  body: unknown,
  error?: ZodError,
): RejectedBodyLogMeta {
  const bodyKeys =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? Object.keys(body as Record<string, unknown>)
      : [];
  const issuePaths = error
    ? [...new Set(error.issues.map((issue) => issue.path.join(".") || "_root"))]
    : [];
  return { bodyKeys, bodyBytes: byteLength(body), issuePaths };
}

/** `describeRejectedBody` for an Express request. */
export function rejectedRequestLogMeta(req: Request, error?: ZodError): RejectedBodyLogMeta {
  return describeRejectedBody(req.body, error);
}

export interface XdrLogMeta {
  xdrLength?: number;
  /** First 12 hex chars of SHA-256(xdr): enough to correlate, not to replay. */
  xdrSha256Prefix?: string;
}

/** Correlatable fingerprint of a (signed) XDR string that never includes it. */
export function xdrLogMeta(xdr: unknown): XdrLogMeta {
  if (typeof xdr !== "string") return {};
  return {
    xdrLength: xdr.length,
    xdrSha256Prefix: createHash("sha256")
      .update(xdr)
      .digest("hex")
      .slice(0, XDR_HASH_PREFIX_LENGTH),
  };
}

/**
 * Truncate a Stellar address to `GABC…WXYZ` for info-level logs.
 *
 * Full addresses must never appear at `info` (the production log level)
 * because the HTTP request logger records the caller's IP on every request,
 * so logging the full address alongside it builds a durable IP↔wallet map.
 * Four leading + four trailing characters are enough for same-session
 * correlation without exposing the complete key.
 *
 * Pass the raw value to `logger.debug` wherever the full address is needed
 * for post-incident debugging.
 */
export function maskAddress(address: string | undefined | null): string {
  if (!address || address.length < 10) return address ?? "";
  return `${address.slice(0, 4)}\u2026${address.slice(-4)}`;
}

/** Max characters of an untrusted, unvalidated value kept in a log line. */
const UNTRUSTED_LOG_PREFIX_LENGTH = 8;

/**
 * Shorten a possibly attacker-controlled value (e.g. a path param that
 * failed validation) before logging it (#866).
 */
export function truncateForLog(value: unknown): string {
  const str = typeof value === "string" ? value : String(value ?? "");
  return str.length > UNTRUSTED_LOG_PREFIX_LENGTH
    ? `${str.slice(0, UNTRUSTED_LOG_PREFIX_LENGTH)}\u2026`
    : str;
}
