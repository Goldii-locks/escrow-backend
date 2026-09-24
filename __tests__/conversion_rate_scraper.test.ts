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
      // Test out-of-order object keys for an ordered definition
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
