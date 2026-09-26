/**
 * Financial Report Math
 *
 * The arithmetic a financial report relies on: ledger sums, credit/debit nets,
 * fee application, exact percentage splits and decimal rescaling.
 *
 * Every operation works on integer minor units (bigint) and rounds
 * half-to-even, matching `audit_ledger_sum_checker.roundHalfEven`, so repeated
 * reports cannot accumulate a one-directional rounding bias. Each function
 * validates its inputs through the shared digit-limit validator and returns a
 * discriminated result instead of throwing.
 */

import { parseIntegerInput } from "./digit-limit-validator.js";

export const FINANCIAL_REPORT_MATH_ERRORS = {
  INVALID_AMOUNT: "FRM_INVALID_AMOUNT",
  INVALID_RATE: "FRM_INVALID_RATE",
  INVALID_SCALE: "FRM_INVALID_SCALE",
  EMPTY_INPUT: "FRM_EMPTY_INPUT",
  SPLIT_MISMATCH: "FRM_SPLIT_MISMATCH",
} as const;

export type FinancialReportMathErrorCode =
  (typeof FINANCIAL_REPORT_MATH_ERRORS)[keyof typeof FINANCIAL_REPORT_MATH_ERRORS];

export type MathResult<T> =
  | { ok: true } & T
  | { ok: false; error: string; code: FinancialReportMathErrorCode };

/** Basis points in one whole unit (100% === 10_000 bp). */
export const BASIS_POINTS_DIVISOR = 10_000n;

/** Parse a non-negative minor-unit integer, rejecting overflow digit counts. */
export function parseMinorAmount(
  input: string | number | bigint,
  label = "amount"
): MathResult<{ value: bigint }> {
  const parsed = parseIntegerInput(
    input,
    label,
    FINANCIAL_REPORT_MATH_ERRORS.INVALID_AMOUNT,
    FINANCIAL_REPORT_MATH_ERRORS.INVALID_AMOUNT
  );
  if (!parsed.ok) return parsed;

  if (parsed.value < 0n) {
    return {
      ok: false,
      error: `${label} must not be negative`,
      code: FINANCIAL_REPORT_MATH_ERRORS.INVALID_AMOUNT,
    };
  }

  return { ok: true, value: parsed.value };
}

/** Divide with round-half-to-even, for non-negative operands. */
export function divideHalfEven(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twiceRemainder = remainder * 2n;

  if (twiceRemainder > denominator) return quotient + 1n;
  if (twiceRemainder === denominator && quotient % 2n !== 0n) return quotient + 1n;
  return quotient;
}

/** Sum a list of minor-unit amounts, validating every entry first. */
export function sumAmounts(
  amounts: Array<string | number | bigint>
): MathResult<{ value: bigint }> {
  if (!Array.isArray(amounts) || amounts.length === 0) {
    return {
      ok: false,
      error: "amounts must be a non-empty array",
      code: FINANCIAL_REPORT_MATH_ERRORS.EMPTY_INPUT,
    };
  }

  let total = 0n;
  for (let i = 0; i < amounts.length; i += 1) {
    const parsed = parseMinorAmount(amounts[i], `amounts[${i}]`);
    if (!parsed.ok) return parsed;

    total += parsed.value;
    if (total.toString().replace("-", "").length > 15) {
      return {
        ok: false,
        error: `amounts[${i}]: running total exceeds the maximum of 15 digits`,
        code: FINANCIAL_REPORT_MATH_ERRORS.INVALID_AMOUNT,
      };
    }
  }

  return { ok: true, value: total };
}

/** credits - debits, validated so a report can never publish a wrong net. */
export function netAmount(
  credits: string | number | bigint,
  debits: string | number | bigint
): MathResult<{ value: bigint }> {
  const parsedCredits = parseMinorAmount(credits, "credits");
  if (!parsedCredits.ok) return parsedCredits;

  const parsedDebits = parseMinorAmount(debits, "debits");
  if (!parsedDebits.ok) return parsedDebits;

  return { ok: true, value: parsedCredits.value - parsedDebits.value };
}

/**
 * Apply a fee expressed in basis points, returning both the fee and the amount
 * that remains. The fee is rounded half-to-even, and `net` is always
 * `amount - fee` so the two figures reconcile exactly.
 */
