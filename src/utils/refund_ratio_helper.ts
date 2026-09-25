/**
 * Dispute refund percentage splitter with overflow / digit-limit validation.
 * Rejects amounts and ratios whose digit count would risk unsafe numeric overflow.
 */

import {
  digitCount,
  parseIntegerInput,
  MAX_SAFE_DIGITS,
} from "./digit-limit-validator.js";

export { MAX_SAFE_DIGITS };

export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "OVERFLOW_EXCESSIVE_DIGITS",
  INVALID_RATIO: "OVERFLOW_INVALID_RATIO",
  PRODUCT_OVERFLOW: "OVERFLOW_PRODUCT_EXCEEDED",
} as const;

export type OverflowErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ValidationResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: OverflowErrorCode };

/**
 * Validate a refund ratio (integer basis points / scaled percent) against digit limits.
 */
export function validateRefundRatio(
  ratio: string | number | bigint
): ValidationResult {
  return parseIntegerInput(
    ratio,
    "ratio",
    ERROR_CODES.INVALID_RATIO,
    ERROR_CODES.EXCESSIVE_DIGITS
  );
}

/**
 * Split a dispute amount by refund ratio after validating both operands for overflow.
 * Ratio is treated as an integer scaled factor (e.g. basis points).
 */
export function applyRefundRatio(
  amount: string | number | bigint,
  ratio: string | number | bigint
): ValidationResult {
  const principal = parseIntegerInput(
    amount,
    "amount",
    ERROR_CODES.INVALID_RATIO,
    ERROR_CODES.EXCESSIVE_DIGITS
  );
  if (!principal.ok) {
    return principal;
  }

  const factor = validateRefundRatio(ratio);
  if (!factor.ok) {
    return factor;
  }

  const product = principal.value * factor.value;
  if (digitCount(product.toString()) > MAX_SAFE_DIGITS) {
    return {
      ok: false,
      error: `refund share exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
      code: ERROR_CODES.PRODUCT_OVERFLOW,
    };
  }

  return { ok: true, value: product };
}
