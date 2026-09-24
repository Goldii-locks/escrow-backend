import {
  MAX_SAFE_DIGITS,
  ERROR_CODES,
  validateConversionRate,
  applyConversionRate,
} from "../src/utils/conversion_rate_scraper.js";

describe("conversion_rate_scraper overflow validation", () => {
  describe("validateConversionRate", () => {
    it("accepts rates within the digit limit", () => {
      const result = validateConversionRate("1000000");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1000000n);
      }
    });

    it("rejects excessive digits with OVERFLOW_EXCESSIVE_DIGITS", () => {
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const result = validateConversionRate(tooBig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
        expect(result.error).toMatch(/exceeds maximum/i);
      }
    });

    it("rejects non-integer rates with OVERFLOW_INVALID_RATE", () => {
      const result = validateConversionRate("1.25");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_RATE);
      }
    });
  });

  describe("applyConversionRate", () => {
    it("applies a valid rate to a notional", () => {
      const result = applyConversionRate("100", "2");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(200n);
      }
    });

    it("blocks excessive digits on either operand", () => {
      const excessive = "9".repeat(MAX_SAFE_DIGITS + 1);
      const badNotional = applyConversionRate(excessive, "1");
      expect(badNotional.ok).toBe(false);
      if (!badNotional.ok) {
        expect(badNotional.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }

      const badRate = applyConversionRate("1", excessive);
      expect(badRate.ok).toBe(false);
      if (!badRate.ok) {
        expect(badRate.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

    it("blocks when the product overflows the digit limit", () => {
      const large = "9".repeat(MAX_SAFE_DIGITS);
      const result = applyConversionRate(large, "10");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.PRODUCT_OVERFLOW);
      }
    });
  });
});
