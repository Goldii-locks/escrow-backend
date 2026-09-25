import {
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
} from "../src/utils/fee_deduction_calculator.js";

describe("fee_deduction_calculator overflow validation", () => {
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
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const result = validateAmount(tooBig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
        expect(result.error).toMatch(/exceeds maximum/i);
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
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const result = validateFeeRate(tooBig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
        expect(result.error).toMatch(/exceeds maximum/i);
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
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const result = calculateFeeDeduction(tooBig, 500);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

    it("rejects excessive digits on fee rate", () => {
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const result = calculateFeeDeduction(10_000, tooBig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

    it("rejects excessive digits on scale with EXCESSIVE_DIGITS", () => {
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const result = calculateFeeDeduction(10_000, 500, tooBig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
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
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const result = calculateFeeShares(tooBig, [1, 1]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

    it("blocks an allocation whose intermediate multiplication would overflow", () => {
      const hugeTotal = "9".repeat(MAX_SAFE_DIGITS);
      const result = calculateFeeShares(hugeTotal, [5_000_000_000, 1]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.CALCULATION_OVERFLOW);
        expect(result.error).toMatch(/overflow/i);
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
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const result = calculateFeeShareDeductions(tooBig, [1, 2]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

    it("blocks intermediate multiplication overflow on share deduction", () => {
      const hugeGross = "9".repeat(MAX_SAFE_DIGITS);
      const result = calculateFeeShareDeductions(hugeGross, [5_000_000_000, 1]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.CALCULATION_OVERFLOW);
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
      const excessive = "9".repeat(MAX_SAFE_DIGITS + 1);
      const result = checkFeeShareCalculation(1000, ["50", excessive]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

    it("blocks when running total fee sum exceeds MAX_SAFE_DIGITS", () => {
      const hugeShare = "9".repeat(MAX_SAFE_DIGITS);
      const result = checkFeeShareCalculation("9".repeat(MAX_SAFE_DIGITS), [hugeShare, hugeShare]);
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
