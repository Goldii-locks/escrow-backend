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

describe("conversion_rate_scraper overflow and error structure validation", () => {
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
          { name: "rate", type: "number", required: true },
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

    it("2. detects missing required parameters and returns PARAM_MISSING_PARAMETER", () => {
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

    it("3. detects unexpected extra parameters and returns PARAM_EXTRA_PARAMETER", () => {
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

    it("4. detects incorrect parameter types and returns PARAM_INVALID_TYPE without crashing", () => {
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

    it("5. validates ordered parameter structure/order and detects non-array or mismatch", () => {
      const nonArrayOrderedBody = {
        code: "ORDERED_CALC_ERROR",
        parameters: {
          notional: "100",
          rate: 5,
        },
      };

      const result = validateErrorStructure(nonArrayOrderedBody, sampleDefinitions);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_PARAMETER_ORDER);
        expect(result.error).toMatch(/Expected parameters array in order/i);
      }

      const validOrderedBody = {
        code: "ORDERED_CALC_ERROR",
        parameters: ["1000", 2],
      };
      const validResult = validateErrorStructure(validOrderedBody, sampleDefinitions);
      expect(validResult.ok).toBe(true);

      const wrongTypeOrderedBody = {
        code: "ORDERED_CALC_ERROR",
        parameters: [1000, "wrong_type"], // expected string, number
      };
      const wrongTypeResult = validateErrorStructure(wrongTypeOrderedBody, sampleDefinitions);
      expect(wrongTypeResult.ok).toBe(false);
      if (!wrongTypeResult.ok) {
        expect(wrongTypeResult.code).toBe(ERROR_CODES.INVALID_PARAMETER_TYPE);
      }
    });

    it("6. detects unknown error code/definition and returns PARAM_UNKNOWN_ERROR_DEFINITION", () => {
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

    it("handles non-object response bodies safely", () => {
      const invalidBodyResult = validateErrorStructure("string_body", sampleDefinitions);
      expect(invalidBodyResult.ok).toBe(false);
      if (!invalidBodyResult.ok) {
        expect(invalidBodyResult.code).toBe(ERROR_CODES.PARAM_STRUCTURE_MISMATCH);
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
