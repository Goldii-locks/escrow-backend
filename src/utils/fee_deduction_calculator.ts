/**
 * Fee deduction calculator and fee share calculation checker with
 * overflow / digit-limit validation.
 *
 * Rejects inputs whose digit count or intermediate calculation products
 * would risk unsafe numeric overflow during multiplication and division.
 */

/** Max decimal digits allowed for a single amount/variable (below Number.MAX_SAFE_INTEGER). */
export const MAX_SAFE_DIGITS = 15;

/** Max decimal digits allowed for an intermediate multiplication product before it is divided. */
export const MAX_INTERMEDIATE_DIGITS = MAX_SAFE_DIGITS * 2;

/** Default basis points scale (10,000 bps = 100%, 100 bps = 1%). */
export const DEFAULT_FEE_SCALE = 10_000;

/** Scaling factor used to convert floating-point share weights into integer numerators. */
const SHARE_SCALE = 1_000_000;

export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "FEE_CALCULATOR_EXCESSIVE_DIGITS",
  INVALID_AMOUNT: "FEE_CALCULATOR_INVALID_AMOUNT",
  INVALID_FEE_RATE: "FEE_CALCULATOR_INVALID_FEE_RATE",
  INVALID_SHARES: "FEE_CALCULATOR_INVALID_SHARES",
  CALCULATION_OVERFLOW: "FEE_CALCULATOR_OVERFLOW",
  FEE_EXCEEDS_AMOUNT: "FEE_CALCULATOR_FEE_EXCEEDS_AMOUNT",
  // Compatibility aliases
  OVERFLOW_EXCESSIVE_DIGITS: "OVERFLOW_EXCESSIVE_DIGITS",
  OVERFLOW_INVALID_AMOUNT: "OVERFLOW_INVALID_AMOUNT",
  PRODUCT_OVERFLOW: "OVERFLOW_PRODUCT_EXCEEDED",
} as const;

export type FeeCalculatorErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ValidationResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: FeeCalculatorErrorCode };

export type FeeDeductionOutcome =
  | {
      ok: true;
      grossAmount: bigint;
      feeAmount: bigint;
      netAmount: bigint;
      remainder: bigint;
    }
  | { ok: false; error: string; code: FeeCalculatorErrorCode };

export type FeeShareOutcome =
  | {
      ok: true;
      feeShares: bigint[];
      remainder: bigint;
      totalFee: bigint;
    }
  | { ok: false; error: string; code: FeeCalculatorErrorCode };

export type FeeShareDeductionOutcome =
  | {
      ok: true;
      grossAmount: bigint;
      feeShares: bigint[];
      totalFee: bigint;
      netAmount: bigint;
      remainder: bigint;
    }
  | { ok: false; error: string; code: FeeCalculatorErrorCode };

export type FeeShareCheckOutcome =
  | {
      ok: true;
      grossAmount: bigint;
      totalFee: bigint;
      netAmount: bigint;
      isValid: boolean;
    }
  | { ok: false; error: string; code: FeeCalculatorErrorCode };

function digitCount(normalized: string): number {
  const digits = normalized.replace(/^-/, "").replace(/^0+(?=\d)/, "");
  return digits.length === 0 ? 1 : digits.length;
}

/**
 * Parse and validate an amount string/number/bigint against digit limits.
 */
export function validateAmount(
  input: string | number | bigint,
  label = "amount"
): ValidationResult {
  let raw: string;

  if (typeof input === "bigint") {
    raw = input.toString();
  } else if (typeof input === "number") {
    if (!Number.isFinite(input) || !Number.isInteger(input)) {
      return {
        ok: false,
        error: `${label} must be a finite integer`,
        code: ERROR_CODES.INVALID_AMOUNT,
      };
    }
    raw = String(input);
  } else {
    raw = input.trim();
    if (!/^-?\d+$/.test(raw)) {
      return {
        ok: false,
        error: `${label} must be an integer numeric value`,
        code: ERROR_CODES.INVALID_AMOUNT,
      };
    }
  }

  if (digitCount(raw) > MAX_SAFE_DIGITS) {
    return {
      ok: false,
      error: `${label} exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
      code: ERROR_CODES.EXCESSIVE_DIGITS,
    };
  }

  return { ok: true, value: BigInt(raw) };
}

/**
 * Validate a fee amount input against digit limits.
 */
export function validateFeeAmount(
  input: string | number | bigint,
  label = "feeAmount"
): ValidationResult {
  return validateAmount(input, label);
}

/**
 * Validate a fee rate (e.g. basis points or scaled percent) against digit limits.
 */
export function validateFeeRate(
  input: string | number | bigint,
  label = "feeRate"
): ValidationResult {
  let raw: string;

  if (typeof input === "bigint") {
    raw = input.toString();
  } else if (typeof input === "number") {
    if (!Number.isFinite(input) || !Number.isInteger(input)) {
      return {
        ok: false,
        error: `${label} must be a finite integer`,
        code: ERROR_CODES.INVALID_FEE_RATE,
      };
    }
    raw = String(input);
  } else {
    raw = input.trim();
    if (!/^-?\d+$/.test(raw)) {
      return {
        ok: false,
        error: `${label} must be an integer numeric value`,
        code: ERROR_CODES.INVALID_FEE_RATE,
      };
    }
  }

  if (digitCount(raw) > MAX_SAFE_DIGITS) {
    return {
      ok: false,
      error: `${label} exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
      code: ERROR_CODES.EXCESSIVE_DIGITS,
    };
  }

  const val = BigInt(raw);
  if (val < 0n) {
    return {
      ok: false,
      error: `${label} must be non-negative`,
      code: ERROR_CODES.INVALID_FEE_RATE,
    };
  }

  return { ok: true, value: val };
}

