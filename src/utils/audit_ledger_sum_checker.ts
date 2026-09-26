/**
 * Ledger transaction sum checker with overflow / digit-limit validation
 * and consistent decimal rounding policies.
 * Rejects inputs whose digit count would risk unsafe numeric overflow.
 */

import {
  digitCount,
  parseIntegerInput,
  MAX_SAFE_DIGITS,
} from "./digit-limit-validator.js";

export { MAX_SAFE_DIGITS };

export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "OVERFLOW_EXCESSIVE_DIGITS",
  INVALID_AMOUNT: "OVERFLOW_INVALID_AMOUNT",
  SUM_OVERFLOW: "OVERFLOW_SUM_EXCEEDED",
  ROUNDING_INVALID_INPUT: "ROUNDING_INVALID_INPUT",
  ROUNDING_SCALE_INVALID: "ROUNDING_SCALE_INVALID",
  SUM_MISMATCH: "OVERFLOW_SUM_MISMATCH",
} as const;

export type OverflowErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ValidationResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: OverflowErrorCode };

/**
 * Parse and validate a ledger amount string/number against digit limits.
 */
export function validateLedgerAmount(
  input: string | number | bigint,
  label = "amount"
): ValidationResult {
  return parseIntegerInput(
    input,
    label,
    ERROR_CODES.INVALID_AMOUNT,
    ERROR_CODES.EXCESSIVE_DIGITS
  );
}

/**
 * Sum ledger entry amounts after validating each against overflow digit limits.
 */
export function sumLedgerAmounts(
  amounts: Array<string | number | bigint>
): ValidationResult {
  let total = 0n;

  for (let i = 0; i < amounts.length; i++) {
    const checked = validateLedgerAmount(amounts[i], `amounts[${i}]`);
    if (!checked.ok) {
      return checked;
    }

    const next = total + checked.value;
    if (digitCount(next.toString()) > MAX_SAFE_DIGITS) {
      return {
        ok: false,
        error: `ledger sum exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
        code: ERROR_CODES.SUM_OVERFLOW,
      };
    }
    total = next;
  }

  return { ok: true, value: total };
}

// ---------------------------------------------------------------------------
// Split-sum assertions (issue #501)
// ---------------------------------------------------------------------------

export type SplitSumResult =
  | { ok: true; total: bigint; isMatch: boolean }
  | { ok: false; error: string; code: OverflowErrorCode };

/**
 * Assert that a set of split amounts adds up to an expected base amount.
 *
 * Every split and the base are validated against the digit limit before any
 * arithmetic, so the function never operates on unsafe integers. The running
 * total is guarded against digit-limit overflow on each addition.
 *
 * When `strict` is true (the default) a total that does not equal the base
 * is returned as `{ ok: true, isMatch: false }` so the caller can decide how
 * to handle the mismatch; pass `strict: "reject"` to receive a hard
 * `SUM_MISMATCH` failure instead.
 */
export function assertLedgerSplitSum(
  splits: Array<string | number | bigint>,
  expectedBase: string | number | bigint,
  strict: "mismatch" | "reject" = "mismatch"
): SplitSumResult {
  if (!Array.isArray(splits) || splits.length === 0) {
    return {
      ok: false,
      error: "splits must be a non-empty array",
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  const baseCheck = validateLedgerAmount(expectedBase, "expectedBase");
  if (!baseCheck.ok) {
    return baseCheck;
  }

  let total = 0n;
  for (let i = 0; i < splits.length; i++) {
    const splitCheck = validateLedgerAmount(splits[i], `splits[${i}]`);
    if (!splitCheck.ok) {
      return splitCheck;
    }
    const next = total + splitCheck.value;
    if (digitCount(next.toString()) > MAX_SAFE_DIGITS) {
      return {
        ok: false,
        error: `split total exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
        code: ERROR_CODES.SUM_OVERFLOW,
      };
    }
    total = next;
  }

  if (total !== baseCheck.value) {
    if (strict === "reject") {
      return {
        ok: false,
        error: `split total (${total}) does not match base amount (${baseCheck.value})`,
        code: ERROR_CODES.SUM_MISMATCH,
      };
    }
    return { ok: true, total, isMatch: false };
  }

  return { ok: true, total, isMatch: true };
}

// ---------------------------------------------------------------------------
// TASK 4 – Decimal rounding policies
// ---------------------------------------------------------------------------

export type RoundingErrorCode =
  | typeof ERROR_CODES.ROUNDING_INVALID_INPUT
  | typeof ERROR_CODES.ROUNDING_SCALE_INVALID
  | typeof ERROR_CODES.EXCESSIVE_DIGITS
  | typeof ERROR_CODES.INVALID_AMOUNT;

export type RoundingResult =
  | { ok: true; value: bigint; remainder: bigint }
  | { ok: false; error: string; code: RoundingErrorCode };

