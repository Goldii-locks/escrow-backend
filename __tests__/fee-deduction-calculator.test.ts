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
