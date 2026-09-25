import {
  MAX_SAFE_DIGITS,
  ERROR_CODES,
  validateConversionRate,
  applyConversionRate,
  // Task 1 – rate limiting
  checkConversionRateLimit,
  resetConversionRateLimitBuckets,
  // Task 2 – CSV exporters
  exportConversionRatesToCsv,
  parseConversionRatesCsv,
  // Task 3 – split-sum assertions
  assertConversionSplitSum,
} from "../src/utils/conversion_rate_scraper.js";

// ---------------------------------------------------------------------------
// Existing overflow validation tests
// ---------------------------------------------------------------------------

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

    it("rejects negative rates with NEGATIVE_RATE", () => {
      const result = validateConversionRate("-1");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.NEGATIVE_RATE);
        expect(result.error).toMatch(/negative/i);
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

    it("rejects negative notional with NEGATIVE_RATE", () => {
      const result = applyConversionRate("-100", "2");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.NEGATIVE_RATE);
        expect(result.error).toMatch(/negative/i);
      }
    });

    it("rejects negative rate with NEGATIVE_RATE", () => {
      const result = applyConversionRate("100", "-2");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.NEGATIVE_RATE);
        expect(result.error).toMatch(/negative/i);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// TASK 1 – Rate limiting
// ---------------------------------------------------------------------------

describe("conversion_rate_scraper rate limiting", () => {
  beforeEach(() => {
    resetConversionRateLimitBuckets();
    // Use a tiny window so tests run quickly
    process.env.CONVERSION_RATE_WINDOW_MS = "10000";
    process.env.CONVERSION_RATE_MAX = "3";
  });

  afterEach(() => {
    resetConversionRateLimitBuckets();
    delete process.env.CONVERSION_RATE_WINDOW_MS;
    delete process.env.CONVERSION_RATE_MAX;
  });

  it("allows requests within the configured limit", () => {
    for (let i = 0; i < 3; i++) {
      const result = checkConversionRateLimit("client-a");
      expect(result.allowed).toBe(true);
    }
  });

  it("returns 429-style denial once the limit is exceeded", () => {
    for (let i = 0; i < 3; i++) {
      checkConversionRateLimit("client-b");
    }
    const result = checkConversionRateLimit("client-b");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe(ERROR_CODES.RATE_LIMIT_EXCEEDED);
      expect(result.remaining).toBe(0);
    }
  });

  it("decrements remaining count as requests are made", () => {
    const first = checkConversionRateLimit("client-c");
    expect(first.allowed).toBe(true);
    if (first.allowed) {
      expect(first.remaining).toBe(2);
    }

    const second = checkConversionRateLimit("client-c");
    expect(second.allowed).toBe(true);
    if (second.allowed) {
      expect(second.remaining).toBe(1);
    }
  });

  it("tracks separate buckets per client key", () => {
    for (let i = 0; i < 3; i++) {
      checkConversionRateLimit("client-d");
    }
    // client-d is now exhausted; client-e should still be allowed
    const result = checkConversionRateLimit("client-e");
    expect(result.allowed).toBe(true);
  });

  it("resets the bucket after the window expires", () => {
    // Use a 1 ms window so we can expire it immediately
    process.env.CONVERSION_RATE_WINDOW_MS = "1";
    resetConversionRateLimitBuckets();

    for (let i = 0; i < 3; i++) {
      checkConversionRateLimit("client-f");
    }
    // Exhaust
    expect(checkConversionRateLimit("client-f").allowed).toBe(false);

    // Wait for window to expire then try again
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const result = checkConversionRateLimit("client-f");
        expect(result.allowed).toBe(true);
        resolve();
      }, 5);
    });
  });

  it("exposes resetAt timestamp in the result", () => {
    const before = Date.now();
    const result = checkConversionRateLimit("client-g");
    const after = Date.now();
    expect(result.resetAt).toBeGreaterThanOrEqual(before);
    expect(result.resetAt).toBeLessThanOrEqual(after + 10_000 + 50);
  });

  it("respects CONVERSION_RATE_MAX env override", () => {
    process.env.CONVERSION_RATE_MAX = "1";
    resetConversionRateLimitBuckets();

    expect(checkConversionRateLimit("client-h").allowed).toBe(true);
    const denied = checkConversionRateLimit("client-h");
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.code).toBe(ERROR_CODES.RATE_LIMIT_EXCEEDED);
    }
  });
});

// ---------------------------------------------------------------------------
// TASK 2 – CSV format exporters
// ---------------------------------------------------------------------------

