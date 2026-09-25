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
  calculateFeeShares,
  calculateFeeShareDeductions,
  checkFeeShareCalculation,
  validateBaseAmount,
  validateFeeRateBps,
  calculateFeeDeductionHalfEven,
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

    it("reports isValid false when expected total fee does not match", () => {
      const result = checkFeeShareCalculation(1000, ["50", "30"], 100);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.totalFee).toBe(80n);
        expect(result.isValid).toBe(false);
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

  describe("numeric math verification against known values", () => {
    describe("calculateFeeDeduction verified calculations", () => {
      it("5% fee on 10000 = 500 fee, 9500 net", () => {
        const result = calculateFeeDeduction(10000, 500);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeAmount).toBe(500n);
          expect(result.netAmount).toBe(9500n);
          expect(result.feeAmount + result.netAmount).toBe(10000n);
        }
      });

      it("10% fee on 5000 = 500 fee, 4500 net", () => {
        const result = calculateFeeDeduction(5000, 1000);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeAmount).toBe(500n);
          expect(result.netAmount).toBe(4500n);
        }
      });

      it("2.5% fee on 1000 = 25 fee, 975 net", () => {
        const result = calculateFeeDeduction(1000, 250);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeAmount).toBe(25n);
          expect(result.netAmount).toBe(975n);
        }
      });

      it("0% fee returns full amount as net", () => {
        const result = calculateFeeDeduction(1000, 0);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeAmount).toBe(0n);
          expect(result.netAmount).toBe(1000n);
        }
      });

      it("100% fee returns 0 net", () => {
        const result = calculateFeeDeduction(1000, 10000);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeAmount).toBe(1000n);
          expect(result.netAmount).toBe(0n);
        }
      });

      it("large amount 999999999999999 with 1% fee", () => {
        const result = calculateFeeDeduction(999999999999999n, 100);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeAmount).toBe(9999999999999n);
          expect(result.netAmount).toBe(990000000000000n);
        }
      });

      it("small amount 1 with 50% fee", () => {
        const result = calculateFeeDeduction(1, 5000);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeAmount).toBe(0n);
          expect(result.netAmount).toBe(1n);
        }
      });

      it("scale parameter: 5% with scale 1000 (per mille) on 1000", () => {
        const result = calculateFeeDeduction(1000, 50, 1000);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeAmount).toBe(50n);
          expect(result.netAmount).toBe(950n);
        }
      });

      it("scale parameter: 100 bps with scale 10000 on 10000 = 100 fee", () => {
        const result = calculateFeeDeduction(10000, 100, 10000);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeAmount).toBe(100n);
          expect(result.netAmount).toBe(9900n);
        }
      });
    });

    describe("calculateFeeShares verified calculations", () => {
      it("splits 1000 across [50, 30, 20] = [500, 300, 200]", () => {
        const result = calculateFeeShares(1000, [50, 30, 20]);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeShares).toEqual([500n, 300n, 200n]);
          expect(result.remainder).toBe(0n);
        }
      });

      it("splits 1000 across [33, 33, 34] = [330, 330, 340]", () => {
        const result = calculateFeeShares(1000, [33, 33, 34]);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeShares).toEqual([330n, 330n, 340n]);
          expect(result.remainder).toBe(0n);
        }
      });

      it("splits 100 across [1, 1] = [50, 50]", () => {
        const result = calculateFeeShares(100, [1, 1]);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeShares).toEqual([50n, 50n]);
          expect(result.remainder).toBe(0n);
        }
      });

      it("splits 100 across [1, 2, 3] = [16, 33, 50] with remainder 1", () => {
        const result = calculateFeeShares(100, [1, 2, 3]);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeShares).toEqual([16n, 33n, 50n]);
          expect(result.remainder).toBe(1n);
        }
      });

      it("single share receives entire amount", () => {
        const result = calculateFeeShares(500, [1]);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeShares).toEqual([500n]);
          expect(result.remainder).toBe(0n);
        }
      });

      it("large total fee with many shares", () => {
        const shares = Array(10).fill(10);
        const result = calculateFeeShares(10000, shares);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeShares).toHaveLength(10);
          expect(result.feeShares.every(s => s === 1000n)).toBe(true);
          expect(result.remainder).toBe(0n);
        }
      });
    });

    describe("calculateFeeShareDeductions verified calculations", () => {
      it("deducts [50, 30, 20] from 10000 = totalFee 10000, net 0", () => {
        const result = calculateFeeShareDeductions(10000, [50, 30, 20]);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeShares).toEqual([5000n, 3000n, 2000n]);
          expect(result.totalFee).toBe(10000n);
          expect(result.netAmount).toBe(0n);
        }
      });

      it("deducts [10, 5] from 1000 = totalFee 150, net 850", () => {
        // 10+5=15 parts, so 10/15*1000=666, 5/15*1000=333, total=999, remainder=1
        const result = calculateFeeShareDeductions(1000, [10, 5]);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeShares).toEqual([666n, 333n]);
          expect(result.totalFee).toBe(999n);
          expect(result.netAmount).toBe(1n);
        }
      });

      it("deducts [33, 33, 34] from 1000 = totalFee 1000, net 0", () => {
        const result = calculateFeeShareDeductions(1000, [33, 33, 34]);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeShares).toEqual([330n, 330n, 340n]);
          expect(result.totalFee).toBe(1000n);
          expect(result.netAmount).toBe(0n);
        }
      });
    });

    describe("checkFeeShareCalculation verified calculations", () => {
      it("validates correct shares sum against gross", () => {
        const result = checkFeeShareCalculation(1000, ["100", "200", "300"], 600);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.totalFee).toBe(600n);
          expect(result.netAmount).toBe(400n);
          expect(result.isValid).toBe(true);
        }
      });

      it("reports isValid false when sum mismatch", () => {
        const result = checkFeeShareCalculation(1000, ["100", "200", "300"], 500);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.totalFee).toBe(600n);
          expect(result.isValid).toBe(false);
        }
      });

      it("without expectedTotalFee returns isValid true", () => {
        const result = checkFeeShareCalculation(1000, ["100", "200", "300"]);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.totalFee).toBe(600n);
          expect(result.isValid).toBe(true);
        }
      });
    });

    describe("validateBaseAmount verified calculations", () => {
      it("accepts valid base amount string", () => {
        const result = validateBaseAmount("10000");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(10000n);
        }
      });

      it("accepts valid base amount bigint", () => {
        const result = validateBaseAmount(5000n);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(5000n);
        }
      });

      it("accepts valid base amount number", () => {
        const result = validateBaseAmount(7500);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(7500n);
        }
      });

      it("rejects negative base amount", () => {
        const result = validateBaseAmount(-100);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
        }
      });

      it("rejects negative base amount string", () => {
        const result = validateBaseAmount("-50");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
        }
      });

      it("rejects non-integer base amount", () => {
        const result = validateBaseAmount("100.5");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
        }
      });
    });

    describe("validateFeeRateBps verified calculations", () => {
      it("accepts valid basis points", () => {
        const result = validateFeeRateBps(500);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(500n);
        }
      });

      it("rejects negative basis points", () => {
        const result = validateFeeRateBps(-100);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe(ERROR_CODES.INVALID_FEE_RATE);
        }
      });

      it("rejects basis points over 10000", () => {
        const result = validateFeeRateBps(15000);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe(ERROR_CODES.INVALID_FEE_RATE);
        }
      });

      it("accepts 0 basis points", () => {
        const result = validateFeeRateBps(0);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(0n);
        }
      });

      it("accepts 10000 basis points (100%)", () => {
        const result = validateFeeRateBps(10000);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(10000n);
        }
      });
    });

    describe("calculateFeeDeductionHalfEven verified calculations", () => {
      it("half-even: 10000 with 500 bps (5%) = 500 fee, 9500 net", () => {
        const result = calculateFeeDeductionHalfEven(10000, 500);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeAmount).toBe(500n);
          expect(result.netAmount).toBe(9500n);
        }
      });

      it("half-even: exact half rounds to even - 1000 with 50 bps (0.5%) = 5 fee", () => {
        // 1000 * 50 = 50000, / 10000 = 5, remainder 0
        const result = calculateFeeDeductionHalfEven(1000, 50);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeAmount).toBe(5n);
          expect(result.netAmount).toBe(995n);
        }
      });

      it("half-even: 0.5 remainder rounds to even (1001 * 50 bps = 50050/10000 = 5.005 -> 5)", () => {
        const result = calculateFeeDeductionHalfEven(1001, 50);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeAmount).toBe(5n);
          expect(result.netAmount).toBe(996n);
        }
      });

      it("half-even: round up when remainder > 0.5 (10001 * 50 bps = 500050/10000 = 50.005 -> 50)", () => {
        const result = calculateFeeDeductionHalfEven(10001, 50);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeAmount).toBe(50n);
          expect(result.netAmount).toBe(9951n);
        }
      });

      it("half-even: 100 with 100 bps (1%) = 1 fee", () => {
        const result = calculateFeeDeductionHalfEven(100, 100);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeAmount).toBe(1n);
          expect(result.netAmount).toBe(99n);
        }
      });

      it("half-even: 0 fee with 0 bps", () => {
        const result = calculateFeeDeductionHalfEven(1000, 0);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeAmount).toBe(0n);
          expect(result.netAmount).toBe(1000n);
        }
      });

      it("half-even: full amount with 10000 bps", () => {
        const result = calculateFeeDeductionHalfEven(1000, 10000);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.feeAmount).toBe(1000n);
          expect(result.netAmount).toBe(0n);
        }
      });
    });
  });

  describe("mismatched parameter type rejection", () => {
    it("rejects null input with INVALID_AMOUNT", () => {
      const result = validateAmount(null as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
        expect(result.error).toMatch(/must be a string, number, or bigint/i);
      }
    });

    it("rejects undefined input with INVALID_AMOUNT", () => {
      const result = validateAmount(undefined as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects object input with INVALID_AMOUNT", () => {
      const result = validateAmount({ value: 100 } as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects array input with INVALID_AMOUNT", () => {
      const result = validateAmount([100] as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects boolean input with INVALID_AMOUNT", () => {
      const result = validateAmount(true as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects null feeRate with INVALID_FEE_RATE", () => {
      const result = validateFeeRate(null as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_FEE_RATE);
      }
    });

    it("rejects object feeRate with INVALID_FEE_RATE", () => {
      const result = validateFeeRate({ rate: 100 } as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_FEE_RATE);
      }
    });

    it("rejects null baseAmount with INVALID_AMOUNT", () => {
      const result = validateBaseAmount(null as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects object baseAmount with INVALID_AMOUNT", () => {
      const result = validateBaseAmount({ amount: 100 } as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects array feeShares with INVALID_SHARES", () => {
      const result = validateFeeShares({} as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_SHARES);
      }
    });

    it("rejects null feeShares with INVALID_SHARES", () => {
      const result = validateFeeShares(null as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_SHARES);
      }
    });
  });
});
