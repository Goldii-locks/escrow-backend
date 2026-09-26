import {
  MAX_SAFE_DIGITS,
  ERROR_CODES,
  ERROR_DEFINITIONS,
  validateInterestRate,
  validatePrincipal,
  validateYieldSplitSum,
  estimateInterestYield,
} from "../src/utils/interest_yield_estimator.js";
import { validateErrorStructure } from "../src/utils/conversion_rate_scraper.js";

describe("interest_yield_estimator overflow validation", () => {
  function expectDefinedError(
    result: ReturnType<typeof estimateInterestYield>,
    code: string,
    parameter: string
  ): void {
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(code);
      expect(result.parameters).toEqual({ parameter, reason: result.error });
      expect(validateErrorStructure(result, ERROR_DEFINITIONS)).toEqual(
        expect.objectContaining({ ok: true, code })
      );
    }
  }

  describe("validateInterestRate", () => {
    it("accepts rates within the digit limit", () => {
      const result = validateInterestRate("500");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(500n);
      }
    });

    it("rejects excessive digits with OVERFLOW_EXCESSIVE_DIGITS", () => {
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const result = validateInterestRate(tooBig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
        expect(result.error).toMatch(/exceeds maximum/i);
      }
    });

    it("rejects non-integer rates with OVERFLOW_INVALID_RATE", () => {
      const result = validateInterestRate("1.5");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_RATE);
      }
    });

    it("rejects negative, missing, and unsupported rates with defined structures", () => {
      expectDefinedError(validateInterestRate(-1), ERROR_CODES.INVALID_RATE, "rate");
      expectDefinedError(validateInterestRate(undefined), ERROR_CODES.MISSING_PARAMETER, "rate");
      expectDefinedError(validateInterestRate({}), ERROR_CODES.INVALID_PARAMETER_TYPE, "rate");
    });
  });

  describe("estimateInterestYield", () => {
    it("estimates yield for a valid principal and rate", () => {
      const result = estimateInterestYield("100", "2");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(200n);
      }
    });

    it("blocks excessive digits on either operand", () => {
      const excessive = "9".repeat(MAX_SAFE_DIGITS + 1);
      const badPrincipal = estimateInterestYield(excessive, "1");
      expect(badPrincipal.ok).toBe(false);
      if (!badPrincipal.ok) {
        expect(badPrincipal.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }

      const badRate = estimateInterestYield("1", excessive);
      expect(badRate.ok).toBe(false);
      if (!badRate.ok) {
        expect(badRate.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

    it("blocks when the product overflows the digit limit", () => {
      const large = "9".repeat(MAX_SAFE_DIGITS);
      const result = estimateInterestYield(large, "10");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.PRODUCT_OVERFLOW);
      }
    });

    it("returns distinct structured errors for invalid principal and rate types", () => {
      expectDefinedError(estimateInterestYield(-1, 2), ERROR_CODES.INVALID_AMOUNT, "principal");
      expectDefinedError(estimateInterestYield(100, -1), ERROR_CODES.INVALID_RATE, "rate");
      expectDefinedError(estimateInterestYield(100, null), ERROR_CODES.MISSING_PARAMETER, "rate");
      expectDefinedError(estimateInterestYield(100, []), ERROR_CODES.INVALID_PARAMETER_TYPE, "rate");
    });

    it("preserves the successful calculation result shape", () => {
      expect(estimateInterestYield(1_000, 25)).toEqual({ ok: true, value: 25_000n });
    });

    it("returns a defined calculation exception when result formatting fails", () => {
      const originalToString = BigInt.prototype.toString;
      const result = (() => {
        try {
          BigInt.prototype.toString = () => {
            throw new Error("forced formatting failure");
          };
          return estimateInterestYield(100, 2);
        } finally {
          BigInt.prototype.toString = originalToString;
        }
      })();

      expectDefinedError(result, ERROR_CODES.CALCULATION_EXCEPTION, "estimateInterestYield");
      if (!result.ok) {
        expect(result.details).toEqual({
          context: { principal: 100, rate: 2 },
          reason: "forced formatting failure",
        });
      }
    });
  });

  describe("principal and split parameter validation", () => {
    it("uses the amount code for negative principals", () => {
      expectDefinedError(validatePrincipal(-4), ERROR_CODES.INVALID_AMOUNT, "principal");
    });

    it("rejects a non-array split structure and reports sum mismatches", () => {
      expectDefinedError(
        validateYieldSplitSum(null, 0),
        ERROR_CODES.PARAM_STRUCTURE_MISMATCH,
        "parts"
      );
      expectDefinedError(
        validateYieldSplitSum([1, 2], 4),
        ERROR_CODES.SUM_MISMATCH,
        "parts"
      );
    });

    it("rejects negative split members before summing", () => {
      expectDefinedError(
        validateYieldSplitSum([1, -2], 0),
        ERROR_CODES.INVALID_AMOUNT,
        "parts[1]"
      );
    });
  });
});
