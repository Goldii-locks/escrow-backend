/**
 * Shared digit-limit validator for overflow-guard utils.
 *
 * `digitCount()` was byte-identical across audit_ledger_sum_checker.ts,
 * conversion_rate_scraper.ts, interest_yield_estimator.ts and
 * refund_ratio_helper.ts, and `parseIntegerInput()` was byte-identical
 * across three of them. This module is the single source of truth; callers
 * keep their own ERROR_CODES and pass the invalid-input code in (as before).
 *
 * Behaviour is intentionally unchanged: the shared validator's regex is
 * /^-?\d+$/, which accepts negative values. Per-caller negativity policy
 * is out of scope here (see issue #468 for refund_ratio_helper).
 */

/** Max decimal digits allowed for a single amount (below Number.MAX_SAFE_INTEGER). */
export const MAX_SAFE_DIGITS = 15;

export type SharedValidationResult<TCode extends string> =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: TCode };

/**
 * Count decimal digits in a normalized numeric string.
 * Strips a leading minus and leading zeroes (keeping at least one digit).
 */
export function digitCount(normalized: string): number {
  const digits = normalized.replace(/^-/, "").replace(/^0+(?=\d)/, "");
  return digits.length === 0 ? 1 : digits.length;
}

/**
 * Parse and validate an integer string/number/bigint against digit limits.
 *
 * @param input - value to parse
 * @param label - human-readable label used in error messages
 * @param invalidCode - caller's invalid-input error code (codes differ per caller)
 * @param excessiveCode - caller's excessive-digits error code
 */
export function parseIntegerInput<TCode extends string>(
  input: string | number | bigint,
  label: string,
  invalidCode: TCode,
  excessiveCode: TCode
): SharedValidationResult<TCode> {
  let raw: string;

  if (typeof input === "bigint") {
    raw = input.toString();
  } else if (typeof input === "number") {
    if (!Number.isFinite(input) || !Number.isInteger(input)) {
      return {
        ok: false,
        error: `${label} must be a finite integer`,
        code: invalidCode,
      };
    }
    raw = String(input);
  } else {
    raw = input.trim();
    if (!/^-?\d+$/.test(raw)) {
      return {
        ok: false,
        error: `${label} must be an integer numeric value`,
        code: invalidCode,
      };
    }
  }

  if (digitCount(raw) > MAX_SAFE_DIGITS) {
    return {
      ok: false,
      error: `${label} exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
      code: excessiveCode,
    };
  }

  return { ok: true, value: BigInt(raw) };
}
