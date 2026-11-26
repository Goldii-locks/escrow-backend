/**
 * Shared digit-limit validator for overflow-guard utils.
 *
 * `digitCount()` was duplicated across audit_ledger_sum_checker.ts and
 * interest_yield_estimator.ts, and `parseIntegerInput()` was duplicated
 * across the same callers. This module is the single source of truth; callers
 * keep their own ERROR_CODES and pass the invalid-input code in (as before).
 *
 * Negative values remain accepted by default for callers that allow them.
 * Callers can opt into non-negative validation and distinct missing/type codes
 * through the options argument.
 */

/** Max decimal digits allowed for a single amount (below Number.MAX_SAFE_INTEGER). */
export const MAX_SAFE_DIGITS = 15;

export const MAX_AMOUNT = 2n ** 127n - 1n;
export const MIN_AMOUNT = -(2n ** 127n);
export const AMOUNT_OUT_OF_RANGE = "AMOUNT_OUT_OF_RANGE" as const;

export function isAmountWithinRange(value: bigint): boolean {
  return value >= MIN_AMOUNT && value <= MAX_AMOUNT;
}

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
 * Parse and validate an integer string/number/bigint against the i128 range.
 *
 * @param input - value to parse
 * @param label - human-readable label used in error messages
 * @param invalidCode - caller's invalid-input error code (codes differ per caller)
 * @param excessiveCode - caller's out-of-range error code (AMOUNT_OUT_OF_RANGE)
 * @param options - optional non-negative, missing-value, and type policies
 */
export function parseIntegerInput<TCode extends string>(
  input: unknown,
  label: string,
  invalidCode: TCode,
  excessiveCode: TCode,
  options: {
    nonNegative?: boolean;
    missingCode?: TCode;
    invalidTypeCode?: TCode;
  } = {}
): SharedValidationResult<TCode> {
  let raw: string;

  if (input === undefined || input === null) {
    return {
      ok: false,
      error: `${label} is required`,
      code: options.missingCode ?? invalidCode,
    };
  }

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
    // A JS number above 2^53 has already lost precision, so it cannot be
    // trusted as an exact amount; large amounts must arrive as strings.
    if (!Number.isSafeInteger(input)) {
      return {
        ok: false,
        error: `${label} exceeds Number.MAX_SAFE_INTEGER; pass large amounts as a string or bigint`,
        code: invalidCode,
      };
    }
    raw = String(input);
  } else if (typeof input === "string") {
    raw = input.trim();
    if (!/^-?\d+$/.test(raw)) {
      return {
        ok: false,
        error: `${label} must be an integer numeric value`,
        code: invalidCode,
      };
    }
  } else {
    return {
      ok: false,
      error: `${label} must be a string, number, or bigint`,
      code: options.invalidTypeCode ?? invalidCode,
    };
  }

  if (!isAmountWithinRange(BigInt(raw))) {
    return {
      ok: false,
      error: `${label} exceeds the i128 amount range`,
      code: excessiveCode,
    };
  }

  const value = BigInt(raw);
  if (options.nonNegative && value < 0n) {
    return {
      ok: false,
      error: `${label} must be non-negative`,
      code: invalidCode,
    };
  }

  return { ok: true, value };
}
