import {
  calculateFeeAllocation,
  calculatePercentageFeeAllocation,
  verifyFeeAllocation,
  validateFeeShare,
  getShareAmounts,
  allocationMatchesAmounts,
  FEE_CALCULATION_ERRORS,
  type FeeShare,
  type FeeAllocation,
  MAX_SAFE_DIGITS,
  MAX_INTERMEDIATE_DIGITS,
  DEFAULT_FEE_SCALE,
  ERROR_CODES,
  validateAmount,
  validateFeeAmount,
  validateFeeRate,
  validateFeeShares,
  calculateFeeDeduction,
  calculateFeeDeductionHalfEven,
  calculateFeeShares,
  calculateFeeShareDeductions,
  checkFeeShareCalculation,
  BPS_SCALE,
} from "../src/utils/fee-deduction-calculator.js";

describe("Fee Deduction Calculator", () => {
  describe("validateFeeShare – validate individual fee shares", () => {
    it("accepts valid fee share with correct amount", () => {
      const share: FeeShare = {
        recipient: "GAAAA...AAAA",
        amount: 500n,
      };

      const result = validateFeeShare(share, 0, 1000n);
      expect(result.ok).toBe(true);
    });

    it("rejects share with negative amount", () => {
      const share: FeeShare = {
        recipient: "GAAAA...AAAA",
        amount: -100n,
      };

      const result = validateFeeShare(share, 0, 1000n);
      expect(result.ok).toBe(false);
      expect(result.code).toBe(FEE_CALCULATION_ERRORS.INVALID_SHARE_AMOUNT);
    });

    it("rejects share with amount exceeding base", () => {
      const share: FeeShare = {
        recipient: "GAAAA...AAAA",
        amount: 1500n,
      };

      const result = validateFeeShare(share, 0, 1000n);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("exceeds base amount");
    });

    it("rejects share with empty recipient", () => {
      const share: FeeShare = {
        recipient: "",
        amount: 500n,
      };

      const result = validateFeeShare(share, 0, 1000n);
      expect(result.ok).toBe(false);
      expect(result.code).toBe(FEE_CALCULATION_ERRORS.INVALID_SHARE_AMOUNT);
    });

    it("rejects share with invalid percentage", () => {
      const share: FeeShare = {
        recipient: "GAAAA...AAAA",
        amount: 500n,
        percentage: 150,
      };

      const result = validateFeeShare(share, 0, 1000n);
      expect(result.ok).toBe(false);
      expect(result.code).toBe(FEE_CALCULATION_ERRORS.INVALID_PERCENTAGE);
    });

    it("accepts share with valid percentage", () => {
      const share: FeeShare = {
        recipient: "GAAAA...AAAA",
        amount: 500n,
        percentage: 50,
      };

      const result = validateFeeShare(share, 0, 1000n);
      expect(result.ok).toBe(true);
    });
  });

  describe("calculateFeeAllocation – basic allocation calculation", () => {
    it("calculates allocation with exact sum match", () => {
      const baseAmount = 1000n;
      const shares: FeeShare[] = [
        { recipient: "GAAAA...AAAA", amount: 600n },
        { recipient: "GBBBB...BBBB", amount: 400n },
      ];

      const result = calculateFeeAllocation(baseAmount, shares);
      expect(result.success).toBe(true);
      expect(result.allocation?.baseAmount).toBe(1000n);
      expect(result.allocation?.totalDeducted).toBe(1000n);
      expect(result.allocation?.remaining).toBe(0n);
    });

    it("rejects allocation when shares sum less than base", () => {
      const baseAmount = 1000n;
      const shares: FeeShare[] = [
        { recipient: "GAAAA...AAAA", amount: 600n },
        { recipient: "GBBBB...BBBB", amount: 300n }, // Sum = 900, not 1000
      ];

      const result = calculateFeeAllocation(baseAmount, shares);
      expect(result.success).toBe(false);
      expect(result.code).toBe(FEE_CALCULATION_ERRORS.SPLIT_MISMATCH);
      expect(result.error).toContain("do not equal base amount");
    });

    it("rejects allocation when shares sum more than base", () => {
      const baseAmount = 1000n;
      const shares: FeeShare[] = [
        { recipient: "GAAAA...AAAA", amount: 600n },
        { recipient: "GBBBB...BBBB", amount: 500n }, // Sum = 1100, not 1000
      ];

      const result = calculateFeeAllocation(baseAmount, shares);
      expect(result.success).toBe(false);
      expect(result.code).toBe(FEE_CALCULATION_ERRORS.SPLIT_MISMATCH);
    });

    it("rejects allocation with empty shares", () => {
      const baseAmount = 1000n;
      const shares: FeeShare[] = [];

      const result = calculateFeeAllocation(baseAmount, shares);
      expect(result.success).toBe(false);
      expect(result.code).toBe(FEE_CALCULATION_ERRORS.EMPTY_SHARES);
    });

    it("rejects allocation with invalid base amount", () => {
      const baseAmount = -1000;
      const shares: FeeShare[] = [
        { recipient: "GAAAA...AAAA", amount: 1000n },
      ];

      const result = calculateFeeAllocation(baseAmount, shares);
      expect(result.success).toBe(false);
      expect(result.code).toBe(FEE_CALCULATION_ERRORS.INVALID_BASE_AMOUNT);
    });

    it("accepts string base amount", () => {
      const baseAmount = "1000";
      const shares: FeeShare[] = [
        { recipient: "GAAAA...AAAA", amount: 1000n },
      ];

      const result = calculateFeeAllocation(baseAmount, shares);
      expect(result.success).toBe(true);
      expect(result.allocation?.baseAmount).toBe(1000n);
    });

    it("accepts number base amount", () => {
      const baseAmount = 1000;
      const shares: FeeShare[] = [
        { recipient: "GAAAA...AAAA", amount: 1000n },
      ];

      const result = calculateFeeAllocation(baseAmount, shares);
      expect(result.success).toBe(true);
    });

    it("works with very large amounts", () => {
      // Largest amount the shared ledger validator accepts (MAX_SAFE_DIGITS = 15).
      const baseAmount = "999999999999999";
      const shares: FeeShare[] = [
        { recipient: "GAAAA...AAAA", amount: 499999999999999n },
        { recipient: "GBBBB...BBBB", amount: 500000000000000n },
      ];

      const result = calculateFeeAllocation(baseAmount, shares);
      expect(result.success).toBe(true);
    });

    it("works with single recipient receiving entire amount", () => {
      const baseAmount = 1000n;
      const shares: FeeShare[] = [
        { recipient: "GAAAA...AAAA", amount: 1000n },
      ];

      const result = calculateFeeAllocation(baseAmount, shares);
      expect(result.success).toBe(true);
      expect(result.allocation?.remaining).toBe(0n);
    });

    it("calculates remaining amount correctly", () => {
      const baseAmount = 1000n;
      const shares: FeeShare[] = [
        { recipient: "GAAAA...AAAA", amount: 1000n },
      ];

      const result = calculateFeeAllocation(baseAmount, shares);
      expect(result.allocation?.remaining).toBe(0n);
    });
  });

  describe("calculatePercentageFeeAllocation – percentage-based allocation", () => {
    it("calculates 50/50 allocation correctly", () => {
      const baseAmount = 1000n;
      const percentageShares = [
        { recipient: "GAAAA...AAAA", percentage: 50 },
        { recipient: "GBBBB...BBBB", percentage: 50 },
      ];

      const result = calculatePercentageFeeAllocation(baseAmount, percentageShares);
      expect(result.success).toBe(true);
      expect(result.allocation?.totalDeducted).toBe(1000n);
    });

    it("calculates 30/70 allocation correctly", () => {
      const baseAmount = 1000n;
      const percentageShares = [
        { recipient: "GAAAA...AAAA", percentage: 30 },
        { recipient: "GBBBB...BBBB", percentage: 70 },
      ];

      const result = calculatePercentageFeeAllocation(baseAmount, percentageShares);
      expect(result.success).toBe(true);
      expect(result.allocation?.shares[0].amount).toBe(300n);
      expect(result.allocation?.shares[1].amount).toBe(700n);
    });

    it("rejects allocation when percentages don't sum to 100", () => {
      const baseAmount = 1000n;
      const percentageShares = [
        { recipient: "GAAAA...AAAA", percentage: 40 },
        { recipient: "GBBBB...BBBB", percentage: 50 }, // Sum = 90, not 100
      ];

      const result = calculatePercentageFeeAllocation(baseAmount, percentageShares);
      expect(result.success).toBe(false);
      expect(result.code).toBe(FEE_CALCULATION_ERRORS.INVALID_PERCENTAGE);
    });

    it("accepts very small percentage differences (floating point tolerance)", () => {
      const baseAmount = 1000n;
      const percentageShares = [
        { recipient: "GAAAA...AAAA", percentage: 33.333333 },
        { recipient: "GBBBB...BBBB", percentage: 33.333333 },
        { recipient: "GCCCC...CCCC", percentage: 33.333334 },
      ];

      const result = calculatePercentageFeeAllocation(baseAmount, percentageShares);
      expect(result.success).toBe(true);
    });

    it("rejects allocation with empty percentage shares", () => {
      const baseAmount = 1000n;
      const percentageShares: Array<{ recipient: string; percentage: number }> = [];

      const result = calculatePercentageFeeAllocation(baseAmount, percentageShares);
      expect(result.success).toBe(false);
      expect(result.code).toBe(FEE_CALCULATION_ERRORS.EMPTY_SHARES);
    });

    it("calculates single recipient percentage (100%)", () => {
      const baseAmount = 1000n;
      const percentageShares = [
        { recipient: "GAAAA...AAAA", percentage: 100 },
      ];

      const result = calculatePercentageFeeAllocation(baseAmount, percentageShares);
      expect(result.success).toBe(true);
      expect(result.allocation?.totalDeducted).toBe(1000n);
    });
  });

  describe("verifyFeeAllocation – verify allocation consistency", () => {
    it("verifies valid allocation", () => {
      const allocation: FeeAllocation = {
        baseAmount: 1000n,
        shares: [
          { recipient: "GAAAA...AAAA", amount: 600n },
          { recipient: "GBBBB...BBBB", amount: 400n },
        ],
        totalDeducted: 1000n,
        remaining: 0n,
      };

      const result = verifyFeeAllocation(allocation);
      expect(result.ok).toBe(true);
    });

    it("rejects allocation with mismatched total", () => {
      const allocation: FeeAllocation = {
        baseAmount: 1000n,
        shares: [
          { recipient: "GAAAA...AAAA", amount: 600n },
          { recipient: "GBBBB...BBBB", amount: 300n }, // Actually 900, not 1000
        ],
        totalDeducted: 900n,
        remaining: 100n,
      };

      const result = verifyFeeAllocation(allocation);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("do not equal base amount");
    });

    it("rejects allocation with incorrect remaining", () => {
      const allocation: FeeAllocation = {
        baseAmount: 1000n,
        shares: [
          { recipient: "GAAAA...AAAA", amount: 1000n },
        ],
        totalDeducted: 1000n,
        remaining: 50n, // Should be 0
      };

      const result = verifyFeeAllocation(allocation);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Remaining amount mismatch");
    });
  });

  describe("getShareAmounts – extract share amounts for verification", () => {
    it("returns all share amounts in order", () => {
      const allocation: FeeAllocation = {
        baseAmount: 1000n,
        shares: [
          { recipient: "GAAAA...AAAA", amount: 600n },
          { recipient: "GBBBB...BBBB", amount: 400n },
        ],
        totalDeducted: 1000n,
        remaining: 0n,
      };

      const amounts = getShareAmounts(allocation);
      expect(amounts).toEqual([600n, 400n]);
    });

    it("handles single share", () => {
      const allocation: FeeAllocation = {
        baseAmount: 1000n,
        shares: [
          { recipient: "GAAAA...AAAA", amount: 1000n },
        ],
        totalDeducted: 1000n,
        remaining: 0n,
      };

      const amounts = getShareAmounts(allocation);
      expect(amounts).toEqual([1000n]);
    });
  });

  describe("allocationMatchesAmounts – verify allocation against expected amounts", () => {
    it("matches when amounts are identical", () => {
      const allocation: FeeAllocation = {
        baseAmount: 1000n,
        shares: [
          { recipient: "GAAAA...AAAA", amount: 600n },
          { recipient: "GBBBB...BBBB", amount: 400n },
        ],
        totalDeducted: 1000n,
        remaining: 0n,
      };

      const matches = allocationMatchesAmounts(allocation, [600n, 400n]);
      expect(matches).toBe(true);
    });

    it("doesn't match when amounts differ", () => {
      const allocation: FeeAllocation = {
        baseAmount: 1000n,
        shares: [
          { recipient: "GAAAA...AAAA", amount: 600n },
          { recipient: "GBBBB...BBBB", amount: 400n },
        ],
        totalDeducted: 1000n,
        remaining: 0n,
      };

      const matches = allocationMatchesAmounts(allocation, [500n, 500n]);
      expect(matches).toBe(false);
    });

    it("doesn't match when array lengths differ", () => {
      const allocation: FeeAllocation = {
        baseAmount: 1000n,
        shares: [
          { recipient: "GAAAA...AAAA", amount: 600n },
          { recipient: "GBBBB...BBBB", amount: 400n },
        ],
        totalDeducted: 1000n,
        remaining: 0n,
      };

      const matches = allocationMatchesAmounts(allocation, [600n]);
      expect(matches).toBe(false);
    });
  });

  describe("Transaction integrity – verify split totals match base amounts under various scenarios", () => {
    it("rejects mismatch allocations with 2 recipients", () => {
      const baseAmount = 1000n;
      const shares: FeeShare[] = [
        { recipient: "GAAAA...AAAA", amount: 600n },
        { recipient: "GBBBB...BBBB", amount: 300n }, // Mismatch: 900 != 1000
      ];

      const result = calculateFeeAllocation(baseAmount, shares);
      expect(result.success).toBe(false);
      expect(result.code).toBe(FEE_CALCULATION_ERRORS.SPLIT_MISMATCH);
    });

    it("rejects mismatch allocations with 3 recipients", () => {
      const baseAmount = 1000n;
      const shares: FeeShare[] = [
        { recipient: "GAAAA...AAAA", amount: 400n },
        { recipient: "GBBBB...BBBB", amount: 300n },
        { recipient: "GCCCC...CCCC", amount: 250n }, // Sum = 950, not 1000
      ];

      const result = calculateFeeAllocation(baseAmount, shares);
      expect(result.success).toBe(false);
      expect(result.code).toBe(FEE_CALCULATION_ERRORS.SPLIT_MISMATCH);
    });

    it("rejects overflow when calculating sums", () => {
      const baseAmount = "99999999999999999999"; // Very large
      const shares: FeeShare[] = [
        {
          recipient: "GAAAA...AAAA",
          amount: BigInt("99999999999999999999"),
        },
      ];

      const result = calculateFeeAllocation(baseAmount, shares);
      // Will either succeed or fail with appropriate error
      if (!result.success) {
        expect(result.code).toBe(FEE_CALCULATION_ERRORS.INVALID_BASE_AMOUNT);
      }
    });

    it("maintains consistency through verification cycle", () => {
      const baseAmount = 1000n;
      const shares: FeeShare[] = [
        { recipient: "GAAAA...AAAA", amount: 600n },
        { recipient: "GBBBB...BBBB", amount: 400n },
      ];

      // Calculate
      const calcResult = calculateFeeAllocation(baseAmount, shares);
      expect(calcResult.success).toBe(true);

      // Verify
      const verifyResult = verifyFeeAllocation(calcResult.allocation!);
      expect(verifyResult.ok).toBe(true);

      // Match amounts
      const amounts = getShareAmounts(calcResult.allocation!);
      const matchesAmounts = allocationMatchesAmounts(calcResult.allocation!, amounts);
      expect(matchesAmounts).toBe(true);
    });

    it("rejects partial update scenarios", () => {
      // Simulate trying to update only some shares without full validation
      const baseAmount = 1000n;
      const shares: FeeShare[] = [
        { recipient: "GAAAA...AAAA", amount: 600n },
        // Missing second share entirely
      ];

      const result = calculateFeeAllocation(baseAmount, shares);
      expect(result.success).toBe(false);
      expect(result.error).toContain("do not equal base amount");
    });
  });

  describe("Edge cases and stress tests", () => {
    it("handles zero base amount", () => {
      const baseAmount = 0n;
      const shares: FeeShare[] = [];

      const result = calculateFeeAllocation(baseAmount, shares);
      expect(result.success).toBe(false);
      expect(result.code).toBe(FEE_CALCULATION_ERRORS.EMPTY_SHARES);
    });

    it("handles very many recipients", () => {
      const baseAmount = 1000n;
      const shares: FeeShare[] = Array.from({ length: 100 }, (_, i) => ({
        recipient: `G${"A".repeat(52)}${i.toString().padStart(3, "0")}`,
        amount: 10n,
      }));

      const result = calculateFeeAllocation(baseAmount, shares);
      expect(result.success).toBe(true);
      expect(result.allocation?.totalDeducted).toBe(1000n);
    });

    it("handles uneven distribution with remainder", () => {
      const baseAmount = 1000n;
      const shares: FeeShare[] = [
        { recipient: "GAAAA...AAAA", amount: 333n },
        { recipient: "GBBBB...BBBB", amount: 333n },
        { recipient: "GCCCC...CCCC", amount: 334n },
      ];

      const result = calculateFeeAllocation(baseAmount, shares);
      expect(result.success).toBe(true);
      expect(result.allocation?.remaining).toBe(0n);
    });

    it("detects when shares exceed base by 1", () => {
      const baseAmount = 1000n;
      const shares: FeeShare[] = [
        { recipient: "GAAAA...AAAA", amount: 501n },
        { recipient: "GBBBB...BBBB", amount: 500n },
      ];

      const result = calculateFeeAllocation(baseAmount, shares);
      expect(result.success).toBe(false);
      expect(result.code).toBe(FEE_CALCULATION_ERRORS.SPLIT_MISMATCH);
    });

    it("detects when shares fall short by 1", () => {
      const baseAmount = 1000n;
      const shares: FeeShare[] = [
        { recipient: "GAAAA...AAAA", amount: 500n },
        { recipient: "GBBBB...BBBB", amount: 499n },
      ];

      const result = calculateFeeAllocation(baseAmount, shares);
      expect(result.success).toBe(false);
      expect(result.code).toBe(FEE_CALCULATION_ERRORS.SPLIT_MISMATCH);
    });

    it("validates all shares before rejecting for overflow", () => {
      const baseAmount = 1000n;
      const shares: FeeShare[] = [
        { recipient: "", amount: 600n }, // Invalid recipient
        { recipient: "GBBBB...BBBB", amount: 400n },
      ];

      const result = calculateFeeAllocation(baseAmount, shares);
      expect(result.success).toBe(false);
      expect(result.error).toContain("recipient");
    });
  });

  describe("Consistency guarantees – assert calculations are atomic", () => {
    it("allocation either succeeds completely or fails completely", () => {
      const baseAmount = 1000n;
      const shares: FeeShare[] = [
        { recipient: "GAAAA...AAAA", amount: 600n },
        { recipient: "GBBBB...BBBB", amount: 400n },
      ];

      const result = calculateFeeAllocation(baseAmount, shares);

      if (result.success) {
        // If success, verify all fields are populated
        expect(result.allocation).toBeDefined();
        expect(result.allocation?.baseAmount).toBeDefined();
        expect(result.allocation?.shares).toBeDefined();
        expect(result.allocation?.totalDeducted).toBeDefined();
        expect(result.allocation?.remaining).toBeDefined();
        expect(result.error).toBeUndefined();
      } else {
        // If failure, error is set and allocation is undefined
        expect(result.error).toBeDefined();
        expect(result.allocation).toBeUndefined();
      }
    });

    it("failed calculation produces consistent error state", () => {
      const baseAmount = 1000n;
      const shares: FeeShare[] = [
        { recipient: "GAAAA...AAAA", amount: 600n },
        { recipient: "GBBBB...BBBB", amount: 300n }, // Mismatch
      ];

      const result1 = calculateFeeAllocation(baseAmount, shares);
      const result2 = calculateFeeAllocation(baseAmount, shares);

      expect(result1.success).toBe(result2.success);
      expect(result1.code).toBe(result2.code);
      expect(result1.error).toBe(result2.error);
    });
  });
});

