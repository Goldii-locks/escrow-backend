import {
  applyRoundedScale,
  assertLedgerSplitSum,
  divideWithRounding,
  resetAuditRateLimitBuckets,
  roundHalfEven,
  sumLedgerAmounts,
  validateLedgerAmount,
} from "../src/utils/audit_ledger_sum_checker.js";

/**
 * Independently verified numeric fixtures for audit_ledger_sum_checker.
 *
 * Amounts are integer minor units (stroops at 7 decimals unless noted).
 * Expected values were computed by hand from the integer identities, not
 * copied from the implementation.
 */
describe("audit_ledger_sum_checker detailed numeric fixtures (#502)", () => {
  beforeEach(() => {
    resetAuditRateLimitBuckets();
  });

  describe("multi-entry ledger sums", () => {
    it("aggregates mixed string/number/bigint credits in stroops", () => {
      // 1.5000000 + 0.2500000 + 0.4000000 XLM
      // = 15_000_000 + 2_500_000 + 4_000_000 = 21_500_000 stroops
      const result = sumLedgerAmounts(["15000000", 2_500_000, 4_000_000n]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(21_500_000n);
      }
    });

    it("aggregates several records including zeros", () => {
      // 0 + 1 + 0 + 99 + 1_000_000 = 1_000_100
      const result = sumLedgerAmounts([0, "1", 0n, 99, "1000000"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1_000_100n);
      }
    });

    it("sums a longer ledger of distinct categories by amount only", () => {
      // deposit 12_345_678
      // fee     1_000_000
      // payout  50_000_000
      // rebate      22
      // total   63_345_700
      const result = sumLedgerAmounts([
        "12345678",
        1_000_000n,
        50_000_000,
        "22",
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(63_345_700n);
      }
    });

    it("treats a single zero as a valid ledger total", () => {
      const result = sumLedgerAmounts([0n]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0n);
      }
    });
  });

  describe("split-sum assertions against a base amount", () => {
    it("confirms three-way splits that reconstruct the base", () => {
      // 3_333_333 + 3_333_333 + 3_333_334 = 10_000_000
      const result = assertLedgerSplitSum(
        [3_333_333n, 3_333_333n, 3_333_334n],
        "10000000"
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.isMatch).toBe(true);
        expect(result.total).toBe(10_000_000n);
      }
    });

    it("reports a shortfall without using reject mode", () => {
      // 4_000_000 + 5_000_000 = 9_000_000, base 10_000_000
      const result = assertLedgerSplitSum(["4000000", "5000000"], 10_000_000n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.isMatch).toBe(false);
        expect(result.total).toBe(9_000_000n);
      }
    });
  });

  describe("round-half-to-even division (independently tabulated)", () => {
    it("returns an exact quotient when the remainder is zero", () => {
      // 21_000_000 / 7 = 3_000_000 remainder 0
      const result = roundHalfEven(21_000_000n, 7n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(3_000_000n);
        expect(result.remainder).toBe(0n);
      }
    });

    it("truncates when the fractional part is below one half", () => {
      // 10 / 3 = 3 remainder 1; 2*1 = 2 < 3 → 3
      const result = roundHalfEven(10n, 3n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(3n);
        expect(result.remainder).toBe(1n);
      }
    });

    it("rounds up when the fractional part is above one half", () => {
      // 8 / 3 = 2 remainder 2; 2*2 = 4 > 3 → 3
      const result = roundHalfEven(8n, 3n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(3n);
        expect(result.remainder).toBe(2n);
      }
    });

    it("rounds 2.5 toward even 2, not half-up 3", () => {
      // 5 / 2 = 2 remainder 1; 2*1 == 2 and quotient 2 is even → 2
      const result = roundHalfEven(5n, 2n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2n);
        expect(result.remainder).toBe(1n);
      }
    });

    it("rounds 1.5 toward even 2", () => {
      // 3 / 2 = 1 remainder 1; quotient 1 is odd → 2
      const result = roundHalfEven(3n, 2n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2n);
        expect(result.remainder).toBe(1n);
      }
    });
  });

  describe("divideWithRounding remainder distribution", () => {
    it("splits 10 into 3 parts that sum back to 10", () => {
      // 10 / 3 → truncated 3, dustCount = 10 - 9 = 1
      // parts = [4, 3, 3]
      const result = divideWithRounding(10, 3);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.parts).toEqual([4n, 3n, 3n]);
        expect(result.parts.reduce((sum, part) => sum + part, 0n)).toBe(10n);
      }
    });

    it("splits an exact multiple with no dust", () => {
      // 1_000_000 / 4 = 250_000 each
      const result = divideWithRounding("1000000", 4);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.parts).toEqual([250_000n, 250_000n, 250_000n, 250_000n]);
      }
    });
  });

  describe("applyRoundedScale fee-style percentages", () => {
    it("applies 2.5% (250 / 10_000) to 1_000_000 stroops", () => {
      // 1_000_000 * 250 = 250_000_000
      // 250_000_000 / 10_000 = 25_000 remainder 0
      const result = applyRoundedScale(1_000_000n, 250, 10_000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(25_000n);
        expect(result.remainder).toBe(0n);
      }
    });

    it("rounds a 1.5-scale product half-to-even", () => {
      // 15 * 1 / 10 = 1.5 → quotient 1 (odd) → 2
      const result = applyRoundedScale(15, 1, 10);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2n);
        expect(result.remainder).toBe(5n);
      }
    });

    it("rounds a 2.5-scale product half-to-even, not half-up", () => {
      // 25 * 1 / 10 = 2.5 → quotient 2 (even) → 2
      const result = applyRoundedScale(25, 1, 10);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2n);
        expect(result.remainder).toBe(5n);
      }
    });
  });

  describe("validateLedgerAmount decimal-string rejection", () => {
    it("rejects a human decimal that is not an integer minor unit", () => {
      const result = validateLedgerAmount("12.5");
      expect(result.ok).toBe(false);
    });
  });
});
