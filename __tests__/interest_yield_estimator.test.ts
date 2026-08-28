import {
  MAX_SAFE_DIGITS,
  ERROR_CODES,
  validateInterestRate,
  estimateInterestYield,
} from "../src/utils/interest_yield_estimator.js";

describe("interest_yield_estimator overflow validation", () => {
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
  });
});
