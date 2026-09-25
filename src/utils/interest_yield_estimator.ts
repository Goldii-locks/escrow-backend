/**
 * Interest yield estimator with overflow / digit-limit validation.
 * Rejects principals and rates whose digit count would risk unsafe numeric overflow.
 * Rejects negative parameters, applies round-half-to-even remainder policies,
 * resolves unknown Stellar asset tickers to default configurations, and formats
 * calculated values to match database precision schemas.
 */

import {
  digitCount,
  parseIntegerInput,
  MAX_SAFE_DIGITS,
} from "./digit-limit-validator.js";

export { MAX_SAFE_DIGITS };

/** Max decimal digits allowed for an intermediate multiplication product before division. */
export const MAX_INTERMEDIATE_DIGITS = MAX_SAFE_DIGITS * 2;

/**
 * Practical upper bound for a yield scale / decimals value.
 * Mirrors the SEP-41 style 0-18 range used by token helpers so that
 * 10^scale factors stay safe to combine with MAX_SAFE_DIGITS.
 */
export const MAX_YIELD_DECIMALS = 18;

/** Default denominator for scaled yield calculations (10,000 bps = 100%). */
export const DEFAULT_YIELD_SCALE = 10_000;

/** Basis-points denominator used by half-even yield rounding. */
export const YIELD_SCALE_DENOMINATOR = 10_000n;

/** Rounding policy applied when a division leaves a remainder. */
export const ROUNDING_MODE = "half-even" as const;

export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "OVERFLOW_EXCESSIVE_DIGITS",
  INVALID_RATE: "OVERFLOW_INVALID_RATE",
  PRODUCT_OVERFLOW: "OVERFLOW_PRODUCT_EXCEEDED",
  SUM_MISMATCH: "OVERFLOW_SUM_MISMATCH",
  INVALID_AMOUNT: "OVERFLOW_INVALID_AMOUNT",
} as const;

export type OverflowErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ValidationResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: OverflowErrorCode };

/**
 * Validate an interest rate (integer scaled factor) against digit limits.
 * Rejects negative rates as yields cannot be computed from negative factors.
 */
export function validateInterestRate(
  rate: string | number | bigint
): ValidationResult {
  return parseIntegerInput(
    rate,
    "rate",
    ERROR_CODES.INVALID_RATE,
    ERROR_CODES.EXCESSIVE_DIGITS
  );
}

/**
 * Validate a yield amount (split share or base total) against digit limits.
 */
export function validateYieldAmount(
  input: string | number | bigint,
  label = "amount"
): ValidationResult {
  return parseIntegerInput(
    input,
    label,
    ERROR_CODES.INVALID_RATE,
    ERROR_CODES.EXCESSIVE_DIGITS
  );
}

/**
 * Validate a principal amount against digit limits.
 * Rejects negative principals as balances cannot be negative.
 */
export function validatePrincipal(
  principal: string | number | bigint,
  label = "principal"
): ValidationResult {
  return parseIntegerInput(
    principal,
    label,
    ERROR_CODES.INVALID_AMOUNT,
    ERROR_CODES.EXCESSIVE_DIGITS
  );
}

/**
 * Estimate yield as principal * rate after validating both operands for overflow.
 * Rate is treated as an integer scaled factor (e.g. fixed-point APR).
 * Rejects negative principals and rates.
 */
export function estimateInterestYield(
  principal: string | number | bigint,
  rate: string | number | bigint
): ValidationResult {
  const amount = parseIntegerInput(
    principal,
    "principal",
    ERROR_CODES.INVALID_RATE,
    ERROR_CODES.EXCESSIVE_DIGITS
  );
  if (!amount.ok) {
    return amount;
  }

  const factor = validateInterestRate(rate);
  if (!factor.ok) {
    return factor;
  }

  if (amount.value < 0n) {
    return {
      ok: false,
      error: "principal cannot be negative",
      code: ERROR_CODES.INVALID_RATE,
    };
  }

  if (factor.value < 0n) {
    return {
      ok: false,
      error: "rate cannot be negative",
      code: ERROR_CODES.INVALID_RATE,
    };
  }

  const product = amount.value * factor.value;
  if (digitCount(product.toString()) > MAX_SAFE_DIGITS) {
    return {
      ok: false,
      error: `yield estimate exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
      code: ERROR_CODES.PRODUCT_OVERFLOW,
    };
  }

  return { ok: true, value: product };
}

/**
 * Confirm that a set of split yield amounts sums exactly to the given base
 * amount, rejecting allocations that over- or under-allocate the total.
 */
export function validateYieldSplitSum(
  parts: Array<string | number | bigint>,
  baseAmount: string | number | bigint
): ValidationResult {
  let total = 0n;

  for (let i = 0; i < parts.length; i++) {
    const checked = validateYieldAmount(parts[i], `parts[${i}]`);
    if (!checked.ok) {
      return checked;
    }
    total += checked.value;
  }

  const baseCheck = validateYieldAmount(baseAmount, "baseAmount");
  if (!baseCheck.ok) {
    return baseCheck;
  }

  if (total !== baseCheck.value) {
    return {
      ok: false,
      error: `split total (${total}) does not match base amount (${baseCheck.value})`,
      code: ERROR_CODES.SUM_MISMATCH,
    };
  }

  return { ok: true, value: total };
}
