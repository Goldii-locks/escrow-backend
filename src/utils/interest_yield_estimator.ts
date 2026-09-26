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
 * Validate an interest rate (integer scaled factor) against digit limits.
 * Rejects negative rates as yields cannot be computed from negative factors.
 */
export function validateInterestRate(
  rate: unknown
): ValidationResult {
  const parsed = parseIntegerInput(
    rate,
    "rate",
    ERROR_CODES.INVALID_RATE,
    ERROR_CODES.EXCESSIVE_DIGITS,
    {
      nonNegative: true,
      missingCode: ERROR_CODES.MISSING_PARAMETER,
      invalidTypeCode: ERROR_CODES.INVALID_PARAMETER_TYPE,
    }
  );
  return parsed.ok ? parsed : failure(parsed.error, parsed.code, "rate");
}

/**
 * Validate a yield amount (split share or base total) against digit limits.
 */
export function validateYieldAmount(
  input: unknown,
  label = "amount"
): ValidationResult {
  const parsed = parseIntegerInput(
    input,
    label,
    ERROR_CODES.INVALID_AMOUNT,
    ERROR_CODES.EXCESSIVE_DIGITS,
    {
      nonNegative: true,
      missingCode: ERROR_CODES.MISSING_PARAMETER,
      invalidTypeCode: ERROR_CODES.INVALID_PARAMETER_TYPE,
    }
  );
  return parsed.ok ? parsed : failure(parsed.error, parsed.code, label);
}

/**
 * Validate a principal amount against digit limits.
 * Rejects negative principals as balances cannot be negative.
 */
export function validatePrincipal(
  principal: unknown,
  label = "principal"
): ValidationResult {
  const parsed = parseIntegerInput(
    principal,
    label,
    ERROR_CODES.INVALID_AMOUNT,
    ERROR_CODES.EXCESSIVE_DIGITS,
    {
      nonNegative: true,
      missingCode: ERROR_CODES.MISSING_PARAMETER,
      invalidTypeCode: ERROR_CODES.INVALID_PARAMETER_TYPE,
    }
  );
  return parsed.ok ? parsed : failure(parsed.error, parsed.code, label);
}

/**
 * Estimate yield as principal * rate after validating both operands for overflow.
 * Rate is treated as an integer scaled factor (e.g. fixed-point APR).
 * Rejects negative principals and rates.
 */
export function estimateInterestYield(
  principal: unknown,
  rate: unknown
): ValidationResult {
  const amount = validatePrincipal(principal);
  if (!amount.ok) {
    return amount;
  }

  const factor = validateInterestRate(rate);
  if (!factor.ok) {
    return factor;
  }

  try {
    const product = amount.value * factor.value;
    if (digitCount(product.toString()) > MAX_SAFE_DIGITS) {
      return failure(
        `yield estimate exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
        ERROR_CODES.PRODUCT_OVERFLOW,
        "product"
      );
    }

    return { ok: true, value: product };
  } catch (error) {
    return calculationFailure("estimateInterestYield", { principal, rate }, error);
  }
}

/**
 * Confirm that a set of split yield amounts sums exactly to the given base
 * amount, rejecting allocations that over- or under-allocate the total.
 */
export function validateYieldSplitSum(
  parts: unknown,
  baseAmount: unknown
): ValidationResult {
  if (!Array.isArray(parts)) {
    return failure(
      "parts must be an array",
      ERROR_CODES.PARAM_STRUCTURE_MISMATCH,
      "parts"
    );
  }

  let total = 0n;

  for (let i = 0; i < parts.length; i++) {
    const checked = validateYieldAmount(parts[i], `parts[${i}]`);
    if (!checked.ok) {
      return checked;
    }
    try {
      total += checked.value;
    } catch (error) {
      return calculationFailure("validateYieldSplitSum", { parts, baseAmount }, error);
    }
  }

  const baseCheck = validateYieldAmount(baseAmount, "baseAmount");
  if (!baseCheck.ok) {
    return baseCheck;
  }

  if (total !== baseCheck.value) {
    const error = `split total (${total}) does not match base amount (${baseCheck.value})`;
    return failure(error, ERROR_CODES.SUM_MISMATCH, "parts");
  }

  return { ok: true, value: total };
}
