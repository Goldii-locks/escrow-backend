/**
 * Fee Deduction Calculator (canonical module, #629)
 *
 * - Fee deduction / fee share calculations with overflow and digit-limit
 *   validation. Rates are integer basis points (BPS_SCALE = 10_000).
 * - Fee share allocations with total sum assertions, ensuring split
 *   allocations sum to the base amount with no partial or inconsistent state.
 *
 * CSV exporters for fee deduction records live in `csv-serializer.ts`.
 */

import { sumLedgerAmounts, validateLedgerAmount } from "./audit_ledger_sum_checker.js";
import { divRound } from "./rounding.js";
import { isAmountWithinRange } from "./digit-limit-validator.js";

export interface FeeShare {
  recipient: string;
  amount: bigint;
  percentage?: number;
}

export interface FeeAllocation {
  baseAmount: bigint;
  shares: FeeShare[];
  totalDeducted: bigint;
  remaining: bigint;
}

export interface CalculationResult {
  success: boolean;
  allocation?: FeeAllocation;
  error?: string;
  code?: string;
}

export const FEE_CALCULATION_ERRORS = {
  INVALID_BASE_AMOUNT: "FEE_INVALID_BASE_AMOUNT",
  INVALID_SHARE_AMOUNT: "FEE_INVALID_SHARE_AMOUNT",
  SPLIT_MISMATCH: "FEE_SPLIT_MISMATCH",
  NEGATIVE_REMAINING: "FEE_NEGATIVE_REMAINING",
  EMPTY_SHARES: "FEE_EMPTY_SHARES",
  INVALID_PERCENTAGE: "FEE_INVALID_PERCENTAGE",
  OVERFLOW: "FEE_OVERFLOW",
} as const;

/**
 * Validate a fee share for correctness
 */
export function validateFeeShare(
  share: FeeShare,
  index: number,
  baseAmount: bigint
): { ok: boolean; error?: string; code?: string } {
  // Validate amount
  if (share.amount < 0n) {
    return {
      ok: false,
      error: `Share ${index}: amount cannot be negative`,
      code: FEE_CALCULATION_ERRORS.INVALID_SHARE_AMOUNT,
    };
  }

  if (share.amount > baseAmount) {
    return {
      ok: false,
      error: `Share ${index}: amount (${share.amount}) exceeds base amount (${baseAmount})`,
      code: FEE_CALCULATION_ERRORS.INVALID_SHARE_AMOUNT,
    };
  }

  // Validate recipient
  if (!share.recipient || share.recipient.length === 0) {
    return {
      ok: false,
      error: `Share ${index}: recipient cannot be empty`,
      code: FEE_CALCULATION_ERRORS.INVALID_SHARE_AMOUNT,
    };
  }

  // Validate percentage if provided
  if (share.percentage !== undefined) {
    if (share.percentage < 0 || share.percentage > 100) {
      return {
        ok: false,
        error: `Share ${index}: percentage must be between 0 and 100`,
        code: FEE_CALCULATION_ERRORS.INVALID_PERCENTAGE,
      };
    }
  }

  return { ok: true };
}

/**
 * Calculate fee shares and assert total matches base amount
 * Returns the allocation only if all shares sum to the base amount
 */
