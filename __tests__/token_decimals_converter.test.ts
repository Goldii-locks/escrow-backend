import {
  MAX_SAFE_DIGITS,
  MAX_TOKEN_DECIMALS,
  ERROR_CODES,
  validateDecimals,
  validateRawAmount,
  toRawUnits,
  toHumanUnits,
} from "../src/utils/token_decimals_converter.js";

describe("token_decimals_converter overflow validation", () => {
  describe("validateDecimals", () => {
    it("accepts valid decimals values", () => {
      expect(validateDecimals(0).ok).toBe(true);
      expect(validateDecimals(7).ok).toBe(true);
      expect(validateDecimals(MAX_TOKEN_DECIMALS).ok).toBe(true);
    });

    it("rejects negative decimals with DECIMALS_INVALID_DECIMALS", () => {
      const result = validateDecimals(-1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_DECIMALS);
      }
    });

    it("rejects decimals above MAX_TOKEN_DECIMALS", () => {
      const result = validateDecimals(MAX_TOKEN_DECIMALS + 1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_DECIMALS);
      }
    });

    it("rejects non-integer decimals", () => {
      const result = validateDecimals(2.5);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_DECIMALS);
      }
    });

    it("rejects NaN decimals", () => {
      const result = validateDecimals(NaN);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_DECIMALS);
      }
    });
  });

  describe("validateRawAmount", () => {
    it("accepts values within the digit limit", () => {
      const result = validateRawAmount("123456789012345");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(123456789012345n);
      }
    });

    it("accepts bigint and number inputs within limits", () => {
      expect(validateRawAmount(999n).ok).toBe(true);
      expect(validateRawAmount(42).ok).toBe(true);
    });

    it("rejects excessive digits with DECIMALS_EXCESSIVE_DIGITS", () => {
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const result = validateRawAmount(tooBig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

    it("rejects non-integer strings with DECIMALS_INVALID_AMOUNT", () => {
      const result = validateRawAmount("12.5");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects non-finite numbers", () => {
      const result = validateRawAmount(Number.POSITIVE_INFINITY);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });
  });

  describe("toRawUnits", () => {
    it("converts a simple human amount correctly for decimals=7", () => {
      const result = toRawUnits("1.5", 7);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(15000000n);
      }
    });

    it("converts a simple human amount correctly for decimals=2", () => {
      const result = toRawUnits("100.25", 2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(10025n);
      }
    });

    it("converts a whole-number human amount with no fractional part", () => {
      const result = toRawUnits("42", 6);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(42000000n);
      }
    });

    it("rejects a fractional part with more digits than decimals allows", () => {
      const result = toRawUnits("1.23456", 3);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("propagates DECIMALS_INVALID_DECIMALS for an invalid decimals value", () => {
      const result = toRawUnits("1.5", 19);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_DECIMALS);
      }
    });

    it("blocks a conversion that would overflow the safe digit limit after scaling", () => {
      const manyDigits = "1".repeat(10); // 10 digit whole part
      const result = toRawUnits(manyDigits, 18);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.CONVERSION_OVERFLOW);
      }
    });
  });

  describe("toHumanUnits", () => {
    it("converts a raw amount back to the correct human string for decimals=7", () => {
      const result = toHumanUnits(15000000n, 7);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("1.5");
      }
    });

    it("converts a raw amount back to the correct human string for decimals=0", () => {
      const result = toHumanUnits(42n, 0);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("42");
      }
    });

    it("pads leading zeros when the raw amount has fewer digits than decimals", () => {
      const result = toHumanUnits(5n, 7);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("0.0000005");
      }
    });

    it("round-trips correctly with toRawUnits", () => {
      const raw = toRawUnits("100.250", 4);
      expect(raw.ok).toBe(true);
      if (raw.ok) {
        const human = toHumanUnits(raw.value, 4);
        expect(human.ok).toBe(true);
        if (human.ok) {
          expect(human.value).toBe("100.25");
        }
      }
    });

    it("propagates DECIMALS_INVALID_DECIMALS for an invalid decimals value", () => {
      const result = toHumanUnits(5n, MAX_TOKEN_DECIMALS + 1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_DECIMALS);
      }
    });

    it("propagates DECIMALS_EXCESSIVE_DIGITS for an excessive-digit raw amount", () => {
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const result = toHumanUnits(tooBig, 7);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });
  });
});
