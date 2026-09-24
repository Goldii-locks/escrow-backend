import {
  MAX_SAFE_DIGITS,
  ERROR_CODES,
  validateRefundRatio,
  applyRefundRatio,
} from "../src/utils/refund_ratio_helper.js";

describe("refund_ratio_helper overflow validation", () => {
  describe("validateRefundRatio", () => {
    it("accepts ratios within the digit limit", () => {
      const result = validateRefundRatio("2500");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2500n);
      }
    });

    it("rejects excessive digits with OVERFLOW_EXCESSIVE_DIGITS", () => {
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const result = validateRefundRatio(tooBig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
        expect(result.error).toMatch(/exceeds maximum/i);
      }
    });

    it("rejects non-integer ratios with OVERFLOW_INVALID_RATIO", () => {
      const result = validateRefundRatio("12.5");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_RATIO);
      }
    });
  });

  describe("applyRefundRatio", () => {
    it("applies a valid ratio to an amount", () => {
      const result = applyRefundRatio("100", "2");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(200n);
      }
    });

    it("blocks excessive digits on either operand", () => {
      const excessive = "9".repeat(MAX_SAFE_DIGITS + 1);
      const badAmount = applyRefundRatio(excessive, "1");
      expect(badAmount.ok).toBe(false);
      if (!badAmount.ok) {
        expect(badAmount.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }

      const badRatio = applyRefundRatio("1", excessive);
      expect(badRatio.ok).toBe(false);
      if (!badRatio.ok) {
        expect(badRatio.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

    it("blocks when the product overflows the digit limit", () => {
      const large = "9".repeat(MAX_SAFE_DIGITS);
      const result = applyRefundRatio(large, "10");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.PRODUCT_OVERFLOW);
      }
    });
  });
});