describe("conversion_rate_scraper CSV exporters", () => {
  describe("exportConversionRatesToCsv", () => {
    it("exports valid rows to CSV with correct headers and values", () => {
      const result = exportConversionRatesToCsv([
        { pair: "XLM/USDC", rate: "150" },
        { pair: "XLM/BTC", rate: 200n },
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const lines = result.csv.split("\r\n");
        expect(lines[0]).toBe("pair,rate");
        expect(lines[1]).toBe("XLM/USDC,150");
        expect(lines[2]).toBe("XLM/BTC,200");
      }
    });

    it("includes timestamp column when any row has a timestamp", () => {
      const result = exportConversionRatesToCsv([
        { pair: "XLM/USDC", rate: "100", timestamp: 1700000000 },
        { pair: "XLM/BTC", rate: "50" },
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const lines = result.csv.split("\r\n");
        expect(lines[0]).toBe("pair,rate,timestamp");
        expect(lines[1]).toBe("XLM/USDC,100,1700000000");
        expect(lines[2]).toBe("XLM/BTC,50,");
      }
    });

    it("escapes commas and double-quotes in pair names", () => {
      const result = exportConversionRatesToCsv([
        { pair: 'XLM,"USDC"', rate: "1" },
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The pair cell should be quoted and inner quotes doubled
        expect(result.csv).toContain('"XLM,""USDC"""');
      }
    });

    it("rejects an empty rows array", () => {
      const result = exportConversionRatesToCsv([]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_CSV_INPUT);
      }
    });

    it("rejects a row with a missing pair", () => {
      const result = exportConversionRatesToCsv([
        { pair: "  ", rate: "10" },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_CSV_INPUT);
      }
    });

    it("rejects a row with an invalid rate (non-integer)", () => {
      const result = exportConversionRatesToCsv([
        { pair: "XLM/USDC", rate: "1.5" as unknown as string },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_RATE);
      }
    });

    it("rejects a row with an excessive-digit rate", () => {
      const result = exportConversionRatesToCsv([
        { pair: "XLM/USDC", rate: "1" + "0".repeat(MAX_SAFE_DIGITS) },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

    it("rejects a row with a non-integer timestamp", () => {
      const result = exportConversionRatesToCsv([
        { pair: "XLM/USDC", rate: "100", timestamp: 1.5 },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_CSV_INPUT);
      }
    });
  });

  describe("parseConversionRatesCsv", () => {
    it("round-trips a CSV exported by exportConversionRatesToCsv", () => {
      const rows = [
        { pair: "XLM/USDC", rate: "150", timestamp: 1700000000 },
        { pair: "XLM/BTC", rate: "200", timestamp: 1700000001 },
      ];
      const exported = exportConversionRatesToCsv(rows);
      expect(exported.ok).toBe(true);
      if (!exported.ok) return;

      const parsed = parseConversionRatesCsv(exported.csv);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.rows).toHaveLength(2);
        expect(parsed.rows[0].pair).toBe("XLM/USDC");
        expect(parsed.rows[0].rate).toBe("150");
        expect(parsed.rows[0].timestamp).toBe(1700000000);
        expect(parsed.rows[1].pair).toBe("XLM/BTC");
        expect(parsed.rows[1].rate).toBe("200");
      }
    });

    it("parses a CSV without a timestamp column", () => {
      const csv = "pair,rate\r\nXLM/USDC,100\r\nXLM/BTC,200";
      const result = parseConversionRatesCsv(csv);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rows).toHaveLength(2);
        expect(result.rows[0].timestamp).toBeUndefined();
      }
    });

    it("rejects an empty string", () => {
      const result = parseConversionRatesCsv("");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_CSV_INPUT);
      }
    });

    it("rejects a CSV with a missing rate column in the header", () => {
      const result = parseConversionRatesCsv("pair\r\nXLM/USDC");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_CSV_INPUT);
      }
    });

    it("rejects a CSV with header only (no data rows)", () => {
      const result = parseConversionRatesCsv("pair,rate");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_CSV_INPUT);
      }
    });

    it("rejects a data row with an invalid rate", () => {
      const csv = "pair,rate\r\nXLM/USDC,abc";
      const result = parseConversionRatesCsv(csv);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_RATE);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// TASK 3 – Split-sum assertions
// ---------------------------------------------------------------------------

describe("conversion_rate_scraper split-sum assertions", () => {
  describe("assertConversionSplitSum", () => {
    it("confirms matching splits", () => {
      const result = assertConversionSplitSum(["30", "70"], "100");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.isMatch).toBe(true);
        expect(result.total).toBe(100n);
      }
    });

    it("returns isMatch=false when splits do not sum to base", () => {
      const result = assertConversionSplitSum(["30", "60"], "100");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.isMatch).toBe(false);
        expect(result.total).toBe(90n);
      }
    });

    it("accepts bigint and number inputs in splits", () => {
      const result = assertConversionSplitSum([50n, 50, "0"], 100);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.isMatch).toBe(true);
      }
    });

    it("rejects an empty splits array", () => {
      const result = assertConversionSplitSum([], "100");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects an invalid base amount", () => {
      const result = assertConversionSplitSum(["50"], "not-a-number");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects a split entry that exceeds the digit limit", () => {
      const excessive = "9".repeat(MAX_SAFE_DIGITS + 1);
      const result = assertConversionSplitSum([excessive], "100");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

    it("rejects when the running total would overflow the digit limit", () => {
      const large = "9".repeat(MAX_SAFE_DIGITS);
      const result = assertConversionSplitSum([large, large], large);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.PRODUCT_OVERFLOW);
      }
    });

    it("rejects a non-integer split value", () => {
      const result = assertConversionSplitSum(["50.5"], "100");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("handles a single split equal to the base", () => {
      const result = assertConversionSplitSum(["999"], "999");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.isMatch).toBe(true);
        expect(result.total).toBe(999n);
      }
    });

    it("detects over-allocation (splits > base)", () => {
      const result = assertConversionSplitSum(["60", "50"], "100");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.isMatch).toBe(false);
        expect(result.total).toBe(110n);
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
