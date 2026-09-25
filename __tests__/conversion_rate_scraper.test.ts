import {
  MAX_SAFE_DIGITS,
  ERROR_CODES,
  validateConversionRate,
  applyConversionRate,
  validateErrorStructure,
  validateCalculationParameters,
  safeApplyConversionRateWithValidation,
  ErrorDefinition,
} from "../src/utils/conversion_rate_scraper.js";

describe("conversion_rate_scraper mathematics and overflow validation", () => {
  describe("validateConversionRate", () => {
    it("accepts valid rates across string, number, and bigint types", () => {
      // String input
      const resString = validateConversionRate("123456789012345");
      expect(resString).toEqual({ ok: true, value: 123456789012345n });

      // Number input (within JS safe integer)
      const resNumber = validateConversionRate(987654321);
      expect(resNumber).toEqual({ ok: true, value: 987654321n });

      // BigInt input
      const resBigInt = validateConversionRate(100000000000000n);
      expect(resBigInt).toEqual({ ok: true, value: 100000000000000n });
    });

    it("handles zero and negative integers correctly within digit limit", () => {
      // Zero value (1 digit)
      const resZero = validateConversionRate("0");
      expect(resZero).toEqual({ ok: true, value: 0n });

      // Negative value: -999,999,999,999,999 (15 digits excluding sign)
      const resNeg = validateConversionRate("-999999999999999");
      expect(resNeg).toEqual({ ok: true, value: -999999999999999n });
    });

    it("normalizes leading zeros when calculating digit count", () => {
      // "000123456789" has 9 significant digits
      const result = validateConversionRate("000123456789");
      expect(result).toEqual({ ok: true, value: 123456789n });
    });

    it("accepts exactly MAX_SAFE_DIGITS (15 digits) and rejects 16 digits", () => {
      // Exactly 15 digits: 999,999,999,999,999
      const maxSafeString = "9".repeat(MAX_SAFE_DIGITS);
      const validRes = validateConversionRate(maxSafeString);
      expect(validRes.ok).toBe(true);
      if (validRes.ok) {
        expect(validRes.value).toBe(999999999999999n);
      }

      // 16 digits: 1,000,000,000,000,000
      const overflowString = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const invalidRes = validateConversionRate(overflowString);
      expect(invalidRes).toEqual({
        ok: false,
        error: "rate exceeds maximum of 15 digits",
        code: ERROR_CODES.EXCESSIVE_DIGITS,
      });
    });

    it("rejects non-integer inputs and floating-point strings/numbers", () => {
      // Decimal point string
      const resFloatString = validateConversionRate("123.456");
      expect(resFloatString).toEqual({
        ok: false,
        error: "rate must be an integer numeric value",
        code: ERROR_CODES.INVALID_RATE,
      });

      // Float number
      const resFloatNumber = validateConversionRate(12.34);
      expect(resFloatNumber).toEqual({
        ok: false,
        error: "rate must be a finite integer",
        code: ERROR_CODES.INVALID_RATE,
      });

      // Non-numeric string
      const resAlpha = validateConversionRate("1000g");
      expect(resAlpha).toEqual({
        ok: false,
        error: "rate must be an integer numeric value",
        code: ERROR_CODES.INVALID_RATE,
      });

      // Non-finite numbers
      expect(validateConversionRate(NaN)).toEqual({
        ok: false,
        error: "rate must be a finite integer",
        code: ERROR_CODES.INVALID_RATE,
      });
      expect(validateConversionRate(Infinity)).toEqual({
        ok: false,
        error: "rate must be a finite integer",
        code: ERROR_CODES.INVALID_RATE,
      });
    });
  });

  describe("applyConversionRate detailed mathematical calculations", () => {
    it("calculates conversion for 7-decimal fixed-point oracle rate and token amount", () => {
      // Math:
      // Notional = 25,000,000 stroops (2.5 XLM at 10^7 scale)
      // Rate = 1,250,000 ($0.125 USD/XLM scaled by 10^7)
      // Calculation: 25,000,000 * 1,250,000 = 31,250,000,000,000 (14 digits)
      const notional = "25000000";
      const rate = "1250000";
      const expectedBigInt = 31250000000000n;

      const result = applyConversionRate(notional, rate);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(expectedBigInt);
      }
    });

    it("verifies non-trivial asymmetric fixed-point rate multiplication", () => {
      // Math:
      // Source amount = 123,456,789
      // Conversion factor = 987,654
      // Product = 123,456,789 * 987,654 = 121,932,591,483,006 (15 digits)
      const notional = 123456789n;
      const rate = "987654";
      const expectedProduct = 121932591483006n;

      const result = applyConversionRate(notional, rate);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(expectedProduct);
      }
    });

    it("correctly evaluates non-integer result before unscaling factor", () => {
      // Math:
      // Notional = 1,000,001
      // Rate = 333,333
      // Product = 1,000,001 * 333,333 = 333,333,333,333 (12 digits)
      const notional = "1000001";
      const rate = "333333";
      const expectedProduct = 333333333333n;

      const result = applyConversionRate(notional, rate);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(expectedProduct);
      }
    });

    it("verifies directional multiplier behaviour to prevent ratio inversion", () => {
      // Scenario: Converting Token A to Token B where Token A price is $2.00 (scaled: 200)
      // and Token B price is $0.50 (scaled: 50).
      // Conversion rate factor R = PriceA / PriceB = 200 / 50 = 4 (scaled: 4)
      // Notional of 500 Token A converted to Token B = 500 * 4 = 2,000 Token B units.
      // If inverted (0.25), product would be 125, which would fail this assertion.
      const notional = 500;
      const rate = 4;
      const expectedProduct = 2000n;

      const result = applyConversionRate(notional, rate);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(expectedProduct);
      }
    });

    it("handles zero notional and zero rate correctly", () => {
      // Math: 0 * 123,456,789 = 0
      const zeroNotional = applyConversionRate("0", "123456789");
      expect(zeroNotional).toEqual({ ok: true, value: 0n });

      // Math: 123,456,789 * 0 = 0
      const zeroRate = applyConversionRate("123456789", "0");
      expect(zeroRate).toEqual({ ok: true, value: 0n });
    });

    it("handles negative values in credit/debit adjustments", () => {
      // Math: -1,234,567 * 5,000 = -6,172,835,000
      const negativeNotional = applyConversionRate("-1234567", "5000");
      expect(negativeNotional).toEqual({ ok: true, value: -6172835000n });
    });

    it("verifies maximum safe product boundary (15 digits ok vs 16 digits overflow)", () => {
      // Safe boundary:
      // Notional = 999,999,999 (9 digits)
      // Rate = 1,000,000 (7 digits)
      // Product = 999,999,999,000,000 (15 digits) -> PASS
      const safeNotional = "999999999";
      const safeRate = "1000000";
      const expectedSafeProduct = 999999999000000n;

      const safeResult = applyConversionRate(safeNotional, safeRate);
      expect(safeResult.ok).toBe(true);
      if (safeResult.ok) {
        expect(safeResult.value).toBe(expectedSafeProduct);
      }

      // Overflow boundary:
      // Notional = 1,000,000,000 (10 digits)
      // Rate = 1,000,000 (7 digits)
      // Product = 1,000,000,000,000,000 (16 digits) -> OVERFLOW
      const overflowNotional = "1000000000";
      const overflowRate = "1000000";

      const overflowResult = applyConversionRate(
        overflowNotional,
        overflowRate
      );
      expect(overflowResult).toEqual({
        ok: false,
        error: "converted value exceeds maximum of 15 digits",
        code: ERROR_CODES.PRODUCT_OVERFLOW,
      });
    });

    it("rejects conversion when notional or rate has invalid format or excessive digits", () => {
      // Invalid notional format
      const badNotional = applyConversionRate("12.34", "1000");
      expect(badNotional).toEqual({
        ok: false,
        error: "notional must be an integer numeric value",
        code: ERROR_CODES.INVALID_RATE,
      });

      // Excessive digits in rate
      const badRateDigits = applyConversionRate("1000", "1" + "0".repeat(15));
      expect(badRateDigits).toEqual({
        ok: false,
        error: "rate exceeds maximum of 15 digits",
        code: ERROR_CODES.EXCESSIVE_DIGITS,
      });
    });

    it("supports mixed input types seamlessly (string, number, bigint)", () => {
      // Math: 5,000 * 250 = 1,250,000
      const res1 = applyConversionRate(5000, "250");
      expect(res1).toEqual({ ok: true, value: 1250000n });

      const res2 = applyConversionRate("5000", 250n);
      expect(res2).toEqual({ ok: true, value: 1250000n });
    });
  });

  describe("validateErrorStructure - parameter error structure validation", () => {
    const sampleDefinitions: ErrorDefinition[] = [
      {
        code: "RATE_UNAVAILABLE",
        message: "Requested conversion rate is unavailable",
        parameters: [
          { name: "pair", type: "string", required: true },
          { name: "timestamp", type: "number", required: true },
        ],
      },
      {
        code: "ORDERED_CALC_ERROR",
        message: "Calculation error with ordered arguments",
        ordered: true,
        parameters: [
          { name: "notional", type: "string", required: true },
          { name: "rate", type: "string", required: true },
        ],
      },
    ];

    it("1. succeeds when parameter structure matches expected definition exactly", () => {
      const validResponseBody = {
        code: "RATE_UNAVAILABLE",
        parameters: {
          pair: "XLM/USD",
          timestamp: 1672531199,
        },
      };

      const result = validateErrorStructure(validResponseBody, sampleDefinitions);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.code).toBe("RATE_UNAVAILABLE");
        expect(result.validatedParams).toEqual({
          pair: "XLM/USD",
          timestamp: 1672531199,
        });
      }
    });

    it("2. detects missing required parameters and returns MISSING_PARAMETER", () => {
      const missingParamBody = {
        code: "RATE_UNAVAILABLE",
        parameters: {
          pair: "XLM/USD",
          // timestamp is missing
        },
      };

      const result = validateErrorStructure(missingParamBody, sampleDefinitions);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.MISSING_PARAMETER);
        expect(result.error).toMatch(/Missing required parameter/i);
        expect(result.details?.missingParams).toContain("timestamp");
      }
    });

    it("enforces validation precedence: missing parameter takes precedence over order check", () => {
      // Input has only 'rate', missing 'notional' for expected order [notional, rate]
      const missingParamOrderedBody = {
        code: "ORDERED_CALC_ERROR",
        parameters: {
          rate: "5", // Missing 'notional'
        },
      };

      const result = validateErrorStructure(missingParamOrderedBody, sampleDefinitions);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.MISSING_PARAMETER);
        expect(result.details?.missingParams).toContain("notional");
      }
    });

    it("3. detects unexpected extra parameters and returns EXTRA_PARAMETER", () => {
      const extraParamBody = {
        code: "RATE_UNAVAILABLE",
        parameters: {
          pair: "XLM/USD",
          timestamp: 1672531199,
          unexpectedParam: "extra_value",
        },
      };

      const result = validateErrorStructure(extraParamBody, sampleDefinitions);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXTRA_PARAMETER);
        expect(result.error).toMatch(/Unexpected extra parameter/i);
        expect(result.details?.extraParams).toContain("unexpectedParam");
      }
    });

    it("4. detects incorrect parameter types and returns INVALID_PARAMETER_TYPE without crashing", () => {
      const wrongTypeBody = {
        code: "RATE_UNAVAILABLE",
        parameters: {
          pair: 12345, // should be string
          timestamp: "not_a_number", // should be number
        },
      };

      const result = validateErrorStructure(wrongTypeBody, sampleDefinitions);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_PARAMETER_TYPE);
        expect(result.error).toMatch(/Parameter type mismatch/i);
        expect(result.details?.typeMismatches).toHaveLength(2);
      }
    });

    it("5. detects genuine parameter order mismatches and returns INVALID_PARAMETER_ORDER", () => {
      // Complete parameter set provided out of order
      const outOfOrderKeysBody = {
        code: "ORDERED_CALC_ERROR",
        parameters: {
          rate: "5",       // Key 1 provided first (expected 'notional' first)
          notional: "100", // Key 2 provided second
        },
      };

      const orderResult1 = validateErrorStructure(outOfOrderKeysBody, sampleDefinitions);
      expect(orderResult1.ok).toBe(false);
      if (!orderResult1.ok) {
        expect(orderResult1.code).toBe(ERROR_CODES.INVALID_PARAMETER_ORDER);
        expect(orderResult1.error).toMatch(/Parameter order mismatch/i);
      }

      // Test out-of-order parameter objects array
      const outOfOrderArrayBody = {
        code: "ORDERED_CALC_ERROR",
        parameters: [
          { name: "rate", value: "5" },       // Array index 0 has 'rate'
          { name: "notional", value: "100" }, // Array index 1 has 'notional'
        ],
      };

      const orderResult2 = validateErrorStructure(outOfOrderArrayBody, sampleDefinitions);
      expect(orderResult2.ok).toBe(false);
      if (!orderResult2.ok) {
        expect(orderResult2.code).toBe(ERROR_CODES.INVALID_PARAMETER_ORDER);
        expect(orderResult2.error).toMatch(/Parameter order mismatch/i);
      }

      // Verify that correct parameter order succeeds
      const correctOrderBody = {
        code: "ORDERED_CALC_ERROR",
        parameters: {
          notional: "100",
          rate: "5",
        },
      };
      const validResult = validateErrorStructure(correctOrderBody, sampleDefinitions);
      expect(validResult.ok).toBe(true);
    });

    it("6. detects unknown error code/definition and returns UNKNOWN_ERROR_DEFINITION", () => {
      const unknownCodeBody = {
        code: "NON_EXISTENT_CODE",
        parameters: {},
      };

      const result = validateErrorStructure(unknownCodeBody, sampleDefinitions);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.UNKNOWN_ERROR_DEFINITION);
        expect(result.error).toMatch(/Unknown or missing error definition code/i);
      }
    });

    it("8. detects non-object response bodies and returns PARAM_STRUCTURE_MISMATCH", () => {
      const invalidBodyResult = validateErrorStructure("string_body", sampleDefinitions);
      expect(invalidBodyResult.ok).toBe(false);
      if (!invalidBodyResult.ok) {
        expect(invalidBodyResult.code).toBe(ERROR_CODES.PARAM_STRUCTURE_MISMATCH);
        expect(invalidBodyResult.error).toMatch(/must be a non-null object/i);
      }
    });
  });

  describe("validateCalculationParameters & safeApplyConversionRateWithValidation", () => {
    it("7. handles calculation exception paths and reports detailed context", () => {
      const badCalcContext = {
        notional: "invalid_notional_string",
        rate: "100",
      };

      const result = validateCalculationParameters(badCalcContext);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.CALCULATION_EXCEPTION);
        expect(result.error).toMatch(/Calculation exception on notional/i);
        expect(result.details?.context).toEqual(badCalcContext);
      }

      const safeResult = safeApplyConversionRateWithValidation("100", "invalid_rate");
      expect(safeResult.ok).toBe(false);
      if (!safeResult.ok) {
        expect(safeResult.code).toBe(ERROR_CODES.CALCULATION_EXCEPTION);
        expect(safeResult.error).toMatch(/Calculation exception on rate/i);
      }
    });

    it("executes valid safe conversion calculation with full validation", () => {
      const result = safeApplyConversionRateWithValidation("500", "3");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1500n);
        expect(result.validatedParams).toEqual({ notional: "500", rate: "3" });
      }
    });
  });
});
