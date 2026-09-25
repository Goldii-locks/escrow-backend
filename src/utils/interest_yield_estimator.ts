/**
 * Interest yield estimator with overflow / digit-limit validation.
 * Rejects principals and rates whose digit count would risk unsafe numeric overflow.
 */

import {
  digitCount,
  parseIntegerInput,
  MAX_SAFE_DIGITS,
} from "./digit-limit-validator.js";

export { MAX_SAFE_DIGITS };

export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "OVERFLOW_EXCESSIVE_DIGITS",
  INVALID_RATE: "OVERFLOW_INVALID_RATE",
  PRODUCT_OVERFLOW: "OVERFLOW_PRODUCT_EXCEEDED",
  SUM_MISMATCH: "OVERFLOW_SUM_MISMATCH",
} as const;

export type OverflowErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ValidationResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: OverflowErrorCode };

/**
 * Validate an interest rate (integer scaled factor) against digit limits.
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
  return parseIntegerInput(input, label, ERROR_CODES.INVALID_RATE);
}

/**
 * Estimate yield as principal * rate after validating both operands for overflow.
 * Rate is treated as an integer scaled factor (e.g. fixed-point APR).
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
