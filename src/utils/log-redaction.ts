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