/**
 * Round a numerator/denominator division to the nearest even integer
 * (banker's rounding / round-half-to-even).
 *
 * Both `numerator` and `denominator` must be non-negative bigints; a positive
 * `denominator` is enforced. The `remainder` in the success result is the
 * fractional part *before* rounding expressed as a bigint so the caller can
 * reconstruct the exact value:
 *   numerator === value * denominator + pre_round_remainder
 *
 * This is consistent with the round-half-to-even used in
 * `fee_deduction_calculator.calculateFeeDeductionHalfEven`.
 */
export function roundHalfEven(
  numerator: bigint,
  denominator: bigint
): RoundingResult {
  if (typeof numerator !== "bigint" || typeof denominator !== "bigint") {
    return {
      ok: false,
      error: "numerator and denominator must be bigint values",
      code: ERROR_CODES.ROUNDING_INVALID_INPUT,
    };
  }

  if (numerator < 0n) {
    return {
      ok: false,
      error: "numerator must be non-negative",
      code: ERROR_CODES.ROUNDING_INVALID_INPUT,
    };
  }

  if (denominator <= 0n) {
    return {
      ok: false,
      error: "denominator must be a positive bigint",
      code: ERROR_CODES.ROUNDING_SCALE_INVALID,
    };
  }

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;

  let rounded = quotient;
  const twiceRemainder = remainder * 2n;

  if (twiceRemainder > denominator) {
    // Fractional part > 0.5 → round up
    rounded += 1n;
  } else if (twiceRemainder === denominator && quotient % 2n !== 0n) {
    // Fractional part exactly 0.5 and quotient is odd → round up to even
    rounded += 1n;
  }
  // Otherwise: fractional part < 0.5, or exactly 0.5 with an even quotient → truncate

  return { ok: true, value: rounded, remainder };
}

/**
 * Divide a ledger amount by a positive integer divisor using round-half-to-even
 * so repeated division does not accumulate a one-directional rounding bias.
 *
 * The `parts` array in the success result contains `divisor` bigint values
 * that sum exactly to `amount` — any rounding dust is added to the first
 * element (index 0) so the invariant `parts.reduce((a, b) => a + b) === amount`
 * always holds. No remainder is ever lost.
 */
export function divideWithRounding(
  amount: string | number | bigint,
  divisor: number
): { ok: true; parts: bigint[] } | { ok: false; error: string; code: RoundingErrorCode } {
  const amountCheck = validateLedgerAmount(amount, "amount");
  if (!amountCheck.ok) {
    return amountCheck as { ok: false; error: string; code: RoundingErrorCode };
  }

  if (
    typeof divisor !== "number" ||
    !Number.isFinite(divisor) ||
    !Number.isInteger(divisor) ||
    divisor <= 0
  ) {
    return {
      ok: false,
      error: "divisor must be a positive integer",
      code: ERROR_CODES.ROUNDING_SCALE_INVALID,
    };
  }

  const total = amountCheck.value;
  const denom = BigInt(divisor);

  const base = roundHalfEven(total, denom);
  if (!base.ok) {
    return base as { ok: false; error: string; code: RoundingErrorCode };
  }

  // Each of the `divisor` parts uses the rounded base share.
  // The actual per-part value when using integer division (truncation) is:
  const truncated = total / denom;
  const dustCount = total - truncated * denom; // number of parts that need +1

  const parts: bigint[] = [];
  for (let i = 0; i < divisor; i++) {
    // Distribute the dust to the leading parts.
    parts.push(i < dustCount ? truncated + 1n : truncated);
  }

  return { ok: true, parts };
}

/**
 * Apply round-half-to-even to a ledger amount scaled by a rational factor
 * expressed as `numerator / denominator` (both positive integers).
 *
 * This is the entry-point for applying fee rates or allocation percentages to
 * ledger amounts in a bias-free way. The function validates both operands and
 * the scale before performing any arithmetic.
 */
export function applyRoundedScale(
  amount: string | number | bigint,
  scaleNumerator: string | number | bigint,
  scaleDenominator: string | number | bigint
): RoundingResult {
  const amountCheck = validateLedgerAmount(amount, "amount");
  if (!amountCheck.ok) {
    return amountCheck as RoundingResult;
  }

  const numCheck = validateLedgerAmount(scaleNumerator, "scaleNumerator");
  if (!numCheck.ok) {
    return numCheck as RoundingResult;
  }

  const denomCheck = validateLedgerAmount(scaleDenominator, "scaleDenominator");
  if (!denomCheck.ok) {
    return denomCheck as RoundingResult;
  }

  if (denomCheck.value <= 0n) {
    return {
      ok: false,
      error: "scaleDenominator must be a positive integer",
      code: ERROR_CODES.ROUNDING_SCALE_INVALID,
    };
  }

  const product = amountCheck.value * numCheck.value;

  return roundHalfEven(product, denomCheck.value);
}
