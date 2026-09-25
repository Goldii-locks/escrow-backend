import {
  MAX_SAFE_DIGITS,
  ERROR_CODES,
  validateCentsMultiplier,
  validateMultiplier,
  applyCentsMultiplier,
  multiplyStablecoinCents,
} from "../src/utils/stablecoin_cents_multiplier.js";

describe("stablecoin_cents_multiplier overflow validation", () => {
  describe("validateCentsMultiplier / validateMultiplier", () => {
    it("accepts multipliers within the digit limit", () => {
      const result = validateCentsMultiplier("1000000");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1000000n);
      }
    });

    it("accepts maximum allowed 15-digit boundary value", () => {
      const boundaryVal = "9".repeat(MAX_SAFE_DIGITS);
      const result = validateCentsMultiplier(boundaryVal);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(BigInt(boundaryVal));
      }
    });

    it("accepts bigint and number inputs within limits", () => {
      expect(validateCentsMultiplier(500n).ok).toBe(true);
      expect(validateCentsMultiplier(100).ok).toBe(true);
      expect(validateMultiplier(250).ok).toBe(true);
    });

    it("rejects excessive digits with OVERFLOW_EXCESSIVE_DIGITS", () => {
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const result = validateCentsMultiplier(tooBig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
        expect(result.error).toMatch(/exceeds maximum/i);
      }
    });

    it("rejects non-integer multipliers with OVERFLOW_INVALID_MULTIPLIER", () => {
      const result = validateCentsMultiplier("1.25");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_MULTIPLIER);
        expect(result.error).toMatch(/must be an integer numeric value/i);
      }
    });

    it("rejects non-finite number inputs", () => {
      const result = validateCentsMultiplier(Number.POSITIVE_INFINITY);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_MULTIPLIER);
        expect(result.error).toMatch(/must be a finite integer/i);
      }
    });
  });

  describe("applyCentsMultiplier / multiplyStablecoinCents", () => {
    it("applies a valid multiplier to a small/normal cents amount", () => {
      const result = applyCentsMultiplier("100", "2");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(200n);
      }

      const aliasResult = multiplyStablecoinCents("500", "10");
      expect(aliasResult.ok).toBe(true);
      if (aliasResult.ok) {
        expect(aliasResult.value).toBe(5000n);
      }
    });

    it("accepts valid boundary values for multiplication resulting in 15 digits", () => {
      const amount = "1" + "0".repeat(14); // 15 digits
      const result = applyCentsMultiplier(amount, "1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(BigInt(amount));
      }
    });

    it("blocks excessive digits on amount input variable independently", () => {
      const excessiveAmount = "9".repeat(MAX_SAFE_DIGITS + 1);
      const badAmount = applyCentsMultiplier(excessiveAmount, "1");
      expect(badAmount.ok).toBe(false);
      if (!badAmount.ok) {
        expect(badAmount.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
        expect(badAmount.error).toMatch(/amount exceeds maximum of 15 digits/i);
      }
    });

    it("blocks excessive digits on multiplier input variable independently", () => {
      const excessiveMultiplier = "9".repeat(MAX_SAFE_DIGITS + 1);
      const badMultiplier = applyCentsMultiplier("1", excessiveMultiplier);
      expect(badMultiplier.ok).toBe(false);
      if (!badMultiplier.ok) {
        expect(badMultiplier.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
        expect(badMultiplier.error).toMatch(/multiplier exceeds maximum of 15 digits/i);
      }
    });

    it("blocks when the multiplication product overflows MAX_SAFE_DIGITS", () => {
      const largeAmount = "9".repeat(MAX_SAFE_DIGITS);
      const result = applyCentsMultiplier(largeAmount, "10");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.PRODUCT_OVERFLOW);
        expect(result.error).toMatch(/multiplied value exceeds maximum of 15 digits/i);
      }
    });

    it("regression test: blocks dangerous excessive inputs before arithmetic overflow occurs", () => {
      const dangerousInput = "9".repeat(100); // 100 digits
      const result = applyCentsMultiplier(dangerousInput, "2");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });
  });
});
