import {
  FINANCIAL_REPORT_ROUNDING_MODE,
  FINANCIAL_REPORT_ROUNDING_POLICY,
  roundFinancialReportAmountList,
  roundFinancialReportDivision,
  splitFinancialReportAmount,
} from "../src/utils/financial_report_exporter.js";
import { divideHalfEven } from "../src/utils/financial_report_math.js";

describe("financial_report_exporter rounding policy (#504)", () => {
  it("documents round-to-nearest-even as the exporter policy", () => {
    expect(FINANCIAL_REPORT_ROUNDING_MODE).toBe("half_even");
    expect(FINANCIAL_REPORT_ROUNDING_POLICY.mode).toBe("half_even");
  });

  describe("roundFinancialReportDivision", () => {
    it("returns an exact quotient when the remainder is zero", () => {
      const result = roundFinancialReportDivision(21_000_000n, 7n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(3_000_000n);
        expect(result.truncated).toBe(3_000_000n);
        expect(result.remainder).toBe(0n);
        expect(result.truncated * 7n + result.remainder).toBe(21_000_000n);
      }
    });

    it("rounds downward when the fraction is below one half", () => {
      // 10 / 3 = 3 remainder 1; 2*1 < 3 → 3
      const result = roundFinancialReportDivision(10n, 3n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(3n);
        expect(result.remainder).toBe(1n);
        expect(result.truncated * 3n + result.remainder).toBe(10n);
      }
    });

    it("rounds upward when the fraction is above one half", () => {
      // 8 / 3 = 2 remainder 2; 2*2 > 3 → 3
      const result = roundFinancialReportDivision(8n, 3n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(3n);
        expect(result.remainder).toBe(2n);
      }
    });

    it("rounds 2.5 to even 2, not half-up 3", () => {
      const result = roundFinancialReportDivision(5n, 2n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2n);
        expect(divideHalfEven(5n, 2n)).toBe(2n);
        expect(result.remainder).toBe(1n);
      }
    });

    it("rounds 1.5 to even 2", () => {
      const result = roundFinancialReportDivision(3n, 2n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2n);
      }
    });

    it("rounds 0.5 to even 0", () => {
      const result = roundFinancialReportDivision(1n, 2n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0n);
        expect(result.remainder).toBe(1n);
      }
    });

    it("handles a zero numerator", () => {
      const result = roundFinancialReportDivision(0n, 10n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0n);
        expect(result.remainder).toBe(0n);
      }
    });
  });

  describe("splitFinancialReportAmount", () => {
    it("keeps every minor unit when dividing 10 across 3 rows", () => {
      const result = splitFinancialReportAmount(10, 3);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.parts).toEqual([4n, 3n, 3n]);
        expect(result.parts.reduce((sum, part) => sum + part, 0n)).toBe(10n);
        expect(result.remainder).toBe(1n);
        expect(result.roundedShare).toBe(3n);
      }
    });

    it("splits an exact multiple with a zero remainder", () => {
      const result = splitFinancialReportAmount(1_000_000n, 4);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.parts).toEqual([250_000n, 250_000n, 250_000n, 250_000n]);
        expect(result.remainder).toBe(0n);
        expect(result.roundedShare).toBe(250_000n);
      }
    });
  });

  describe("roundFinancialReportAmountList", () => {
    it("exposes when independently rounded rows diverge from rounding the total", () => {
      // Each of 5, 5 divided by 2 rounds half-even to 2 (2.5 → 2).
      // Sum of rounded rows = 4. Combined 10 / 2 = 5 exactly.
      const result = roundFinancialReportAmountList([5n, 5n], 2n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rounded).toEqual([2n, 2n]);
        expect(result.remainders).toEqual([1n, 1n]);
        expect(result.roundedSum).toBe(4n);
        expect(result.exactSum).toBe(10n);
        const combined = roundFinancialReportDivision(result.exactSum, 2n);
        expect(combined.ok).toBe(true);
        if (combined.ok) {
          expect(combined.value).toBe(5n);
          expect(combined.value).not.toBe(result.roundedSum);
        }
      }
    });
  });
});
