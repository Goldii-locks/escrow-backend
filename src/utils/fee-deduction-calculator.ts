/**
 * Fee Deduction Calculator
 *
 * Manages fee share calculations with total sum assertions to ensure:
 * - Split allocations sum to the base amount
 * - No partial updates or inconsistent states
 * - All calculations are atomic and verifiable
 */

import { sumLedgerAmounts, validateLedgerAmount } from "./audit_ledger_sum_checker.js";

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
    amount: (baseBigInt * BigInt(Math.round(pShare.percentage * 100))) / 10000n,
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
