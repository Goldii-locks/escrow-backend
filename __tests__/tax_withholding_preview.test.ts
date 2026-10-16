import {
  ERROR_CODES,
  previewTaxWithholding,
  resetTaxEstimatorRateLimitBuckets,
} from "../src/utils/tax_deduction_estimator.js";

beforeEach(() => {
  resetTaxEstimatorRateLimitBuckets();
});

describe("tax_deduction_estimator – previewTaxWithholding", () => {
  it.each([
    // Shared contract-style vectors (flat bps with truncation).
    { remainingBalance: 10_000, taxRateBps: 0, withholdingAmount: 0n, netAmount: 10_000n, remainder: 0n },
    { remainingBalance: 10_000, taxRateBps: 10_000, withholdingAmount: 10_000n, netAmount: 0n, remainder: 0n },
    { remainingBalance: 12_345, taxRateBps: 333, withholdingAmount: 411n, netAmount: 11_934n, remainder: 885n },
    { remainingBalance: 1, taxRateBps: 5_000, withholdingAmount: 0n, netAmount: 1n, remainder: 5_000n },
    { remainingBalance: 3, taxRateBps: 5_000, withholdingAmount: 1n, netAmount: 2n, remainder: 5_000n },
    { remainingBalance: 9_999, taxRateBps: 1, withholdingAmount: 0n, netAmount: 9_999n, remainder: 9_999n },
  ])(
    "matches flat-bps withholding for $remainingBalance at $taxRateBps bps",
    ({ remainingBalance, taxRateBps, withholdingAmount, netAmount, remainder }) => {
      const result = previewTaxWithholding(remainingBalance, taxRateBps);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.taxScale).toBe(10_000n);
        expect(result.roundingMode).toBe("truncate");
        expect(result.withholdingAmount).toBe(withholdingAmount);
        expect(result.netAmount).toBe(netAmount);
        expect(result.remainder).toBe(remainder);
        expect(result.withholdingAmount + result.netAmount).toBe(
          BigInt(remainingBalance)
        );
      }
    },
  );

  it("rejects taxRateBps over 10_000", () => {
    const result = previewTaxWithholding(1000, 10_001);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.RATE_EXCEEDS_SCALE);
    }
  });
});