/**
 * Validate the shares array used to weight fee distributions. Every share
 * must be a positive, finite number.
 */
export function validateFeeShares(
  shares: number[]
): { ok: true } | { ok: false; error: string; code: FeeCalculatorErrorCode } {
  if (!Array.isArray(shares) || shares.length === 0) {
    return {
      ok: false,
      error: "shares must be a non-empty array",
      code: ERROR_CODES.INVALID_SHARES,
    };
  }

  for (let i = 0; i < shares.length; i++) {
    const share = shares[i];
    if (
      typeof share !== "number" ||
      !Number.isFinite(share) ||
      share <= 0
    ) {
      return {
        ok: false,
        error: `shares[${i}] must be a positive finite number`,
        code: ERROR_CODES.INVALID_SHARES,
      };
    }
  }

  return { ok: true };
}

/**
 * Calculate fee deduction from gross amount using a fee rate and scaling basis.
 * Blocks intermediate multiplications that would exceed MAX_INTERMEDIATE_DIGITS.
 */
export function calculateFeeDeduction(
  grossAmount: string | number | bigint,
  feeRate: string | number | bigint,
  scale: string | number | bigint = DEFAULT_FEE_SCALE
): FeeDeductionOutcome {
  const grossCheck = validateAmount(grossAmount, "grossAmount");
  if (!grossCheck.ok) {
    return grossCheck;
  }

  const rateCheck = validateFeeRate(feeRate, "feeRate");
  if (!rateCheck.ok) {
    return rateCheck;
  }

  const scaleCheck = validateAmount(scale, "scale");
  if (!scaleCheck.ok) {
    return scaleCheck;
  }
  if (scaleCheck.value <= 0n) {
    return {
      ok: false,
      error: "scale must be a positive integer",
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  const gross = grossCheck.value;
  const rate = rateCheck.value;
  const sc = scaleCheck.value;

  if (gross < 0n) {
    return {
      ok: false,
      error: "grossAmount must be non-negative",
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  const product = gross * rate;
  if (digitCount(product.toString()) > MAX_INTERMEDIATE_DIGITS) {
    return {
      ok: false,
      error: "fee calculation would overflow during multiplication",
      code: ERROR_CODES.CALCULATION_OVERFLOW,
    };
  }

  const feeAmount = product / sc;
  if (feeAmount > gross) {
    return {
      ok: false,
      error: "fee exceeds gross amount",
      code: ERROR_CODES.FEE_EXCEEDS_AMOUNT,
    };
  }

  const netAmount = gross - feeAmount;
  const remainder = product % sc;

  return {
    ok: true,
    grossAmount: gross,
    feeAmount,
    netAmount,
    remainder,
  };
}

/**
 * Split a total fee amount across multiple fee shares (weights),
 * using scaled integer arithmetic with overflow validation and remainder tracking.
 */
export function calculateFeeShares(
  totalFee: string | number | bigint,
  shares: number[]
): FeeShareOutcome {
  const totalCheck = validateAmount(totalFee, "totalFee");
  if (!totalCheck.ok) {
    return totalCheck;
  }

  const sharesCheck = validateFeeShares(shares);
  if (!sharesCheck.ok) {
    return sharesCheck;
  }

  const total = totalCheck.value;
  if (total < 0n) {
    return {
      ok: false,
      error: "totalFee must be non-negative",
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  const scaledNumerators = shares.map((s) => BigInt(Math.round(s * SHARE_SCALE)));
  const scaledDenominator = scaledNumerators.reduce((acc, n) => acc + n, 0n);

  if (scaledDenominator <= 0n) {
    return {
      ok: false,
      error: "shares must sum to a positive value",
      code: ERROR_CODES.INVALID_SHARES,
    };
  }

  const feeShares: bigint[] = [];
  let allocatedSum = 0n;

  for (let i = 0; i < scaledNumerators.length; i++) {
    const numerator = scaledNumerators[i];
    const product = total * numerator;

    if (digitCount(product.toString()) > MAX_INTERMEDIATE_DIGITS) {
      return {
        ok: false,
        error: `fee share calculation for shares[${i}] would overflow during multiplication`,
        code: ERROR_CODES.CALCULATION_OVERFLOW,
      };
    }

    const shareAmount = product / scaledDenominator;
    feeShares.push(shareAmount);
    allocatedSum += shareAmount;
  }

  const remainder = total - allocatedSum;

  return {
    ok: true,
    feeShares,
    remainder,
    totalFee: total,
  };
}

/**
 * Calculate individual fee shares and deduce them from gross amount,
 * checking that total deducted fees do not overflow or exceed gross amount.
 */
export function calculateFeeShareDeductions(
  grossAmount: string | number | bigint,
  shares: number[]
): FeeShareDeductionOutcome {
  const grossCheck = validateAmount(grossAmount, "grossAmount");
  if (!grossCheck.ok) {
    return grossCheck;
  }

  const sharesCheck = validateFeeShares(shares);
  if (!sharesCheck.ok) {
    return sharesCheck;
  }

  const gross = grossCheck.value;
  if (gross < 0n) {
    return {
      ok: false,
      error: "grossAmount must be non-negative",
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  const scaledNumerators = shares.map((s) => BigInt(Math.round(s * SHARE_SCALE)));
  const scaledDenominator = scaledNumerators.reduce((acc, n) => acc + n, 0n);

  if (scaledDenominator <= 0n) {
    return {
      ok: false,
      error: "shares must sum to a positive value",
      code: ERROR_CODES.INVALID_SHARES,
    };
  }

  const feeShares: bigint[] = [];
  let totalFee = 0n;

  for (let i = 0; i < scaledNumerators.length; i++) {
    const numerator = scaledNumerators[i];
    const product = gross * numerator;

    if (digitCount(product.toString()) > MAX_INTERMEDIATE_DIGITS) {
      return {
        ok: false,
        error: `fee share deduction for shares[${i}] would overflow during multiplication`,
        code: ERROR_CODES.CALCULATION_OVERFLOW,
      };
    }

    const shareAmount = product / scaledDenominator;
    feeShares.push(shareAmount);
    totalFee += shareAmount;
  }

  if (totalFee > gross) {
    return {
      ok: false,
      error: "total fee deductions exceed gross amount",
      code: ERROR_CODES.FEE_EXCEEDS_AMOUNT,
    };
  }

  const remainder = 0n;
  const netAmount = gross - totalFee;

  return {
    ok: true,
    grossAmount: gross,
    feeShares,
    totalFee,
    netAmount,
    remainder,
  };
}

/**
 * Fee share calculation checker:
 * Validates individual fee shares, checks running sum for overflow against
 * MAX_SAFE_DIGITS, ensures total fee does not exceed gross amount,
 * and verifies expected total fee if provided.
 */
export function checkFeeShareCalculation(
  grossAmount: string | number | bigint,
  feeShares: Array<string | number | bigint>,
  expectedTotalFee?: string | number | bigint
): FeeShareCheckOutcome {
  const grossCheck = validateAmount(grossAmount, "grossAmount");
  if (!grossCheck.ok) {
    return grossCheck;
  }

  let totalFee = 0n;

  for (let i = 0; i < feeShares.length; i++) {
    const shareCheck = validateAmount(feeShares[i], `feeShares[${i}]`);
    if (!shareCheck.ok) {
      return shareCheck;
    }

    const next = totalFee + shareCheck.value;
    if (digitCount(next.toString()) > MAX_SAFE_DIGITS) {
      return {
        ok: false,
        error: `total fee sum exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
        code: ERROR_CODES.CALCULATION_OVERFLOW,
      };
    }
    totalFee = next;
  }

  const gross = grossCheck.value;
  if (totalFee > gross) {
    return {
      ok: false,
      error: "total fee shares exceed gross amount",
      code: ERROR_CODES.FEE_EXCEEDS_AMOUNT,
    };
  }

  let isValid = true;
  if (expectedTotalFee !== undefined) {
    const expectedCheck = validateAmount(expectedTotalFee, "expectedTotalFee");
    if (!expectedCheck.ok) {
      return expectedCheck;
    }
    isValid = totalFee === expectedCheck.value;
  }

  const netAmount = gross - totalFee;

  return {
    ok: true,
    grossAmount: gross,
    totalFee,
    netAmount,
    isValid,
  };
}

// ---------------------------------------------------------------------------
// Round-half-to-even fee deduction (#430)
// ---------------------------------------------------------------------------
//
// calculateFeeDeduction() above truncates the fractional part and hands the
// caller the leftover in `remainder`, which suits callers that distribute the
// dust themselves. The variant below instead folds the fraction into the fee
// using banker's rounding, so `feeAmount + netAmount` always reconstructs the
// base amount exactly and repeated application of the same rate does not bias
// the total consistently up or down.

/** Basis-points denominator (10000 bps = 100%). */
const BPS_DENOMINATOR = 10_000n;

export type FeeDeductionHalfEvenOutcome =
  | { ok: true; feeAmount: bigint; netAmount: bigint }
  | { ok: false; error: string; code: FeeCalculatorErrorCode };

/**
 * Parse and validate a non-negative base amount against digit limits.
 */
export function validateBaseAmount(
  input: string | number | bigint,
  label = "baseAmount"
): ValidationResult {
  let raw: string;

  if (typeof input === "bigint") {
    raw = input.toString();
  } else if (typeof input === "number") {
    if (!Number.isFinite(input) || !Number.isInteger(input)) {
      return {
        ok: false,
        error: `${label} must be a finite integer`,
        code: ERROR_CODES.INVALID_AMOUNT,
      };
    }
    raw = String(input);
  } else {
    if (typeof input !== "string") {
      return {
        ok: false,
        error: `${label} must be a string, number, or bigint`,
        code: ERROR_CODES.INVALID_AMOUNT,
      };
    }
    raw = input.trim();
    if (!/^\d+$/.test(raw)) {
      return {
        ok: false,
        error: `${label} must be a non-negative integer numeric value`,
        code: ERROR_CODES.INVALID_AMOUNT,
      };
    }
  }

  if (digitCount(raw) > MAX_SAFE_DIGITS) {
    return {
      ok: false,
      error: `${label} exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
      code: ERROR_CODES.EXCESSIVE_DIGITS,
    };
  }

  const value = BigInt(raw);
  if (value < 0n) {
    return {
      ok: false,
      error: `${label} must be a non-negative integer`,
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  return { ok: true, value };
}

/**
 * Validate a fee rate expressed in basis points (0-10000, i.e. 0%-100%).
 */
export function validateFeeRateBps(feeRateBps: number): ValidationResult {
  if (
    typeof feeRateBps !== "number" ||
    !Number.isFinite(feeRateBps) ||
    !Number.isInteger(feeRateBps)
  ) {
    return {
      ok: false,
      error: "feeRateBps must be a finite integer",
      code: ERROR_CODES.INVALID_FEE_RATE,
    };
  }

  if (feeRateBps < 0 || feeRateBps > 10_000) {
    return {
      ok: false,
      error: "feeRateBps must be between 0 and 10000",
      code: ERROR_CODES.INVALID_FEE_RATE,
    };
  }

  return { ok: true, value: BigInt(feeRateBps) };
}

/**
 * Deduct a fee (in basis points) from a base amount, rounding the fractional
 * remainder to the nearest even value instead of always truncating or always
 * rounding up. This avoids a one-directional rounding bias when the same
 * rate is applied repeatedly across many transactions, while feeAmount and
 * netAmount always sum back to baseAmount exactly.
 */
export function calculateFeeDeductionHalfEven(
  baseAmount: string | number | bigint,
  feeRateBps: number
): FeeDeductionHalfEvenOutcome {
  const base = validateBaseAmount(baseAmount);
  if (!base.ok) {
    return base;
  }

  const rate = validateFeeRateBps(feeRateBps);
  if (!rate.ok) {
    return rate;
  }

  const numerator = base.value * rate.value;
  const quotient = numerator / BPS_DENOMINATOR;
  const remainder = numerator % BPS_DENOMINATOR;

  let feeAmount = quotient;
  const twiceRemainder = remainder * 2n;
  if (twiceRemainder > BPS_DENOMINATOR) {
    feeAmount += 1n;
  } else if (twiceRemainder === BPS_DENOMINATOR && quotient % 2n !== 0n) {
    feeAmount += 1n;
  }

  const netAmount = base.value - feeAmount;

  return { ok: true, feeAmount, netAmount };
}