export function calculateFeeAllocation(
  baseAmount: string | number | bigint,
  shares: FeeShare[]
): CalculationResult {
  // Validate base amount
  const baseValidation = validateLedgerAmount(baseAmount, "baseAmount");
  if (!baseValidation.ok) {
    return {
      success: false,
      error: baseValidation.error,
      code: FEE_CALCULATION_ERRORS.INVALID_BASE_AMOUNT,
    };
  }

  const baseBigInt = baseValidation.value;

  if (baseBigInt < 0n) {
    return {
      success: false,
      error: "baseAmount cannot be negative",
      code: FEE_CALCULATION_ERRORS.INVALID_BASE_AMOUNT,
    };
  }

  // Validate shares array
  if (!shares || shares.length === 0) {
    return {
      success: false,
      error: "At least one fee share must be provided",
      code: FEE_CALCULATION_ERRORS.EMPTY_SHARES,
    };
  }

  // Validate each share
  for (let i = 0; i < shares.length; i++) {
    const shareValidation = validateFeeShare(shares[i], i, baseBigInt);
    if (!shareValidation.ok) {
      return {
        success: false,
        error: shareValidation.error,
        code: shareValidation.code,
      };
    }
  }

  // Calculate total deducted
  const shareAmounts = shares.map((s) => s.amount);
  const sumResult = sumLedgerAmounts(shareAmounts);

  if (!sumResult.ok) {
    return {
      success: false,
      error: `Failed to sum shares: ${sumResult.error}`,
      code: FEE_CALCULATION_ERRORS.OVERFLOW,
    };
  }

  const totalDeducted = sumResult.value;

  // CRITICAL: Assert that total deducted equals base amount
  if (totalDeducted !== baseBigInt) {
    return {
      success: false,
      error: `Fee split mismatch: total shares (${totalDeducted}) do not equal base amount (${baseBigInt})`,
      code: FEE_CALCULATION_ERRORS.SPLIT_MISMATCH,
    };
  }

  const remaining = baseBigInt - totalDeducted;

  // Validate remaining is not negative (should be 0 if split is correct)
  if (remaining < 0n) {
    return {
      success: false,
      error: `Remaining amount (${remaining}) cannot be negative`,
      code: FEE_CALCULATION_ERRORS.NEGATIVE_REMAINING,
    };
  }

  return {
    success: true,
    allocation: {
      baseAmount: baseBigInt,
      shares,
      totalDeducted,
      remaining,
    },
  };
}

/**
 * Calculate percentage-based fee allocation
 * Automatically computes share amounts from percentages
 */
export function calculatePercentageFeeAllocation(
  baseAmount: string | number | bigint,
  percentageShares: Array<{ recipient: string; percentage: number }>
): CalculationResult {
  // Validate base amount
  const baseValidation = validateLedgerAmount(baseAmount, "baseAmount");
  if (!baseValidation.ok) {
    return {
      success: false,
      error: baseValidation.error,
      code: FEE_CALCULATION_ERRORS.INVALID_BASE_AMOUNT,
    };
  }

  const baseBigInt = baseValidation.value;

  // Validate shares array
  if (!percentageShares || percentageShares.length === 0) {
    return {
      success: false,
      error: "At least one percentage share must be provided",
      code: FEE_CALCULATION_ERRORS.EMPTY_SHARES,
    };
  }

  // Validate percentage total is 100
  const totalPercentage = percentageShares.reduce((sum, s) => sum + s.percentage, 0);
  if (Math.abs(totalPercentage - 100) > 0.0001) {
    // Allow tiny floating point errors
    return {
      success: false,
      error: `Percentages must sum to 100, got ${totalPercentage}`,
      code: FEE_CALCULATION_ERRORS.INVALID_PERCENTAGE,
    };
  }

  // Convert percentages to amounts
  const shares: FeeShare[] = percentageShares.map((pShare) => ({
    recipient: pShare.recipient,
    percentage: pShare.percentage,
    amount: (baseBigInt * BigInt(Math.round(pShare.percentage * 100))) / BigInt(BPS_SCALE),
  }));

  // Truncating each share can leave rounding dust (e.g. 3 × 33.333333% of
  // 1000 = 999). Percentages already sum to 100, so assign the dust to the
  // last share to keep the split equal to the base amount.
  const allocated = shares.reduce((sum, s) => sum + s.amount, 0n);
  const dust = baseBigInt - allocated;
  if (dust > 0n) {
    shares[shares.length - 1].amount += dust;
  }

  // Use standard allocation calculation
  return calculateFeeAllocation(baseBigInt, shares);
}

/**
 * Verify that an existing allocation is consistent
 * Checks that shares sum to base amount
 */
export function verifyFeeAllocation(allocation: FeeAllocation): { ok: boolean; error?: string } {
  const shareAmounts = allocation.shares.map((s) => s.amount);
  const sumResult = sumLedgerAmounts(shareAmounts);

  if (!sumResult.ok) {
    return {
      ok: false,
      error: `Failed to verify shares sum: ${sumResult.error}`,
    };
  }

  const totalDeducted = sumResult.value;

  if (totalDeducted !== allocation.baseAmount) {
    return {
      ok: false,
      error: `Allocation mismatch: shares (${totalDeducted}) do not equal base amount (${allocation.baseAmount})`,
    };
  }

  const expectedRemaining = allocation.baseAmount - totalDeducted;
  if (expectedRemaining !== allocation.remaining) {
    return {
      ok: false,
      error: `Remaining amount mismatch: expected ${expectedRemaining}, got ${allocation.remaining}`,
    };
  }

  return { ok: true };
}

