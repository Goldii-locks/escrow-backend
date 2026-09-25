import {
  MAX_SAFE_DIGITS,
  MAX_INTERMEDIATE_DIGITS,
  DEFAULT_TAX_SCALE,
  ERROR_CODES,
  validateTaxAmount,
  validateTaxRate,
  calculateTaxDeduction,
  estimateTaxDeduction,
  checkTaxEstimatorRateLimit,
  resetTaxEstimatorRateLimitBuckets,
  setTaxEstimatorRateLimitMax,
  validateDbPrecisionSchema,
  formatForDbStorage,
  formatColumnsForDbStorage,
  formatRawForDbStorage,
  formatHumanForDbStorage,
  configureFormatColumns,
  escapeTaxCsvField,
  formatTaxCsvRow,
  buildTaxDeductionCsvBlock,
  exportTaxDeductionsToCsv,
} from "../src/utils/tax_deduction_estimator.js";

describe("tax_deduction_estimator", () => {
  beforeEach(() => {
    resetTaxEstimatorRateLimitBuckets();
  });

  describe("input validation (validateTaxAmount & validateTaxRate)", () => {
    it("accepts valid positive integer inputs within digit limits", () => {
      expect(validateTaxAmount("10000").ok).toBe(true);
      expect(validateTaxAmount(5000n).ok).toBe(true);
      expect(validateTaxAmount(1000).ok).toBe(true);

      expect(validateTaxRate("500").ok).toBe(true);
      expect(validateTaxRate(250n).ok).toBe(true);
      expect(validateTaxRate(100).ok).toBe(true);
    });

    it("rejects negative amounts and rates", () => {
      const negativeAmount = validateTaxAmount("-1000");
      expect(negativeAmount.ok).toBe(false);
      if (!negativeAmount.ok) {
        expect(negativeAmount.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }

      const negativeBigInt = validateTaxAmount(-50n);
      expect(negativeBigInt.ok).toBe(false);

      const negativeRate = validateTaxRate("-5");
      expect(negativeRate.ok).toBe(false);
      if (!negativeRate.ok) {
        expect(negativeRate.code).toBe(ERROR_CODES.INVALID_TAX_RATE);
      }
    });

    it("rejects excessive digits exceeding MAX_SAFE_DIGITS", () => {
      const excessiveStr = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const amountRes = validateTaxAmount(excessiveStr);
      expect(amountRes.ok).toBe(false);
      if (!amountRes.ok) {
        expect(amountRes.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }

      const rateRes = validateTaxRate(excessiveStr);
      expect(rateRes.ok).toBe(false);
      if (!rateRes.ok) {
        expect(rateRes.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

    it("rejects non-integer numeric amounts and non-finite numbers", () => {
      const decimalRes = validateTaxAmount("123.45");
      expect(decimalRes.ok).toBe(false);
      if (!decimalRes.ok) {
        expect(decimalRes.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }

      const infinityRes = validateTaxAmount(Infinity);
      expect(infinityRes.ok).toBe(false);
    }
  );
  });

  describe("calculateTaxDeduction & estimateTaxDeduction math", () => {
    it("calculates estimated withholding tax accurately", () => {
      // 10000 gross, 500 rate (5%), scale 10000 -> 500 tax, 9500 net
      const result = calculateTaxDeduction("10000", "500");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.grossAmount).toBe(10000n);
        expect(result.taxRate).toBe(500n);
        expect(result.taxAmount).toBe(500n);
        expect(result.netAmount).toBe(9500n);
        expect(result.remainder).toBe(0n);
      }
    });

    it("handles non-zero remainder during division", () => {
      // 100 gross, 333 rate (3.33%), scale 10000 -> product 33300 / 10000 = 3 tax, 3300 remainder
      const result = estimateTaxDeduction(100, 333);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.taxAmount).toBe(3n);
        expect(result.netAmount).toBe(97n);
        expect(result.remainder).toBe(3300n);
      }
    });

    it("rejects tax rate exceeding tax scale", () => {
      const result = calculateTaxDeduction("1000", "15000", 10000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.TAX_EXCEEDS_AMOUNT);
      }
    });

    it("blocks when intermediate calculation product overflows MAX_INTERMEDIATE_DIGITS", () => {
      const large = "9".repeat(MAX_SAFE_DIGITS); // 15 digits
      const largeRate = "9".repeat(MAX_SAFE_DIGITS); // 15 digits
      const taxScale = "9".repeat(MAX_SAFE_DIGITS); // 15 digits
      const result = calculateTaxDeduction(large, largeRate, taxScale);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.CALCULATION_OVERFLOW);
      }
    });
  });

  describe("Issue #453: Rate limiting checks on tax_deduction_estimator calls", () => {
    it("permits calls up to the configured rate limit threshold", () => {
      setTaxEstimatorRateLimitMax(5);
      for (let i = 0; i < 5; i++) {
        const res = calculateTaxDeduction("1000", "500");
        expect(res.ok).toBe(true);
      }
    });

    it("returns 429 warning and RATE_LIMITED error when calls exceed threshold", () => {
      setTaxEstimatorRateLimitMax(3);
      calculateTaxDeduction("1000", "500");
      calculateTaxDeduction("1000", "500");
      calculateTaxDeduction("1000", "500");

      const overflowRes = calculateTaxDeduction("1000", "500");
      expect(overflowRes.ok).toBe(false);
      if (!overflowRes.ok) {
        expect(overflowRes.status).toBe(429);
        expect(overflowRes.code).toBe(ERROR_CODES.RATE_LIMITED);
        expect(overflowRes.error).toMatch(/rate limit exceeded/i);
      }
    });

    it("resets call count after bucket reset", () => {
      setTaxEstimatorRateLimitMax(2);
      calculateTaxDeduction("1000", "500");
      calculateTaxDeduction("1000", "500");
      expect(calculateTaxDeduction("1000", "500").ok).toBe(false);

      resetTaxEstimatorRateLimitBuckets();
      setTaxEstimatorRateLimitMax(2);
      expect(calculateTaxDeduction("1000", "500").ok).toBe(true);
    });
  });

  describe("Issue #452: Format columns for DB storage in tax_deduction_estimator", () => {
    it("formats calculated tax deduction to match database precision schemas with full precision", () => {
      // Gross: 100000000 (10.0000000 with 7 decimals), taxRate: 500 (5%), taxAmount: 5000000 (0.5000000)
      const res = formatForDbStorage("100000000", "500", 7);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const row = res.value;
        expect(row.gross_amount).toBe("10.0000000");
        expect(row.tax_amount).toBe("0.5000000");
        expect(row.net_amount).toBe("9.5000000");
        expect(row.tax_rate).toBe("500");
        expect(row.raw_amount).toBe("5000000");
        expect(row.formatted_amount).toBe("0.5000000");
        expect(row.scale).toBe(7);
        expect(row.decimals).toBe(7);

        // Alias camelCase attributes
        expect(row.grossAmount).toBe("10.0000000");
        expect(row.taxAmount).toBe("0.5000000");
        expect(row.netAmount).toBe("9.5000000");
      }
    });

    it("preserves full precision across custom scales and fixedScale=false", () => {
      const res = formatColumnsForDbStorage("1000", "500", 2, {
        scale: 2,
        fixedScale: false,
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        const row = res.row;
        expect(row.gross_amount).toBe("10");
        expect(row.tax_amount).toBe("0.5");
        expect(row.net_amount).toBe("9.5");
      }
    });

    it("supports custom column mapping in schema", () => {
      const res = formatForDbStorage("10000", "1000", 4, {
        columns: {
          grossAmount: "db_gross_val",
          taxAmount: "db_tax_val",
          netAmount: "db_net_val",
          taxRate: "db_rate_val",
          decimals: "db_scale_val",
        },
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        const row = res.value;
        expect(row.db_gross_val).toBe("1.0000");
        expect(row.db_tax_val).toBe("0.1000");
        expect(row.db_net_val).toBe("0.9000");
        expect(row.db_rate_val).toBe("1000");
        expect(row.db_scale_val).toBe(4);
      }
    });

    it("validates database precision schema options", () => {
      const invalidScale = validateDbPrecisionSchema({ scale: 20 });
      expect(invalidScale.ok).toBe(false);
      if (!invalidScale.ok) {
        expect(invalidScale.code).toBe(ERROR_CODES.INVALID_SCHEMA);
      }

      const invalidPrecision = validateDbPrecisionSchema({ precision: 0 });
      expect(invalidPrecision.ok).toBe(false);
      if (!invalidPrecision.ok) {
        expect(invalidPrecision.code).toBe(ERROR_CODES.INVALID_SCHEMA);
      }
    });

    it("works with configureFormatColumns helper factory", () => {
      const config = configureFormatColumns({ scale: 7 });
      const res = config.format("500000000", "500");
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.gross_amount).toBe("50.0000000");
        expect(res.value.tax_amount).toBe("2.5000000");
      }
    });
  });

  describe("Issue #454: CSV format exporters in tax_deduction_estimator", () => {
    it("escapes fields per RFC 4180", () => {
      expect(escapeTaxCsvField("plain")).toBe("plain");
      expect(escapeTaxCsvField("a,b")).toBe('"a,b"');
      expect(escapeTaxCsvField('say "hi"')).toBe('"say ""hi"""');
      expect(escapeTaxCsvField("line\nbreak")).toBe('"line\nbreak"');
      expect(escapeTaxCsvField(null)).toBe("");
      expect(escapeTaxCsvField(undefined)).toBe("");
      expect(escapeTaxCsvField(42n)).toBe("42");
      expect(escapeTaxCsvField("a;b", ";")).toBe('"a;b"');
      expect(formatTaxCsvRow(["x", "y,z", 1])).toBe('x,"y,z",1');
    });

    it("builds a table with header and computed rows", () => {
      const res = buildTaxDeductionCsvBlock([
        { grossAmount: "10000", taxRate: "500" },
        { grossAmount: 100, taxRate: 333 },
      ]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBe(
          "grossAmount,taxRate,taxAmount,netAmount,remainder\n" +
            "10000,500,500,9500,0\n" +
            "100,333,3,97,3300\n"
        );
        expect(res.rowCount).toBe(2);
        expect(res.columns).toEqual([
          "grossAmount",
          "taxRate",
          "taxAmount",
          "netAmount",
          "remainder",
        ]);
      }
    });

    it("includes an escaped label column when any record has a label", () => {
      const res = exportTaxDeductionsToCsv([
        { label: "Invoice, Q1", grossAmount: "10000", taxRate: "500" },
        { grossAmount: "2000", taxRate: "1000" },
      ]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.split("\n")).toEqual([
          "label,grossAmount,taxRate,taxAmount,netAmount,remainder",
          '"Invoice, Q1",10000,500,500,9500,0',
          ",2000,1000,200,1800,0",
          "",
        ]);
      }
    });

    it("applies scale, custom columns, headers, delimiter and CRLF", () => {
      const res = buildTaxDeductionCsvBlock(
        [{ grossAmount: "100000000", taxRate: "500" }],
        {
          scale: 7,
          columns: ["grossAmount", "taxAmount", "netAmount"],
          headers: ["Gross", "Tax", "Net"],
          delimiter: ";",
          lineEnding: "\r\n",
        }
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBe(
          "Gross;Tax;Net\r\n10.0000000;0.5000000;9.5000000\r\n"
        );
      }
    });

    it("omits the header row when includeHeader is false", () => {
      const res = buildTaxDeductionCsvBlock(
        [{ grossAmount: "1000", taxRate: "250", taxScale: "1000" }],
        { includeHeader: false }
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBe("1000,250,250,750,0\n");
      }
    });

    it("handles empty record arrays", () => {
      const allowed = buildTaxDeductionCsvBlock([]);
      expect(allowed.ok).toBe(true);
      if (allowed.ok) {
        expect(allowed.value).toBe(
          "grossAmount,taxRate,taxAmount,netAmount,remainder\n"
        );
        expect(allowed.rowCount).toBe(0);
      }

      const rejected = buildTaxDeductionCsvBlock([], { allowEmpty: false });
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.code).toBe(ERROR_CODES.INVALID_CSV_INPUT);
      }
    });

    it("rejects invalid options", () => {
      const records = [{ grossAmount: "1000", taxRate: "500" }];
      const cases = [
        buildTaxDeductionCsvBlock(records, { delimiter: "::" }),
        buildTaxDeductionCsvBlock(records, { delimiter: '"' }),
        buildTaxDeductionCsvBlock(records, { headers: ["only-one"] }),
        buildTaxDeductionCsvBlock(records, {
          columns: ["bogus" as unknown as "label"],
        }),
      ];
      for (const res of cases) {
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.code).toBe(ERROR_CODES.INVALID_CSV_INPUT);
        }
      }

      const badScale = buildTaxDeductionCsvBlock(records, { scale: 19 });
      expect(badScale.ok).toBe(false);
      if (!badScale.ok) {
        expect(badScale.code).toBe(ERROR_CODES.INVALID_SCHEMA);
      }
    });

    it("rejects non-array input and non-object records", () => {
      const notArray = buildTaxDeductionCsvBlock(
        "nope" as unknown as []
      );
      expect(notArray.ok).toBe(false);

      const badRecord = buildTaxDeductionCsvBlock([
        null as unknown as { grossAmount: string; taxRate: string },
      ]);
      expect(badRecord.ok).toBe(false);
      if (!badRecord.ok) {
        expect(badRecord.error).toMatch(/index 0/);
      }
    });

    it("propagates estimator validation errors with the record index", () => {
      const res = buildTaxDeductionCsvBlock([
        { grossAmount: "1000", taxRate: "500" },
        { grossAmount: "-5", taxRate: "500" },
      ]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_AMOUNT);
        expect(res.error).toMatch(/^record at index 1:/);
      }
    });
  });
});