export function applyFeeBasisPoints(
  amount: string | number | bigint,
  basisPoints: string | number | bigint
): MathResult<{ fee: bigint; net: bigint }> {
  const parsedAmount = parseMinorAmount(amount, "amount");
  if (!parsedAmount.ok) return parsedAmount;

  const parsedRate = parseMinorAmount(basisPoints, "basisPoints");
  if (!parsedRate.ok) {
    return {
      ok: false,
      error: parsedRate.error,
      code: FINANCIAL_REPORT_MATH_ERRORS.INVALID_RATE,
    };
  }

  if (parsedRate.value > BASIS_POINTS_DIVISOR) {
    return {
      ok: false,
      error: "basisPoints must not exceed 10000 (100%)",
      code: FINANCIAL_REPORT_MATH_ERRORS.INVALID_RATE,
    };
  }

  const fee = divideHalfEven(parsedAmount.value * parsedRate.value, BASIS_POINTS_DIVISOR);
  return { ok: true, fee, net: parsedAmount.value - fee };
}

/**
 * Split an amount across integer weights so the parts sum exactly back to the
 * original: any rounding dust is handed to the leading parts. No minor unit is
 * ever created or lost.
 */
export function splitByWeights(
  amount: string | number | bigint,
  weights: Array<string | number | bigint>
): MathResult<{ parts: bigint[] }> {
  const parsedAmount = parseMinorAmount(amount, "amount");
  if (!parsedAmount.ok) return parsedAmount;

  if (!Array.isArray(weights) || weights.length === 0) {
    return {
      ok: false,
      error: "weights must be a non-empty array",
      code: FINANCIAL_REPORT_MATH_ERRORS.EMPTY_INPUT,
    };
  }

  let totalWeight = 0n;
  const normalized: bigint[] = [];
  for (let i = 0; i < weights.length; i += 1) {
    const parsed = parseMinorAmount(weights[i], `weights[${i}]`);
    if (!parsed.ok) return parsed;
    normalized.push(parsed.value);
    totalWeight += parsed.value;
  }

  if (totalWeight === 0n) {
    return {
      ok: false,
      error: "weights must not all be zero",
      code: FINANCIAL_REPORT_MATH_ERRORS.INVALID_SCALE,
    };
  }

  const parts: bigint[] = [];
  let assigned = 0n;
  for (const weight of normalized) {
    const part = (parsedAmount.value * weight) / totalWeight;
    parts.push(part);
    assigned += part;
  }

  // Hand the remaining minor units to the leading parts, one each.
  let dust = parsedAmount.value - assigned;
  for (let i = 0; dust > 0n; i = (i + 1) % parts.length) {
    parts[i] += 1n;
    dust -= 1n;
  }

  if (parts.reduce((total, part) => total + part, 0n) !== parsedAmount.value) {
    return {
      ok: false,
      error: "split parts do not reconcile with the original amount",
      code: FINANCIAL_REPORT_MATH_ERRORS.SPLIT_MISMATCH,
    };
  }

  return { ok: true, parts };
}

/**
 * Rescale a minor-unit amount between decimal precisions, rounding
 * half-to-even when precision is lost (e.g. stroops -> cents).
 */
export function convertMinorDecimals(
  amount: string | number | bigint,
  fromDecimals: number,
  toDecimals: number
): MathResult<{ value: bigint }> {
  const parsed = parseMinorAmount(amount, "amount");
  if (!parsed.ok) return parsed;

  const valid = (decimals: number): boolean =>
    Number.isInteger(decimals) && decimals >= 0 && decimals <= 18;

  if (!valid(fromDecimals) || !valid(toDecimals)) {
    return {
      ok: false,
      error: "decimals must be integers between 0 and 18",
      code: FINANCIAL_REPORT_MATH_ERRORS.INVALID_SCALE,
    };
  }

  if (fromDecimals === toDecimals) return { ok: true, value: parsed.value };

  if (toDecimals > fromDecimals) {
    return { ok: true, value: parsed.value * 10n ** BigInt(toDecimals - fromDecimals) };
  }

  return {
    ok: true,
    value: divideHalfEven(parsed.value, 10n ** BigInt(fromDecimals - toDecimals)),
  };
}

/**
 * Recompute a published totals block from its parts and report whether the
 * figures agree. Used to assert an exported report's summary is trustworthy.
 */
export function reconcileTotals(reported: {
  credits: string | number | bigint;
  debits: string | number | bigint;
  net: string | number | bigint;
}): MathResult<{ credits: bigint; debits: bigint; net: bigint; balanced: boolean }> {
  const credits = parseMinorAmount(reported.credits, "credits");
  if (!credits.ok) return credits;

  const debits = parseMinorAmount(reported.debits, "debits");
  if (!debits.ok) return debits;

  const net = parseIntegerInput(
    reported.net,
    "net",
    FINANCIAL_REPORT_MATH_ERRORS.INVALID_AMOUNT,
    FINANCIAL_REPORT_MATH_ERRORS.INVALID_AMOUNT
  );
  if (!net.ok) return net;

  return {
    ok: true,
    credits: credits.value,
    debits: debits.value,
    net: net.value,
    balanced: credits.value - debits.value === net.value,
  };
}