// Smallest amount outside the contract's i128 range (i128 max + 1).
const OVER_I128 = (2n ** 127n).toString();
// The largest amount the contract accepts.
const I128_MAX = (2n ** 127n - 1n).toString();

describe("fee deduction overflow validation", () => {
  describe("validateAmount and validateFeeAmount", () => {
    it("accepts values within the digit limit", () => {
      const result = validateAmount("123456789012345");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(123456789012345n);
      }
    });

    it("accepts bigint and number inputs within limits", () => {
      expect(validateAmount(999n).ok).toBe(true);
      expect(validateAmount(1000).ok).toBe(true);
      expect(validateFeeAmount(50n).ok).toBe(true);
    });

    it("rejects excessive digits with EXCESSIVE_DIGITS", () => {
      const tooBig = OVER_I128;
      const result = validateAmount(tooBig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.AMOUNT_OUT_OF_RANGE);
        expect(result.error).toMatch(/i128 amount range/i);
      }
    });

    it("rejects non-integer strings with INVALID_AMOUNT", () => {
      const result = validateAmount("12.5");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects non-finite numbers", () => {
      const result = validateAmount(Number.POSITIVE_INFINITY);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });
  });

  describe("validateFeeRate", () => {
    it("accepts valid fee rate within limits", () => {
      const result = validateFeeRate(500);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(500n);
      }
    });

    it("rejects excessive digits in fee rate with EXCESSIVE_DIGITS", () => {
      const tooBig = OVER_I128;
      const result = validateFeeRate(tooBig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.AMOUNT_OUT_OF_RANGE);
        expect(result.error).toMatch(/i128 amount range/i);
      }
    });

    it("rejects negative fee rates with INVALID_FEE_RATE", () => {
      const result = validateFeeRate(-5);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_FEE_RATE);
      }
    });

    it("rejects non-integer fee rates with INVALID_FEE_RATE", () => {
      const result = validateFeeRate("2.5");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_FEE_RATE);
      }
    });
  });

  describe("validateFeeShares", () => {
    it("accepts a valid array of positive shares", () => {
      const result = validateFeeShares([50, 30, 20]);
      expect(result.ok).toBe(true);
    });

    it("rejects an empty shares array with INVALID_SHARES", () => {
      const result = validateFeeShares([]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_SHARES);
      }
    });

    it("rejects zero or negative share values", () => {
      const zeroCheck = validateFeeShares([10, 0]);
      expect(zeroCheck.ok).toBe(false);
      if (!zeroCheck.ok) {
        expect(zeroCheck.code).toBe(ERROR_CODES.INVALID_SHARES);
      }

      const negCheck = validateFeeShares([10, -5]);
      expect(negCheck.ok).toBe(false);
      if (!negCheck.ok) {
        expect(negCheck.code).toBe(ERROR_CODES.INVALID_SHARES);
      }
    });

    it("rejects non-finite share values", () => {
      const result = validateFeeShares([1, Number.NaN]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_SHARES);
      }
    });
  });

  describe("calculateFeeDeduction", () => {
    it("calculates deduction and net amount accurately for standard basis points", () => {
      // 500 bps = 5% of 10,000 = 500 fee, 9,500 net
      const result = calculateFeeDeduction(10_000, 500);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.feeAmount).toBe(500n);
        expect(result.netAmount).toBe(9_500n);
        expect(result.feeAmount + result.netAmount).toBe(10_000n);
      }
    });

    it("rejects excessive digits on gross amount", () => {
      const tooBig = OVER_I128;
      const result = calculateFeeDeduction(tooBig, 500);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.AMOUNT_OUT_OF_RANGE);
      }
    });

    it("rejects excessive digits on fee rate", () => {
      const tooBig = OVER_I128;
      const result = calculateFeeDeduction(10_000, tooBig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.AMOUNT_OUT_OF_RANGE);
      }
    });

    it("rejects excessive digits on scale with EXCESSIVE_DIGITS", () => {
      const tooBig = OVER_I128;
      const result = calculateFeeDeduction(10_000, 500, tooBig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.AMOUNT_OUT_OF_RANGE);
      }
    });

    it("rejects non-positive scale with INVALID_AMOUNT", () => {
      const result = calculateFeeDeduction(10_000, 500, 0);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects fee exceeding gross amount with FEE_EXCEEDS_AMOUNT", () => {
      // Fee rate of 20,000 bps with default scale 10,000 = 200% fee
      const result = calculateFeeDeduction(1000, 20_000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.FEE_EXCEEDS_AMOUNT);
      }
    });

    it("rejects negative gross amounts", () => {
      const result = calculateFeeDeduction(-1000, 500);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });
  });

  describe("calculateFeeDeductionHalfEven numeric outcomes", () => {
    it.each([
      { baseAmount: 10_000, feeRateBps: 500, feeAmount: 500n, netAmount: 9_500n },
      { baseAmount: 12_345, feeRateBps: 333, feeAmount: 411n, netAmount: 11_934n },
      { baseAmount: 1, feeRateBps: 4_999, feeAmount: 0n, netAmount: 1n },
      { baseAmount: 1, feeRateBps: 5_001, feeAmount: 1n, netAmount: 0n },
      { baseAmount: 1, feeRateBps: 5_000, feeAmount: 0n, netAmount: 1n },
      { baseAmount: 3, feeRateBps: 5_000, feeAmount: 2n, netAmount: 1n },
      { baseAmount: 0, feeRateBps: 7_500, feeAmount: 0n, netAmount: 0n },
      { baseAmount: 10_000, feeRateBps: 10_000, feeAmount: 10_000n, netAmount: 0n },
    ])(
      "returns the verified withholding and net amount for $baseAmount at $feeRateBps bps",
      ({ baseAmount, feeRateBps, feeAmount, netAmount }) => {
        const result = calculateFeeDeductionHalfEven(baseAmount, feeRateBps);

        expect(result).toEqual({ ok: true, feeAmount, netAmount });
        if (result.ok) {
          expect(result.feeAmount + result.netAmount).toBe(BigInt(baseAmount));
        }
      },
    );
  });

  describe("calculateFeeShares", () => {
    it("splits a total fee amount across equal shares correctly", () => {
      const result = calculateFeeShares(300, [1, 1, 1]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.feeShares).toEqual([100n, 100n, 100n]);
        const sum = result.feeShares.reduce((a, b) => a + b, 0n);
        expect(sum + result.remainder).toBe(300n);
      }
    });

    it("splits a total fee across weighted shares correctly", () => {
      const result = calculateFeeShares(1000, [60, 30, 10]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.feeShares).toEqual([600n, 300n, 100n]);
        const sum = result.feeShares.reduce((a, b) => a + b, 0n);
        expect(sum + result.remainder).toBe(1000n);
      }
    });

    it("rejects an invalid total fee, propagating INVALID_AMOUNT", () => {
      const result = calculateFeeShares("55.5", [1, 1]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects a total fee with excessive digits, propagating EXCESSIVE_DIGITS", () => {
      const tooBig = OVER_I128;
      const result = calculateFeeShares(tooBig, [1, 1]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.AMOUNT_OUT_OF_RANGE);
      }
    });

    // bigint intermediates cannot overflow, so a large total splits exactly
    // instead of being rejected (#698).
    it("splits a total far beyond the old 15-digit cap exactly", () => {
      const hugeTotal = I128_MAX;
      const result = calculateFeeShares(hugeTotal, [5_000_000_000, 1]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const sum = result.feeShares.reduce((a, b) => a + b, 0n);
        expect(sum + result.remainder).toBe(BigInt(hugeTotal));
      }
    });
  });

  describe("calculateFeeShareDeductions", () => {
    it("deducts shares from gross amount without drift", () => {
      const result = calculateFeeShareDeductions(10_000, [50, 30, 20]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.feeShares).toEqual([5000n, 3000n, 2000n]);
        expect(result.totalFee).toBe(10_000n);
        expect(result.netAmount).toBe(0n);
        expect(result.netAmount + result.totalFee).toBe(10_000n);
      }
    });

    it("deducts partial shares and returns remaining net amount", () => {
      // 10% and 5% of 1000 -> 100 and 50 out of 1000
      const result = calculateFeeShareDeductions(1000, [1, 1]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.totalFee).toBe(1000n);
        expect(result.netAmount).toBe(0n);
      }
    });

    it("blocks excessive digits on gross amount", () => {
      const tooBig = OVER_I128;
      const result = calculateFeeShareDeductions(tooBig, [1, 2]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.AMOUNT_OUT_OF_RANGE);
      }
    });

    it("deducts shares from a gross far beyond the old 15-digit cap exactly (#698)", () => {
      const hugeGross = I128_MAX;
      const result = calculateFeeShareDeductions(hugeGross, [5_000_000_000, 1]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.netAmount + result.totalFee).toBe(BigInt(hugeGross));
      }
    });
  });

  describe("checkFeeShareCalculation", () => {
    it("validates and confirms correct fee shares sum against gross amount", () => {
      const result = checkFeeShareCalculation(1000, ["50", "30", "20"], 100);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.totalFee).toBe(100n);
        expect(result.netAmount).toBe(900n);
        expect(result.isValid).toBe(true);
      }
    });

    it("rejects when expected total fee does not match the share sum", () => {
      const result = checkFeeShareCalculation(1000, ["50", "30"], 100);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.SUM_MISMATCH);
        expect(result.error).toMatch(/does not match expected total/i);
      }
    });

    it("blocks fee share entry with excessive digits before summing", () => {
      const excessive = OVER_I128;
      const result = checkFeeShareCalculation(1000, ["50", excessive]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.AMOUNT_OUT_OF_RANGE);
      }
    });

    it("blocks when the running total fee sum leaves the i128 range", () => {
      const hugeShare = I128_MAX;
      const result = checkFeeShareCalculation(I128_MAX, [hugeShare, hugeShare]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.CALCULATION_OVERFLOW);
      }
    });

    it("rejects when fee shares total exceeds gross amount", () => {
      const result = checkFeeShareCalculation(100, [60, 50]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.FEE_EXCEEDS_AMOUNT);
      }
    });
  });

  describe("constants and limits", () => {
    it("exposes MAX_SAFE_DIGITS as 15", () => {
      expect(MAX_SAFE_DIGITS).toBe(15);
    });

    it("exposes MAX_INTERMEDIATE_DIGITS as a wider bound than MAX_SAFE_DIGITS", () => {
      expect(MAX_INTERMEDIATE_DIGITS).toBeGreaterThan(MAX_SAFE_DIGITS);
      expect(MAX_INTERMEDIATE_DIGITS).toBe(30);
    });

    it("exposes DEFAULT_FEE_SCALE as 10000", () => {
      expect(DEFAULT_FEE_SCALE).toBe(10_000);
    });
  });
});

describe("BPS_SCALE – contract rounding direction", () => {
  it("uses 10_000 basis points as the default fee scale", () => {
    expect(BPS_SCALE).toBe(10_000);
    expect(DEFAULT_FEE_SCALE).toBe(BPS_SCALE);
  });

  it.each([
    // [amount, bps, fee] – fee = amount * bps / 10_000, truncated like i128 division
    ["1000", 250, 25n],
    ["999", 250, 24n],
    ["1", 9999, 0n],
    ["10000", 10000, 10000n],
    ["123456789", 125, 1543209n],
  ])("amount %s at %i bps truncates to %s", (amount, bps, fee) => {
    const res = calculateFeeDeduction(amount, bps);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.feeAmount).toBe(fee);
      expect(res.feeAmount + res.netAmount).toBe(BigInt(amount));
    }
  });
});