/**
 * Get share amounts for verification
 */
export function getShareAmounts(allocation: FeeAllocation): bigint[] {
  return allocation.shares.map((s) => s.amount);
}

/**
 * Check if allocation matches a set of amounts
 */
export function allocationMatchesAmounts(
  allocation: FeeAllocation,
  amounts: bigint[]
): boolean {
  if (allocation.shares.length !== amounts.length) {
    return false;
  }

  return allocation.shares.every((share, index) => share.amount === amounts[index]);
}

// ---------------------------------------------------------------------------
// Fee deduction / fee share calculations with digit-limit validation
// ---------------------------------------------------------------------------

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

/**
 * Basis points scale (10,000 bps = 100%, 100 bps = 1%). Fee rates are integer
 * basis points; fees are `amount * bps / BPS_SCALE` with integer division
 * truncating toward zero, the same rounding direction as the contract's
 * `calculate_platform_fee_split` (i128 division).
 */
export const BPS_SCALE = 10_000;

/** Default fee scale: basis points. */
export const DEFAULT_FEE_SCALE = BPS_SCALE;

/** Scaling factor used to convert floating-point share weights into integer numerators. */
const SHARE_SCALE = 1_000_000;

export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "FEE_CALCULATOR_EXCESSIVE_DIGITS",
  AMOUNT_OUT_OF_RANGE: "AMOUNT_OUT_OF_RANGE",
  INVALID_AMOUNT: "FEE_CALCULATOR_INVALID_AMOUNT",
  INVALID_FEE_RATE: "FEE_CALCULATOR_INVALID_FEE_RATE",
  INVALID_SHARES: "FEE_CALCULATOR_INVALID_SHARES",
  CALCULATION_OVERFLOW: "FEE_CALCULATOR_OVERFLOW",
  FEE_EXCEEDS_AMOUNT: "FEE_CALCULATOR_FEE_EXCEEDS_AMOUNT",
  INVALID_INPUT: "FEE_CALCULATOR_INVALID_INPUT",
  INVALID_ROW: "FEE_CALCULATOR_INVALID_ROW",
  EMPTY_DATA: "FEE_CALCULATOR_EMPTY_DATA",
  SERIALIZATION_ERROR: "FEE_CALCULATOR_SERIALIZATION_ERROR",
  FILE_WRITE_ERROR: "FEE_CALCULATOR_FILE_WRITE_ERROR",
  FILE_READ_ERROR: "FEE_CALCULATOR_FILE_READ_ERROR",
  SUM_MISMATCH: "FEE_CALCULATOR_SUM_MISMATCH",
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
    // A JS number above 2^53 has already lost precision; large amounts
    // must arrive as strings or bigints.
    if (!Number.isSafeInteger(input)) {
      return {
        ok: false,
        error: `${label} exceeds Number.MAX_SAFE_INTEGER; pass large amounts as a string or bigint`,
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

  if (!isAmountWithinRange(BigInt(raw))) {
    return {
      ok: false,
      error: `${label} exceeds the i128 amount range`,
      code: ERROR_CODES.AMOUNT_OUT_OF_RANGE,
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
    // A JS number above 2^53 has already lost precision; large amounts
    // must arrive as strings or bigints.
    if (!Number.isSafeInteger(input)) {
      return {
        ok: false,
        error: `${label} exceeds Number.MAX_SAFE_INTEGER; pass large amounts as a string or bigint`,
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

  if (!isAmountWithinRange(BigInt(raw))) {
    return {
      ok: false,
      error: `${label} exceeds the i128 amount range`,
      code: ERROR_CODES.AMOUNT_OUT_OF_RANGE,
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
 * and verifies expected total fee if provided. A mismatch is returned as a
 * validation failure so callers cannot accidentally accept an invalid split.
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
    if (!isAmountWithinRange(next)) {
      return {
        ok: false,
        error: "total fee sum exceeds the i128 amount range",
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

  if (expectedTotalFee !== undefined) {
    const expectedCheck = validateAmount(expectedTotalFee, "expectedTotalFee");
    if (!expectedCheck.ok) {
      return expectedCheck;
    }
    if (totalFee !== expectedCheck.value) {
      return {
        ok: false,
        error: `fee share total ${totalFee} does not match expected total ${expectedCheck.value}`,
        code: ERROR_CODES.SUM_MISMATCH,
      };
    }
  }

  const netAmount = gross - totalFee;

  return {
    ok: true,
    grossAmount: gross,
    totalFee,
    netAmount,
    isValid: true,
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
const BPS_DENOMINATOR = BigInt(BPS_SCALE);

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
    // A JS number above 2^53 has already lost precision; large amounts
    // must arrive as strings or bigints.
    if (!Number.isSafeInteger(input)) {
      return {
        ok: false,
        error: `${label} exceeds Number.MAX_SAFE_INTEGER; pass large amounts as a string or bigint`,
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

  if (!isAmountWithinRange(BigInt(raw))) {
    return {
      ok: false,
      error: `${label} exceeds the i128 amount range`,
      code: ERROR_CODES.AMOUNT_OUT_OF_RANGE,
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
  // Issue #670: unified half-even rounding.
  const feeAmount = divRound(numerator, BPS_DENOMINATOR, "half-even");

  const netAmount = base.value - feeAmount;

  return { ok: true, feeAmount, netAmount };
}

// ---------------------------------------------------------------------------
// Fee deduction records (validated rows consumed by the CSV exporters)
// ---------------------------------------------------------------------------

/**
 * Input record representing a fee deduction entry for serialization / export.
 */
export interface FeeDeductionRecord {
  label?: string;
  grossAmount: string | number | bigint;
  feeRate: string | number | bigint;
  scale?: string | number | bigint;
  [key: string]: unknown;
}

/**
 * Resolved and validated fee deduction row used in serialization.
 */
export interface ValidatedFeeRow {
  label?: string;
  grossAmount: bigint;
  feeRate: bigint;
  scale: bigint;
  feeAmount: bigint;
  netAmount: bigint;
  remainder: bigint;
  [key: string]: unknown;
}

/**
 * Validate a single fee deduction record step-by-step.
 * Resolves grossAmount / feeRate / scale through calculateFeeDeduction()
 * ensuring numerical consistency and adherence to digit limits.
 */
export function validateFeeDeductionRecord(
  record: FeeDeductionRecord,
  index = 0
):
  | { ok: true; value: ValidatedFeeRow }
  | { ok: false; error: string; code: FeeCalculatorErrorCode } {
  if (!record || typeof record !== "object") {
    return {
      ok: false,
      error: `record at index ${index} must be an object`,
      code: ERROR_CODES.INVALID_ROW,
    };
  }

  if (record.grossAmount === undefined) {
    return {
      ok: false,
      error: `record at index ${index} must provide grossAmount`,
      code: ERROR_CODES.INVALID_ROW,
    };
  }

  if (record.feeRate === undefined) {
    return {
      ok: false,
      error: `record at index ${index} must provide feeRate`,
      code: ERROR_CODES.INVALID_ROW,
    };
  }

  const scaleInput = record.scale !== undefined ? record.scale : DEFAULT_FEE_SCALE;
  const computed = calculateFeeDeduction(
    record.grossAmount as string | number | bigint,
    record.feeRate as string | number | bigint,
    scaleInput as string | number | bigint
  );
  if (!computed.ok) {
    return computed;
  }

  const grossCheck = validateAmount(
    record.grossAmount as string | number | bigint,
    `records[${index}].grossAmount`
  );
  if (!grossCheck.ok) {
    return grossCheck;
  }
  const rateCheck = validateFeeRate(
    record.feeRate as string | number | bigint,
    `records[${index}].feeRate`
  );
  if (!rateCheck.ok) {
    return rateCheck;
  }
  const scaleCheck = validateAmount(
    scaleInput as string | number | bigint,
    `records[${index}].scale`
  );
  if (!scaleCheck.ok) {
    return scaleCheck;
  }

  const result: ValidatedFeeRow = {
    grossAmount: computed.grossAmount,
    feeRate: rateCheck.value,
    scale: scaleCheck.value,
    feeAmount: computed.feeAmount,
    netAmount: computed.netAmount,
    remainder: computed.remainder,
  };

  if (typeof record.label === "string") {
    result.label = record.label;
  }

  for (const [k, v] of Object.entries(record)) {
    if (
      k !== "grossAmount" &&
      k !== "feeRate" &&
      k !== "scale" &&
      k !== "label"
    ) {
      result[k] = v;
    }
  }

  return { ok: true, value: result };
}
