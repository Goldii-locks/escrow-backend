/**
 * Dispute refund percentage splitter with overflow and parameter validation.
 * Ratios are basis points from 0 to 10,000 and fractional results use half-even rounding.
 */

import {
  digitCount,
  parseIntegerInput,
  MAX_SAFE_DIGITS,
} from "./digit-limit-validator.js";

export { MAX_SAFE_DIGITS };

export const MAX_INTERMEDIATE_DIGITS = MAX_SAFE_DIGITS * 2;
export const DEFAULT_REFUND_SCALE = 10_000;

export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "OVERFLOW_EXCESSIVE_DIGITS",
  INVALID_RATIO: "OVERFLOW_INVALID_RATIO",
  INVALID_AMOUNT: "OVERFLOW_INVALID_AMOUNT",
  PRODUCT_OVERFLOW: "OVERFLOW_PRODUCT_EXCEEDED",
  MISSING_PARAMETER: "MISSING_PARAMETER",
  INVALID_PARAMETER_TYPE: "INVALID_PARAMETER_TYPE",
  CALCULATION_EXCEPTION: "CALCULATION_EXCEPTION",
  PARAM_STRUCTURE_MISMATCH: "PARAM_STRUCTURE_MISMATCH",
} as const;

export type OverflowErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ValidationResult =
  | { ok: true; value: bigint }
  | {
      ok: false;
      error: string;
      code: OverflowErrorCode;
      parameters: { parameter: string; reason: string };
      details?: { context: unknown; reason: string };
    };

export const ERROR_DEFINITIONS = Object.values(ERROR_CODES).map((code) => ({
  code,
  parameters: [
    { name: "parameter", type: "string" as const, required: true },
    { name: "reason", type: "string" as const, required: true },
  ],
}));

function failure(
  error: string,
  code: OverflowErrorCode,
  parameter: string,
  details?: { context: unknown; reason: string }
): ValidationResult {
  return {
    ok: false,
    error,
    code,
    parameters: { parameter, reason: error },
    ...(details ? { details } : {}),
  };
}

function calculationFailure(
  operation: string,
  context: unknown,
  cause: unknown
): ValidationResult {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return failure(
    `Calculation exception during ${operation}: ${reason}`,
    ERROR_CODES.CALCULATION_EXCEPTION,
    operation,
    { context, reason }
  );
}

/**
 * Validate a refund ratio (integer basis points / scaled percent) against digit limits.
 */
export function validateRefundRatio(
  ratio: unknown
): ValidationResult {
  const parsed = parseIntegerInput(
    ratio,
    "ratio",
    ERROR_CODES.INVALID_RATIO,
    ERROR_CODES.EXCESSIVE_DIGITS,
    {
      nonNegative: true,
      missingCode: ERROR_CODES.MISSING_PARAMETER,
      invalidTypeCode: ERROR_CODES.INVALID_PARAMETER_TYPE,
    }
  );
  if (!parsed.ok) {
    return failure(parsed.error, parsed.code, "ratio");
  }
  if (parsed.value > BigInt(DEFAULT_REFUND_SCALE)) {
    const error = `ratio must be between 0 and ${DEFAULT_REFUND_SCALE}`;
    return failure(error, ERROR_CODES.INVALID_RATIO, "ratio");
  }
  return parsed;
}

/** Validate a non-negative refund amount against the shared digit limit. */
export function validateRefundAmount(amount: unknown): ValidationResult {
  const parsed = parseIntegerInput(
    amount,
    "amount",
    ERROR_CODES.INVALID_AMOUNT,
    ERROR_CODES.EXCESSIVE_DIGITS,
    {
      nonNegative: true,
      missingCode: ERROR_CODES.MISSING_PARAMETER,
      invalidTypeCode: ERROR_CODES.INVALID_PARAMETER_TYPE,
    }
  );
  return parsed.ok ? parsed : failure(parsed.error, parsed.code, "amount");
}

/**
 * Split a dispute amount by basis-point ratio, rounding the result half-even.
 * The ratio is scaled by 10,000, so 2,500 represents a 25% refund.
 */
export function applyRefundRatio(
  amount: unknown,
  ratio: unknown
): ValidationResult {
  const principal = validateRefundAmount(amount);
  if (!principal.ok) {
    return principal;
  }

  const factor = validateRefundRatio(ratio);
  if (!factor.ok) {
    return factor;
  }

  try {
    const numerator = principal.value * factor.value;
    if (digitCount(numerator.toString()) > MAX_INTERMEDIATE_DIGITS) {
      return failure(
        `refund calculation exceeds maximum of ${MAX_INTERMEDIATE_DIGITS} intermediate digits`,
        ERROR_CODES.PRODUCT_OVERFLOW,
        "product"
      );
    }

    const scale = BigInt(DEFAULT_REFUND_SCALE);
    const quotient = numerator / scale;
    const remainder = numerator % scale;
    const twiceRemainder = remainder * 2n;
    const refund =
      twiceRemainder > scale ||
      (twiceRemainder === scale && quotient % 2n !== 0n)
        ? quotient + 1n
        : quotient;

    if (digitCount(refund.toString()) > MAX_SAFE_DIGITS) {
      return failure(
        `refund share exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
        ERROR_CODES.PRODUCT_OVERFLOW,
        "refund"
      );
    }

    return { ok: true, value: refund };
  } catch (error) {
    return calculationFailure("applyRefundRatio", { amount, ratio }, error);
  }
}
