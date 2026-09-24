import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import {
  MAX_SAFE_DIGITS,
  MAX_TOKEN_DECIMALS,
  ERROR_CODES,
  validateDecimals,
  validateRawAmount,
  toRawUnits,
  toHumanUnits,
  formatForDbStorage,
  formatDbColumns,
  formatColumnsForDbStorage,
  formatToDbPrecision,
  formatRawForDbStorage,
  formatHumanForDbStorage,
  configureFormatColumns,
  validateDbPrecisionSchema,
  DbPrecisionSchema,
  escapeCsvField,
  formatRowToCsv,
  validateConversionRecord,
  buildCsvBlock,
  exportToCsv,
  formatToCsv,
  serializeToCsv,
  formatConversionTable,
  exportRawToHumanCsv,
  exportHumanToRawCsv,
  exportToCsvFile,
  serializeToCsvFile,
  serializeConversionRecordsToFile,
  writeCsvToFile,
  parseCsvLine,
  parseCsvBlock,
  readCsvFromFile,
  parseCsvFromFile,
  TokenConversionRecord,
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

    it("rejects negative amounts with DECIMALS_INVALID_AMOUNT", () => {
      const negBigInt = validateRawAmount(-1n);
      expect(negBigInt.ok).toBe(false);
      if (!negBigInt.ok) {
        expect(negBigInt.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }

      const negNum = validateRawAmount(-42);
      expect(negNum.ok).toBe(false);
      if (!negNum.ok) {
        expect(negNum.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }

      const negStr = validateRawAmount("-10");
      expect(negStr.ok).toBe(false);
      if (!negStr.ok) {
        expect(negStr.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }

      const negZero = validateRawAmount("-0");
      expect(negZero.ok).toBe(false);
      if (!negZero.ok) {
        expect(negZero.code).toBe(ERROR_CODES.INVALID_AMOUNT);
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

    it("rejects negative human amounts with DECIMALS_INVALID_AMOUNT", () => {
      const negNum = toRawUnits(-1.5, 7);
      expect(negNum.ok).toBe(false);
      if (!negNum.ok) {
        expect(negNum.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }

      const negStr = toRawUnits("-1.5", 7);
      expect(negStr.ok).toBe(false);
      if (!negStr.ok) {
        expect(negStr.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }

      const negZero = toRawUnits("-0", 2);
      expect(negZero.ok).toBe(false);
      if (!negZero.ok) {
        expect(negZero.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects negative decimals with DECIMALS_INVALID_DECIMALS", () => {
      const result = toRawUnits("1.5", -1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_DECIMALS);
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

    it("rejects negative raw amounts with DECIMALS_INVALID_AMOUNT", () => {
      const negBigInt = toHumanUnits(-15000000n, 7);
      expect(negBigInt.ok).toBe(false);
      if (!negBigInt.ok) {
        expect(negBigInt.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }

      const negNum = toHumanUnits(-42, 0);
      expect(negNum.ok).toBe(false);
      if (!negNum.ok) {
        expect(negNum.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }

      const negStr = toHumanUnits("-100", 2);
      expect(negStr.ok).toBe(false);
      if (!negStr.ok) {
        expect(negStr.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects negative decimals with DECIMALS_INVALID_DECIMALS", () => {
      const result = toHumanUnits(100n, -1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_DECIMALS);
      }
    });
  });

  describe("CSV escaping and row formatting", () => {
    describe("escapeCsvField", () => {
      it("returns empty string for null and undefined", () => {
        expect(escapeCsvField(null)).toBe("");
        expect(escapeCsvField(undefined)).toBe("");
      });

      it("returns string representation of numbers and bigints", () => {
        expect(escapeCsvField(42)).toBe("42");
        expect(escapeCsvField(10000000n)).toBe("10000000");
      });

      it("leaves plain strings unquoted", () => {
        expect(escapeCsvField("USDC")).toBe("USDC");
        expect(escapeCsvField("100.25")).toBe("100.25");
      });

      it("wraps strings containing delimiters in quotes", () => {
        expect(escapeCsvField("hello,world", ",")).toBe('"hello,world"');
        expect(escapeCsvField("hello;world", ";")).toBe('"hello;world"');
      });

      it("doubles internal double quotes and wraps in quotes", () => {
        expect(escapeCsvField('say "hello"')).toBe('"say ""hello"""');
      });

      it("wraps strings containing newlines in quotes", () => {
        expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
        expect(escapeCsvField("line1\r\nline2")).toBe('"line1\r\nline2"');
      });
    });

    describe("formatRowToCsv", () => {
      it("formats an array of values into a delimiter-separated line", () => {
        const row = formatRowToCsv(["USDC", 10000000n, 7, "1.0"]);
        expect(row).toBe("USDC,10000000,7,1.0");
      });

      it("respects custom delimiter in row formatting", () => {
        const row = formatRowToCsv(["XLM", 5000000n, 7, "0.5"], ";");
        expect(row).toBe("XLM;5000000;7;0.5");
      });
    });
  });

  describe("validateConversionRecord", () => {
    it("rejects non-object records", () => {
      const res = validateConversionRecord(null as any, 0);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_ROW);
      }
    });

    it("rejects invalid decimals", () => {
      const res = validateConversionRecord({ rawAmount: 100n, decimals: -1 }, 0);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_DECIMALS);
      }
    });

    it("rejects records missing both rawAmount and humanAmount", () => {
      const res = validateConversionRecord({ decimals: 7 }, 0);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_ROW);
      }
    });

    it("derives humanAmount when only rawAmount is provided", () => {
      const res = validateConversionRecord({ rawAmount: 15000000n, decimals: 7 });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.rawAmount).toBe(15000000n);
        expect(res.value.humanAmount).toBe("1.5");
        expect(res.value.decimals).toBe(7);
      }
    });

    it("derives rawAmount when only humanAmount is provided", () => {
      const res = validateConversionRecord({ humanAmount: "2.75", decimals: 2 });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.rawAmount).toBe(275n);
        expect(res.value.humanAmount).toBe("2.75");
        expect(res.value.decimals).toBe(2);
      }
    });

    it("accepts consistent rawAmount and humanAmount", () => {
      const res = validateConversionRecord({
        symbol: "USDC",
        rawAmount: 10000000n,
        humanAmount: "1.0",
        decimals: 7,
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.symbol).toBe("USDC");
        expect(res.value.rawAmount).toBe(10000000n);
        expect(res.value.humanAmount).toBe("1");
      }
    });

    it("rejects conflicting rawAmount and humanAmount", () => {
      const res = validateConversionRecord({
        rawAmount: 10000000n,
        humanAmount: "2.0",
        decimals: 7,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("supports snake_case fields raw_amount and human_amount", () => {
      const res = validateConversionRecord({
        raw_amount: 5000000n,
        decimals: 7,
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.humanAmount).toBe("0.5");
      }
    });

    it("preserves symbol, token, label, and custom properties", () => {
      const res = validateConversionRecord({
        symbol: "TEST",
        token: "CADB123",
        label: "escrow deposit",
        rawAmount: 100n,
        decimals: 2,
        customTag: "audit-01",
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.symbol).toBe("TEST");
        expect(res.value.token).toBe("CADB123");
        expect(res.value.label).toBe("escrow deposit");
        expect(res.value.customTag).toBe("audit-01");
      }
    });

    it("rejects excessive digits in rawAmount", () => {
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const res = validateConversionRecord({ rawAmount: tooBig, decimals: 7 });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

    it("rejects excessive fractional digits in humanAmount", () => {
      const res = validateConversionRecord({ humanAmount: "1.12345", decimals: 2 });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });
  });

  describe("CSV block builders and format exporters", () => {
    it("rejects non-array records", () => {
      const res = buildCsvBlock(null as any);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_INPUT);
      }
    });

    it("builds a header-only CSV for empty records by default", () => {
      const res = buildCsvBlock([]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBe("rawAmount,decimals,humanAmount\n");
        expect(res.rowCount).toBe(0);
      }
    });

    it("rejects empty records if allowEmpty is false", () => {
      const res = buildCsvBlock([], { allowEmpty: false });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.EMPTY_DATA);
      }
    });

    it("builds correct CSV formatting block for simple records without symbols", () => {
      const records: TokenConversionRecord[] = [
        { rawAmount: 15000000n, decimals: 7 },
        { rawAmount: 10025n, decimals: 2 },
      ];
      const res = buildCsvBlock(records);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.rowCount).toBe(2);
        expect(res.columns).toEqual(["rawAmount", "decimals", "humanAmount"]);
        const expected = [
          "rawAmount,decimals,humanAmount",
          "15000000,7,1.5",
          "10025,2,100.25\n",
        ].join("\n");
        expect(res.value).toBe(expected);
      }
    });

    it("includes symbol column when symbol is provided in records", () => {
      const records: TokenConversionRecord[] = [
        { symbol: "USDC", rawAmount: 10000000n, decimals: 7 },
        { symbol: "XLM", humanAmount: "50.0", decimals: 7 },
      ];
      const res = exportToCsv(records);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.columns).toEqual(["symbol", "rawAmount", "decimals", "humanAmount"]);
        const lines = res.value.trim().split("\n");
        expect(lines[0]).toBe("symbol,rawAmount,decimals,humanAmount");
        expect(lines[1]).toBe("USDC,10000000,7,1");
        expect(lines[2]).toBe("XLM,500000000,7,50");
      }
    });

    it("includes token column when token is present without symbol", () => {
      const records: TokenConversionRecord[] = [
        { token: "CADB123", rawAmount: 100n, decimals: 2 },
      ];
      const res = formatToCsv(records);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.columns).toEqual(["token", "rawAmount", "decimals", "humanAmount"]);
        expect(res.value).toContain("CADB123,100,2,1");
      }
    });

    it("supports custom columns and custom headers", () => {
      const records: TokenConversionRecord[] = [
        { symbol: "USDC", rawAmount: 20000000n, decimals: 7, humanAmount: "2.0" },
      ];
      const res = serializeToCsv(records, {
        columns: ["symbol", "humanAmount", "rawAmount"],
        headers: ["Token Symbol", "Formatted Value", "Raw On-Chain Amount"],
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        const lines = res.value.trim().split("\n");
        expect(lines[0]).toBe("Token Symbol,Formatted Value,Raw On-Chain Amount");
        expect(lines[1]).toBe("USDC,2,20000000");
      }
    });

    it("supports custom delimiter and line ending", () => {
      const records: TokenConversionRecord[] = [
        { rawAmount: 1000n, decimals: 3 },
      ];
      const res = formatConversionTable(records, {
        delimiter: ";",
        lineEnding: "\r\n",
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBe("rawAmount;decimals;humanAmount\r\n1000;3;1\r\n");
      }
    });

    it("omits header row when includeHeader is false", () => {
      const records: TokenConversionRecord[] = [
        { rawAmount: 500n, decimals: 2 },
      ];
      const res = buildCsvBlock(records, { includeHeader: false });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBe("500,2,5\n");
      }
    });

    it("fails fast if any record in the batch violates validation rules", () => {
      const records: TokenConversionRecord[] = [
        { rawAmount: 100n, decimals: 2 },
        { rawAmount: 200n, decimals: 99 }, // Invalid decimals
      ];
      const res = buildCsvBlock(records);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_DECIMALS);
      }
    });

    it("properly escapes fields with commas and quotes in CSV output", () => {
      const records: TokenConversionRecord[] = [
        {
          symbol: 'USD, Coin "Gold"',
          rawAmount: 10000000n,
          decimals: 7,
        },
      ];
      const res = buildCsvBlock(records);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toContain('"USD, Coin ""Gold"""');
      }
    });

    describe("specialized exporters", () => {
      it("exportRawToHumanCsv exports raw amounts to CSV block", () => {
        const res = exportRawToHumanCsv([
          { rawAmount: 30000000n, decimals: 7, symbol: "XLM" },
        ]);
        expect(res.ok).toBe(true);
        if (res.ok) {
          expect(res.value).toContain("XLM,30000000,7,3");
        }
      });

      it("exportHumanToRawCsv exports human amounts to CSV block", () => {
        const res = exportHumanToRawCsv([
          { humanAmount: "4.5", decimals: 6, symbol: "USDC" },
        ]);
        expect(res.ok).toBe(true);
        if (res.ok) {
          expect(res.value).toContain("USDC,4500000,6,4.5");
        }
      });
    });
  });

  describe("file serialization helper functions", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow-decimals-csv-test-"));
    });

    afterEach(() => {
      try {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      } catch {
        // ignore cleanup errors in test
      }
    });

    it("rejects empty or invalid filePath", () => {
      const res = exportToCsvFile("", []);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_INPUT);
      }
    });

    it("rejects non-array non-string data", () => {
      const filePath = path.join(tempDir, "invalid.csv");
      const res = exportToCsvFile(filePath, 123 as any);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_INPUT);
      }
    });

    it("serializes conversion records to a newly created file and verifies table output", () => {
      const filePath = path.join(tempDir, "nested", "conversions.csv");
      const records: TokenConversionRecord[] = [
        { symbol: "USDC", rawAmount: 15000000n, decimals: 7 },
        { symbol: "XLM", rawAmount: 25000000n, decimals: 7 },
      ];

      const res = exportToCsvFile(filePath, records);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.filePath).toBe(filePath);
        expect(res.rowCount).toBe(2);
        expect(res.bytesWritten).toBeGreaterThan(0);
      }

      // Validation check: Assert created files contain correct table outputs
      expect(fs.existsSync(filePath)).toBe(true);
      const fileContent = fs.readFileSync(filePath, "utf-8");
      const expectedLines = [
        "symbol,rawAmount,decimals,humanAmount",
        "USDC,15000000,7,1.5",
        "XLM,25000000,7,2.5",
      ];
      expect(fileContent.trim().split(/\r?\n/)).toEqual(expectedLines);
    });

    it("serializes pre-built CSV string directly to file", () => {
      const filePath = path.join(tempDir, "direct.csv");
      const csvString = "rawAmount,decimals,humanAmount\n100,2,1\n200,2,2\n";

      const res = writeCsvToFile(filePath, csvString);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.rowCount).toBe(2);
      }

      expect(fs.existsSync(filePath)).toBe(true);
      const readContent = fs.readFileSync(filePath, "utf-8");
      expect(readContent).toBe(csvString);
    });

    it("serializeToCsvFile and serializeConversionRecordsToFile alias work identically", () => {
      const filePath1 = path.join(tempDir, "alias1.csv");
      const filePath2 = path.join(tempDir, "alias2.csv");
      const records = [{ rawAmount: 999n, decimals: 0 }];

      const res1 = serializeToCsvFile(filePath1, records);
      const res2 = serializeConversionRecordsToFile(filePath2, records);

      expect(res1.ok).toBe(true);
      expect(res2.ok).toBe(true);
      expect(fs.readFileSync(filePath1, "utf-8")).toBe(fs.readFileSync(filePath2, "utf-8"));
    });

    it("propagates conversion validation errors and does not write file", () => {
      const filePath = path.join(tempDir, "failed.csv");
      const invalidRecords = [{ rawAmount: 100n, decimals: -5 }];

      const res = exportToCsvFile(filePath, invalidRecords);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_DECIMALS);
      }
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("handles filesystem write failures gracefully with FILE_WRITE_ERROR", () => {
      // Use an invalid filename with null character
      const invalidPath = path.join(tempDir, "bad\0file.csv");
      const res = exportToCsvFile(invalidPath, "content");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.FILE_WRITE_ERROR);
      }
    });

    describe("CSV reading and deserialization round-trip", () => {
      it("parses CSV line with quotes and escaped characters", () => {
        const line = 'USDC,"15,000,000",7,"say ""hello"""';
        const fields = parseCsvLine(line);
        expect(fields).toEqual(["USDC", "15,000,000", "7", 'say "hello"']);
      });

      it("parses CSV block back into conversion records", () => {
        const csv = [
          "symbol,rawAmount,decimals,humanAmount",
          "USDC,10000000,7,1",
          "XLM,20000000,7,2",
        ].join("\n");

        const parsed = parseCsvBlock(csv);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
          expect(parsed.rowCount).toBe(2);
          expect(parsed.records[0].symbol).toBe("USDC");
          expect(parsed.records[0].rawAmount).toBe(10000000n);
          expect(parsed.records[0].humanAmount).toBe("1");
          expect(parsed.records[0].decimals).toBe(7);
        }
      });

      it("reads CSV file from disk and parses correctly", () => {
        const filePath = path.join(tempDir, "read_test.csv");
        const originalRecords: TokenConversionRecord[] = [
          { symbol: "USDC", rawAmount: 50000000n, decimals: 7 },
          { symbol: "BTC", rawAmount: 100000000n, decimals: 8 },
        ];

        const exportRes = exportToCsvFile(filePath, originalRecords);
        expect(exportRes.ok).toBe(true);

        const readRes = readCsvFromFile(filePath);
        expect(readRes.ok).toBe(true);
        if (readRes.ok) {
          expect(readRes.rowCount).toBe(2);
          expect(readRes.records[0].symbol).toBe("USDC");
          expect(readRes.records[0].rawAmount).toBe(50000000n);
          expect(readRes.records[0].humanAmount).toBe("5");
          expect(readRes.records[1].symbol).toBe("BTC");
          expect(readRes.records[1].rawAmount).toBe(100000000n);
          expect(readRes.records[1].humanAmount).toBe("1");
        }
      });

      it("parseCsvFromFile alias functions identically", () => {
        const filePath = path.join(tempDir, "read_alias.csv");
        exportToCsvFile(filePath, [{ rawAmount: 100n, decimals: 2 }]);
        const res = parseCsvFromFile(filePath);
        expect(res.ok).toBe(true);
        if (res.ok) {
          expect(res.rowCount).toBe(1);
        }
      });

      it("returns FILE_READ_ERROR when file does not exist", () => {
        const res = readCsvFromFile(path.join(tempDir, "non_existent.csv"));
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.code).toBe(ERROR_CODES.FILE_READ_ERROR);
        }
      });
    });
  });
});

describe("token_decimals_converter mathematical verification with detailed numeric test data", () => {
  interface NumericTestCase {
    raw: bigint;
    decimals: number;
    expectedHuman: string;
    description: string;
  }

  // Verified calculations for Stellar (SEP-41 / XLM) 7-decimal conversions
  describe("Stellar native (decimals = 7 / stroop) conversion math", () => {
    const stroopPowersOf10: NumericTestCase[] = [
      { raw: 1n, decimals: 7, expectedHuman: "0.0000001", description: "1 stroop (minimum unit: 10^-7 XLM)" },
      { raw: 10n, decimals: 7, expectedHuman: "0.000001", description: "10 stroops (10^-6 XLM)" },
      { raw: 100n, decimals: 7, expectedHuman: "0.00001", description: "100 stroops (10^-5 XLM)" },
      { raw: 1000n, decimals: 7, expectedHuman: "0.0001", description: "1,000 stroops (10^-4 XLM)" },
      { raw: 10000n, decimals: 7, expectedHuman: "0.001", description: "10,000 stroops (10^-3 XLM)" },
      { raw: 100000n, decimals: 7, expectedHuman: "0.01", description: "100,000 stroops (10^-2 XLM)" },
      { raw: 1000000n, decimals: 7, expectedHuman: "0.1", description: "1,000,000 stroops (0.1 XLM)" },
      { raw: 10000000n, decimals: 7, expectedHuman: "1", description: "10,000,000 stroops (1 whole XLM)" },
      { raw: 100000000n, decimals: 7, expectedHuman: "10", description: "100,000,000 stroops (10 XLM)" },
      { raw: 1000000000n, decimals: 7, expectedHuman: "100", description: "1,000,000,000 stroops (100 XLM)" },
      { raw: 10000000000n, decimals: 7, expectedHuman: "1000", description: "10,000,000,000 stroops (1,000 XLM)" },
      { raw: 100000000000n, decimals: 7, expectedHuman: "10000", description: "100,000,000,000 stroops (10,000 XLM)" },
      { raw: 1000000000000n, decimals: 7, expectedHuman: "100000", description: "1,000,000,000,000 stroops (100,000 XLM)" },
      { raw: 10000000000000n, decimals: 7, expectedHuman: "1000000", description: "10,000,000,000,000 stroops (1,000,000 XLM)" },
      { raw: 100000000000000n, decimals: 7, expectedHuman: "10000000", description: "100,000,000,000,000 stroops (10,000,000 XLM, 15 digits)" },
    ];

    stroopPowersOf10.forEach(({ raw, decimals, expectedHuman, description }) => {
      it(`converts ${description}: raw ${raw} -> human "${expectedHuman}"`, () => {
        const humanResult = toHumanUnits(raw, decimals);
        expect(humanResult.ok).toBe(true);
        if (humanResult.ok) {
          expect(humanResult.value).toBe(expectedHuman);
        }

        const rawResult = toRawUnits(expectedHuman, decimals);
        expect(rawResult.ok).toBe(true);
        if (rawResult.ok) {
          expect(rawResult.value).toBe(raw);
        }
      });
    });

    const fractionalStroopCases: NumericTestCase[] = [
      { raw: 15000000n, decimals: 7, expectedHuman: "1.5", description: "1.5 XLM" },
      { raw: 25750000n, decimals: 7, expectedHuman: "2.575", description: "2.575 XLM" },
      { raw: 10500000n, decimals: 7, expectedHuman: "1.05", description: "1.05 XLM (single trailing zero)" },
      { raw: 10050000n, decimals: 7, expectedHuman: "1.005", description: "1.005 XLM (two trailing zeros)" },
      { raw: 10005000n, decimals: 7, expectedHuman: "1.0005", description: "1.0005 XLM (three trailing zeros)" },
      { raw: 10000500n, decimals: 7, expectedHuman: "1.00005", description: "1.00005 XLM (four trailing zeros)" },
      { raw: 10000050n, decimals: 7, expectedHuman: "1.000005", description: "1.000005 XLM (five trailing zeros)" },
      { raw: 10000005n, decimals: 7, expectedHuman: "1.0000005", description: "1.0000005 XLM (no trailing zeros)" },
      { raw: 1234567n, decimals: 7, expectedHuman: "0.1234567", description: "Full 7-decimal fractional precision without integer part" },
      { raw: 1234567890123n, decimals: 7, expectedHuman: "123456.7890123", description: "Multi-digit whole and 7-decimal fractional" },
      { raw: 987654321098765n, decimals: 7, expectedHuman: "98765432.1098765", description: "Max 15-digit safe value with 7 decimals" },
    ];

    fractionalStroopCases.forEach(({ raw, decimals, expectedHuman, description }) => {
      it(`verifies fractional conversion for ${description}: ${raw} <-> "${expectedHuman}"`, () => {
        const humanResult = toHumanUnits(raw, decimals);
        expect(humanResult.ok).toBe(true);
        if (humanResult.ok) {
          expect(humanResult.value).toBe(expectedHuman);
        }

        const rawResult = toRawUnits(expectedHuman, decimals);
        expect(rawResult.ok).toBe(true);
        if (rawResult.ok) {
          expect(rawResult.value).toBe(raw);
        }
      });
    });
  });

  // Verified calculations across common token decimal scales
  describe("Multi-asset decimals conversion matrix", () => {
    describe("Decimals = 0 (Indivisible tokens, NFTs)", () => {
      const cases: NumericTestCase[] = [
        { raw: 0n, decimals: 0, expectedHuman: "0", description: "zero tokens" },
        { raw: 1n, decimals: 0, expectedHuman: "1", description: "single indivisible unit" },
        { raw: 42n, decimals: 0, expectedHuman: "42", description: "two-digit integer" },
        { raw: 1000000n, decimals: 0, expectedHuman: "1000000", description: "one million units" },
        { raw: 999999999999999n, decimals: 0, expectedHuman: "999999999999999", description: "15 nines (max safe)" },
      ];

      cases.forEach(({ raw, decimals, expectedHuman, description }) => {
        it(`accurately converts decimals=0 ${description}`, () => {
          const human = toHumanUnits(raw, decimals);
          expect(human.ok).toBe(true);
          if (human.ok) {
            expect(human.value).toBe(expectedHuman);
          }

          const backToRaw = toRawUnits(expectedHuman, decimals);
          expect(backToRaw.ok).toBe(true);
          if (backToRaw.ok) {
            expect(backToRaw.value).toBe(raw);
          }
        });
      });
    });

    describe("Decimals = 2 (Fiat currency / cents)", () => {
      const cases: NumericTestCase[] = [
        { raw: 1n, decimals: 2, expectedHuman: "0.01", description: "1 cent" },
        { raw: 10n, decimals: 2, expectedHuman: "0.1", description: "10 cents (0.1)" },
        { raw: 50n, decimals: 2, expectedHuman: "0.5", description: "50 cents (0.5)" },
        { raw: 99n, decimals: 2, expectedHuman: "0.99", description: "99 cents" },
        { raw: 100n, decimals: 2, expectedHuman: "1", description: "1 dollar / unit" },
        { raw: 105n, decimals: 2, expectedHuman: "1.05", description: "1 dollar and 5 cents" },
        { raw: 1250n, decimals: 2, expectedHuman: "12.5", description: "12.50 dollars" },
        { raw: 1299n, decimals: 2, expectedHuman: "12.99", description: "12.99 dollars" },
        { raw: 50000n, decimals: 2, expectedHuman: "500", description: "500 dollars exact" },
        { raw: 999999999999999n, decimals: 2, expectedHuman: "9999999999999.99", description: "15 digits cent amount" },
      ];

      cases.forEach(({ raw, decimals, expectedHuman, description }) => {
        it(`accurately converts decimals=2 ${description}`, () => {
          const human = toHumanUnits(raw, decimals);
          expect(human.ok).toBe(true);
          if (human.ok) {
            expect(human.value).toBe(expectedHuman);
          }

          const backToRaw = toRawUnits(expectedHuman, decimals);
          expect(backToRaw.ok).toBe(true);
          if (backToRaw.ok) {
            expect(backToRaw.value).toBe(raw);
          }
        });
      });
    });

    describe("Decimals = 6 (USDC, USDT, EURC micro-units)", () => {
      const cases: NumericTestCase[] = [
        { raw: 1n, decimals: 6, expectedHuman: "0.000001", description: "1 micro-unit (0.000001)" },
        { raw: 10n, decimals: 6, expectedHuman: "0.00001", description: "10 micro-units" },
        { raw: 100n, decimals: 6, expectedHuman: "0.0001", description: "100 micro-units" },
        { raw: 1000n, decimals: 6, expectedHuman: "0.001", description: "1,000 micro-units" },
        { raw: 10000n, decimals: 6, expectedHuman: "0.01", description: "1 cent of USDC" },
        { raw: 100000n, decimals: 6, expectedHuman: "0.1", description: "10 cents of USDC" },
        { raw: 500000n, decimals: 6, expectedHuman: "0.5", description: "50 cents of USDC" },
        { raw: 1000000n, decimals: 6, expectedHuman: "1", description: "1 USDC" },
        { raw: 1234567n, decimals: 6, expectedHuman: "1.234567", description: "1.234567 USDC" },
        { raw: 1000000000n, decimals: 6, expectedHuman: "1000", description: "1,000 USDC" },
        { raw: 999999999999999n, decimals: 6, expectedHuman: "999999999.999999", description: "15 digits USDC" },
      ];

      cases.forEach(({ raw, decimals, expectedHuman, description }) => {
        it(`accurately converts decimals=6 ${description}`, () => {
          const human = toHumanUnits(raw, decimals);
          expect(human.ok).toBe(true);
          if (human.ok) {
            expect(human.value).toBe(expectedHuman);
          }

          const backToRaw = toRawUnits(expectedHuman, decimals);
          expect(backToRaw.ok).toBe(true);
          if (backToRaw.ok) {
            expect(backToRaw.value).toBe(raw);
          }
        });
      });
    });

    describe("Decimals = 8 (Bitcoin satoshis equivalent)", () => {
      const cases: NumericTestCase[] = [
        { raw: 1n, decimals: 8, expectedHuman: "0.00000001", description: "1 satoshi" },
        { raw: 50000000n, decimals: 8, expectedHuman: "0.5", description: "0.5 BTC" },
        { raw: 100000000n, decimals: 8, expectedHuman: "1", description: "1 BTC" },
        { raw: 12345678n, decimals: 8, expectedHuman: "0.12345678", description: "0.12345678 BTC" },
        { raw: 12345678912345n, decimals: 8, expectedHuman: "123456.78912345", description: "14 digits BTC" },
        { raw: 999999999999999n, decimals: 8, expectedHuman: "9999999.99999999", description: "15 digits BTC" },
      ];

      cases.forEach(({ raw, decimals, expectedHuman, description }) => {
        it(`accurately converts decimals=8 ${description}`, () => {
          const human = toHumanUnits(raw, decimals);
          expect(human.ok).toBe(true);
          if (human.ok) {
            expect(human.value).toBe(expectedHuman);
          }

          const backToRaw = toRawUnits(expectedHuman, decimals);
          expect(backToRaw.ok).toBe(true);
          if (backToRaw.ok) {
            expect(backToRaw.value).toBe(raw);
          }
        });
      });
    });

    describe("Decimals = 9 (Gwei / nano-units)", () => {
      const cases: NumericTestCase[] = [
        { raw: 1n, decimals: 9, expectedHuman: "0.000000001", description: "1 nano-unit" },
        { raw: 1000000000n, decimals: 9, expectedHuman: "1", description: "1 whole unit" },
        { raw: 123456789n, decimals: 9, expectedHuman: "0.123456789", description: "fractional nano-unit" },
        { raw: 123456789000n, decimals: 9, expectedHuman: "123.456789", description: "trimmed trailing zeros" },
        { raw: 987654321098765n, decimals: 9, expectedHuman: "987654.321098765", description: "15 digits nano-unit" },
      ];

      cases.forEach(({ raw, decimals, expectedHuman, description }) => {
        it(`accurately converts decimals=9 ${description}`, () => {
          const human = toHumanUnits(raw, decimals);
          expect(human.ok).toBe(true);
          if (human.ok) {
            expect(human.value).toBe(expectedHuman);
          }

          const backToRaw = toRawUnits(expectedHuman, decimals);
          expect(backToRaw.ok).toBe(true);
          if (backToRaw.ok) {
            expect(backToRaw.value).toBe(raw);
          }
        });
      });
    });

    describe("Decimals = 12 (pico-units)", () => {
      const cases: NumericTestCase[] = [
        { raw: 1n, decimals: 12, expectedHuman: "0.000000000001", description: "1 pico-unit" },
        { raw: 1000000000000n, decimals: 12, expectedHuman: "1", description: "1 whole unit" },
        { raw: 1500000000000n, decimals: 12, expectedHuman: "1.5", description: "1.5 units" },
        { raw: 1234567890123n, decimals: 12, expectedHuman: "1.234567890123", description: "full 12 fractional digits" },
        { raw: 999999999999999n, decimals: 12, expectedHuman: "999.999999999999", description: "15 digits pico-units" },
      ];

      cases.forEach(({ raw, decimals, expectedHuman, description }) => {
        it(`accurately converts decimals=12 ${description}`, () => {
          const human = toHumanUnits(raw, decimals);
          expect(human.ok).toBe(true);
          if (human.ok) {
            expect(human.value).toBe(expectedHuman);
          }

          const backToRaw = toRawUnits(expectedHuman, decimals);
          expect(backToRaw.ok).toBe(true);
          if (backToRaw.ok) {
            expect(backToRaw.value).toBe(raw);
          }
        });
      });
    });

    describe("Decimals = 18 (EVM wei scale)", () => {
      const cases: NumericTestCase[] = [
        { raw: 1n, decimals: 18, expectedHuman: "0.000000000000000001", description: "1 wei (10^-18)" },
        { raw: 1000n, decimals: 18, expectedHuman: "0.000000000000001", description: "1,000 wei" },
        { raw: 100000000000000n, decimals: 18, expectedHuman: "0.0001", description: "10^14 wei (0.0001 unit, 15 digits)" },
        { raw: 999999999999999n, decimals: 18, expectedHuman: "0.000999999999999999", description: "15 digits max safe in 18 decimals" },
      ];

      cases.forEach(({ raw, decimals, expectedHuman, description }) => {
        it(`accurately converts decimals=18 ${description}`, () => {
          const human = toHumanUnits(raw, decimals);
          expect(human.ok).toBe(true);
          if (human.ok) {
            expect(human.value).toBe(expectedHuman);
          }

          const backToRaw = toRawUnits(expectedHuman, decimals);
          expect(backToRaw.ok).toBe(true);
          if (backToRaw.ok) {
            expect(backToRaw.value).toBe(raw);
          }
        });
      });
    });
  });

  // Zero and negative value rejection calculations
  describe("Zero value and negative parameter rejection numeric calculations", () => {
    const decimalScales = [0, 1, 2, 6, 7, 8, 9, 12, 18];

    describe("zero value conversions across all decimal scales", () => {
      decimalScales.forEach((dec) => {
        it(`converts zero to "0" for decimals=${dec}`, () => {
          expect(toHumanUnits(0n, dec)).toEqual({ ok: true, value: "0" });
          expect(toHumanUnits(0, dec)).toEqual({ ok: true, value: "0" });
          expect(toHumanUnits("0", dec)).toEqual({ ok: true, value: "0" });

          expect(toRawUnits("0", dec)).toEqual({ ok: true, value: 0n });

          if (dec > 0) {
            expect(toRawUnits("0.0", dec)).toEqual({ ok: true, value: 0n });
          } else {
            // For decimals=0, any fractional point constitutes invalid fractional precision
            const result = toRawUnits("0.0", 0);
            expect(result.ok).toBe(false);
            if (!result.ok) {
              expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
            }
          }

          // Negative zero representations are rejected as negative parameters
          expect(toHumanUnits("-0", dec).ok).toBe(false);
          expect(toRawUnits("-0", dec).ok).toBe(false);
          expect(toRawUnits("-0.0", dec).ok).toBe(false);
        });
      });
    });

    describe("negative parameter rejection across diverse amounts and decimal scales", () => {
      const negativeAmounts = [
        -1n,
        -10000000n,
        -15000000n,
        -105n,
        -42n,
        -999999999999999n,
      ];
      const negativeHumanAmounts = [
        "-0.0000001",
        "-1",
        "-1.5",
        "-105.50",
        "-42",
        "-99999999.9999999",
        -1.5,
        -42,
      ];
      const negativeDecimals = [-1, -5, -18];

      negativeAmounts.forEach((raw) => {
        it(`rejects negative raw amount ${raw} in validateRawAmount`, () => {
          const res = validateRawAmount(raw);
          expect(res.ok).toBe(false);
          if (!res.ok) {
            expect(res.code).toBe(ERROR_CODES.INVALID_AMOUNT);
          }
        });

        it(`rejects negative raw amount ${raw} in toHumanUnits`, () => {
          const res = toHumanUnits(raw, 7);
          expect(res.ok).toBe(false);
          if (!res.ok) {
            expect(res.code).toBe(ERROR_CODES.INVALID_AMOUNT);
          }
        });
      });

      negativeHumanAmounts.forEach((human) => {
        it(`rejects negative human amount ${human} in toRawUnits`, () => {
          const res = toRawUnits(human, 7);
          expect(res.ok).toBe(false);
          if (!res.ok) {
            expect(res.code).toBe(ERROR_CODES.INVALID_AMOUNT);
          }
        });
      });

      negativeDecimals.forEach((dec) => {
        it(`rejects negative decimals ${dec} in validateDecimals`, () => {
          const res = validateDecimals(dec);
          expect(res.ok).toBe(false);
          if (!res.ok) {
            expect(res.code).toBe(ERROR_CODES.INVALID_DECIMALS);
          }
        });

        it(`rejects negative decimals ${dec} in toRawUnits`, () => {
          const res = toRawUnits("100", dec);
          expect(res.ok).toBe(false);
          if (!res.ok) {
            expect(res.code).toBe(ERROR_CODES.INVALID_DECIMALS);
          }
        });

        it(`rejects negative decimals ${dec} in toHumanUnits`, () => {
          const res = toHumanUnits(100n, dec);
          expect(res.ok).toBe(false);
          if (!res.ok) {
            expect(res.code).toBe(ERROR_CODES.INVALID_DECIMALS);
          }
        });
      });
    });
  });

  // Maximum safe digit limit (MAX_SAFE_DIGITS = 15) boundary numeric tests
  describe("MAX_SAFE_DIGITS (15) boundary numeric verification", () => {
    const boundaryCases = [
      { raw: 999999999999999n, decimals: 0, expected: "999999999999999" },
      { raw: 999999999999999n, decimals: 1, expected: "99999999999999.9" },
      { raw: 999999999999999n, decimals: 7, expected: "99999999.9999999" },
      { raw: 999999999999999n, decimals: 14, expected: "9.99999999999999" },
      { raw: 999999999999999n, decimals: 15, expected: "0.999999999999999" },
      { raw: 999999999999999n, decimals: 18, expected: "0.000999999999999999" },
      { raw: 100000000000000n, decimals: 0, expected: "100000000000000" },
      { raw: 100000000000000n, decimals: 2, expected: "1000000000000" },
      { raw: 100000000000000n, decimals: 7, expected: "10000000" },
      { raw: 100000000000000n, decimals: 14, expected: "1" },
      { raw: 100000000000000n, decimals: 15, expected: "0.1" },
      { raw: 100000000000000n, decimals: 18, expected: "0.0001" },
    ];

    boundaryCases.forEach(({ raw, decimals, expected }) => {
      it(`preserves exact boundary numeric precision for raw ${raw} at decimals=${decimals}`, () => {
        const human = toHumanUnits(raw, decimals);
        expect(human.ok).toBe(true);
        if (human.ok) {
          expect(human.value).toBe(expected);
        }

        const backToRaw = toRawUnits(expected, decimals);
        expect(backToRaw.ok).toBe(true);
        if (backToRaw.ok) {
          expect(backToRaw.value).toBe(raw);
        }
      });
    });
  });

  // Direct mathematical unit division property comparison: quotient and remainder
  describe("Direct BigInt unit division quotient and remainder comparison", () => {
    const testAmounts: [bigint, number][] = [
      [15000000n, 7],
      [10000000n, 7],
      [1234567n, 7],
      [1n, 7],
      [999999999999999n, 7],
      [123456n, 2],
      [100n, 2],
      [99n, 2],
      [1n, 2],
      [5000000n, 6],
      [1234567n, 6],
      [1000000000n, 9],
      [987654321n, 9],
      [1234567890123n, 12],
      [100000000000000n, 18],
      [1n, 18],
    ];

    testAmounts.forEach(([raw, decimals]) => {
      it(`verifies toHumanUnits(${raw}, ${decimals}) matches arithmetic quotient and remainder`, () => {
        const result = toHumanUnits(raw, decimals);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const scale = 10n ** BigInt(decimals);
        const expectedQuotient = raw / scale;
        const expectedRemainder = raw % scale;

        if (expectedRemainder === 0n) {
          expect(result.value).toBe(expectedQuotient.toString());
        } else {
          const [wholeStr, fracStr] = result.value.split(".");
          expect(wholeStr).toBe(expectedQuotient.toString());
          const fullPaddedRemainder = expectedRemainder.toString().padStart(decimals, "0");
          const expectedFrac = fullPaddedRemainder.replace(/0+$/, "");
          expect(fracStr).toBe(expectedFrac);
        }
      });
    });
  });

  // Mixed input polymorphism and normalization tests
  describe("Input type polymorphism and formatting normalization", () => {
    it("produces identical human strings for bigint, number, and string inputs in toHumanUnits", () => {
      const fromBigInt = toHumanUnits(15000000n, 7);
      const fromNumber = toHumanUnits(15000000, 7);
      const fromString = toHumanUnits("15000000", 7);
      const fromLeadingZeros = toHumanUnits("00015000000", 7);

      expect(fromBigInt).toEqual({ ok: true, value: "1.5" });
      expect(fromNumber).toEqual({ ok: true, value: "1.5" });
      expect(fromString).toEqual({ ok: true, value: "1.5" });
      expect(fromLeadingZeros).toEqual({ ok: true, value: "1.5" });
    });

    it("rejects negative strings with leading zeros in toHumanUnits", () => {
      const result = toHumanUnits("-00015000000", 7);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("produces identical raw units for number, string, and strings with trailing zeros in toRawUnits", () => {
      const fromString = toRawUnits("1.5", 7);
      const fromNumber = toRawUnits(1.5, 7);
      const fromPadded = toRawUnits("1.50000", 7);
      const fromLeadingZero = toRawUnits("01.50", 7);

      expect(fromString).toEqual({ ok: true, value: 15000000n });
      expect(fromNumber).toEqual({ ok: true, value: 15000000n });
      expect(fromPadded).toEqual({ ok: true, value: 15000000n });
      expect(fromLeadingZero).toEqual({ ok: true, value: 15000000n });
    });

    it("correctly handles human amounts with redundant fractional zeroes for integers", () => {
      expect(toRawUnits("100.00", 2)).toEqual({ ok: true, value: 10000n });
      expect(toRawUnits("100.0000000", 7)).toEqual({ ok: true, value: 1000000000n });
    });
  });
});

describe("Configure format columns for DB storage in token_decimals_converter (#423)", () => {
  describe("formatForDbStorage and formatDbColumns unit functionality", () => {
    it("formats raw BigInt amount for 7 decimals (Stellar stroops) with full precision columns", () => {
      const result = formatForDbStorage(15000000n, 7);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.raw_amount).toBe("15000000");
        expect(result.value.formatted_amount).toBe("1.5000000");
        expect(result.value.decimals).toBe(7);
        expect(result.value.trimmed_amount).toBe("1.5");
        // camelCase aliases
        expect(result.value.rawAmount).toBe("15000000");
        expect(result.value.formattedAmount).toBe("1.5000000");
        // columns and row property aliases
        expect(result.columns).toBe(result.value);
        expect(result.row).toBe(result.value);
      }
    });

    it("formats human decimal string amount for 7 decimals", () => {
      const result = formatForDbStorage("1.5", 7);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.raw_amount).toBe("15000000");
        expect(result.value.formatted_amount).toBe("1.5000000");
        expect(result.value.decimals).toBe(7);
        expect(result.value.trimmed_amount).toBe("1.5");
      }
    });

    it("formats a sub-unit amount (1 stroop = 10^-7 XLM)", () => {
      const result = formatForDbStorage(1n, 7);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.raw_amount).toBe("1");
        expect(result.value.formatted_amount).toBe("0.0000001");
        expect(result.value.decimals).toBe(7);
        expect(result.value.trimmed_amount).toBe("0.0000001");
      }
    });

    it("formats zero amount across decimal scales with exact scale padding", () => {
      const res0 = formatForDbStorage(0n, 0);
      expect(res0.ok).toBe(true);
      if (res0.ok) {
        expect(res0.value.raw_amount).toBe("0");
        expect(res0.value.formatted_amount).toBe("0");
        expect(res0.value.decimals).toBe(0);
      }

      const res2 = formatForDbStorage(0n, 2);
      expect(res2.ok).toBe(true);
      if (res2.ok) {
        expect(res2.value.raw_amount).toBe("0");
        expect(res2.value.formatted_amount).toBe("0.00");
        expect(res2.value.decimals).toBe(2);
      }

      const res7 = formatForDbStorage("0", 7);
      expect(res7.ok).toBe(true);
      if (res7.ok) {
        expect(res7.value.raw_amount).toBe("0");
        expect(res7.value.formatted_amount).toBe("0.0000000");
        expect(res7.value.decimals).toBe(7);
      }
    });

    it("formats decimals=0 (indivisible tokens)", () => {
      const result = formatForDbStorage(42n, 0);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.raw_amount).toBe("42");
        expect(result.value.formatted_amount).toBe("42");
        expect(result.value.decimals).toBe(0);
        expect(result.value.trimmed_amount).toBe("42");
      }
    });

    it("formats decimals=2 (fiat currency / cents)", () => {
      const fromRaw = formatForDbStorage(10025n, 2);
      expect(fromRaw.ok).toBe(true);
      if (fromRaw.ok) {
        expect(fromRaw.value.raw_amount).toBe("10025");
        expect(fromRaw.value.formatted_amount).toBe("100.25");
      }

      const fromWhole = formatForDbStorage(10000n, 2);
      expect(fromWhole.ok).toBe(true);
      if (fromWhole.ok) {
        expect(fromWhole.value.raw_amount).toBe("10000");
        expect(fromWhole.value.formatted_amount).toBe("100.00");
        expect(fromWhole.value.trimmed_amount).toBe("100");
      }
    });

    it("formats decimals=6 (USDC micro-units)", () => {
      const result = formatForDbStorage(1000000n, 6);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.raw_amount).toBe("1000000");
        expect(result.value.formatted_amount).toBe("1.000000");
        expect(result.value.trimmed_amount).toBe("1");
      }
    });

    it("formats decimals=18 (EVM wei scale)", () => {
      const result = formatForDbStorage(1n, 18);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.raw_amount).toBe("1");
        expect(result.value.formatted_amount).toBe("0.000000000000000001");
        expect(result.value.decimals).toBe(18);
      }
    });

    it("unwraps ConversionResult passed from toRawUnits", () => {
      const rawRes = toRawUnits("12.5", 7);
      expect(rawRes.ok).toBe(true);
      const dbRes = formatForDbStorage(rawRes, 7);
      expect(dbRes.ok).toBe(true);
      if (dbRes.ok) {
        expect(dbRes.value.raw_amount).toBe("125000000");
        expect(dbRes.value.formatted_amount).toBe("12.5000000");
      }
    });

    it("formatDbColumns and formatColumnsForDbStorage act as direct aliases", () => {
      const res1 = formatForDbStorage(15000000n, 7);
      const res2 = formatDbColumns(15000000n, 7);
      const res3 = formatColumnsForDbStorage(15000000n, 7);

      expect(res1).toEqual(res2);
      expect(res2).toEqual(res3);
    });

    it("supports formatRawForDbStorage and formatHumanForDbStorage explicitly", () => {
      const rawRes = formatRawForDbStorage(100n, 2);
      expect(rawRes.ok).toBe(true);
      if (rawRes.ok) {
        expect(rawRes.value.raw_amount).toBe("100");
        expect(rawRes.value.formatted_amount).toBe("1.00");
      }

      const humanRes = formatHumanForDbStorage("100", 2);
      expect(humanRes.ok).toBe(true);
      if (humanRes.ok) {
        expect(humanRes.value.raw_amount).toBe("10000");
        expect(humanRes.value.formatted_amount).toBe("100.00");
      }
    });
  });

  describe("Custom database precision schema configuration", () => {
    it("supports fixedScale: false for trimmed format", () => {
      const result = formatForDbStorage(15000000n, 7, { fixedScale: false });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.formatted_amount).toBe("1.5");
      }
    });

    it("maps custom column names to row attributes", () => {
      const schema: DbPrecisionSchema = {
        columns: {
          rawAmount: "token_raw_amount",
          formattedAmount: "token_display_amount",
          decimals: "token_decimals_scale",
        },
      };

      const result = formatForDbStorage(15000000n, 7, schema);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.token_raw_amount).toBe("15000000");
        expect(result.value.token_display_amount).toBe("1.5000000");
        expect(result.value.token_decimals_scale).toBe(7);
        // Standard attributes also remain present
        expect(result.value.raw_amount).toBe("15000000");
        expect(result.value.formatted_amount).toBe("1.5000000");
      }
    });

    it("enforces custom schema precision limit", () => {
      const result = formatForDbStorage("123456789012", 2, { precision: 10 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

    it("accepts values within custom schema precision limit", () => {
      const result = formatForDbStorage("12345678", 2, { precision: 10 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.raw_amount).toBe("12345678");
      }
    });

    it("validates database precision schema using validateDbPrecisionSchema", () => {
      expect(validateDbPrecisionSchema({ scale: 7, precision: 15 }).ok).toBe(true);
      expect(validateDbPrecisionSchema({ scale: -1 }).ok).toBe(false);
      expect(validateDbPrecisionSchema({ scale: 20 }).ok).toBe(false);
      expect(validateDbPrecisionSchema({ precision: -5 }).ok).toBe(false);
      expect(validateDbPrecisionSchema({ precision: 20 }).ok).toBe(false);
      expect(validateDbPrecisionSchema({ scale: 10, precision: 5 }).ok).toBe(false);
    });

    it("configureFormatColumns creates a pre-configured formatter factory", () => {
      const formatter = configureFormatColumns({
        scale: 7,
        fixedScale: true,
        columns: {
          rawAmount: "on_chain_raw",
          formattedAmount: "db_amount",
          decimals: "asset_decimals",
        },
      });

      const res = formatter.format(15000000n);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.on_chain_raw).toBe("15000000");
        expect(res.value.db_amount).toBe("1.5000000");
        expect(res.value.asset_decimals).toBe(7);
      }
    });
  });

  describe("formatToDbPrecision and toHumanUnits fixedScale option", () => {
    it("formatToDbPrecision formats raw amounts to fixed scale string", () => {
      const res = formatToDbPrecision(15000000n, 7);
      expect(res).toEqual({ ok: true, value: "1.5000000" });

      const resWhole = formatToDbPrecision(10000000n, 7);
      expect(resWhole).toEqual({ ok: true, value: "1.0000000" });

      const resCents = formatToDbPrecision(100n, 2);
      expect(resCents).toEqual({ ok: true, value: "1.00" });
    });

    it("toHumanUnits preserves trailing zeroes when fixedScale: true is supplied", () => {
      const trimmed = toHumanUnits(15000000n, 7);
      expect(trimmed).toEqual({ ok: true, value: "1.5" });

      const fixed = toHumanUnits(15000000n, 7, { fixedScale: true });
      expect(fixed).toEqual({ ok: true, value: "1.5000000" });
    });
  });

  describe("Negative parameter and overflow validation for DB storage", () => {
    it("rejects negative raw amounts with INVALID_AMOUNT", () => {
      const negBigInt = formatForDbStorage(-15000000n, 7);
      expect(negBigInt.ok).toBe(false);
      if (!negBigInt.ok) {
        expect(negBigInt.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }

      const negStr = formatForDbStorage("-100", 2);
      expect(negStr.ok).toBe(false);
      if (!negStr.ok) {
        expect(negStr.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }

      const negNum = formatForDbStorage(-42, 0);
      expect(negNum.ok).toBe(false);
      if (!negNum.ok) {
        expect(negNum.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects negative human amounts with INVALID_AMOUNT", () => {
      const negHuman = formatForDbStorage("-1.5", 7);
      expect(negHuman.ok).toBe(false);
      if (!negHuman.ok) {
        expect(negHuman.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects negative decimals with INVALID_DECIMALS", () => {
      const res = formatForDbStorage(15000000n, -1);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_DECIMALS);
      }
    });

    it("rejects decimals exceeding MAX_TOKEN_DECIMALS", () => {
      const res = formatForDbStorage(100n, MAX_TOKEN_DECIMALS + 1);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_DECIMALS);
      }
    });

    it("rejects inputs exceeding MAX_SAFE_DIGITS (15) with EXCESSIVE_DIGITS", () => {
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const res = formatForDbStorage(tooBig, 7);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });
  });

  describe("Database row storage and precision preservation verification", () => {
    let testDb: Database.Database;

    beforeAll(() => {
      testDb = new Database(":memory:");
      testDb.exec(`
        CREATE TABLE token_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          asset_code TEXT NOT NULL,
          raw_amount TEXT NOT NULL,
          formatted_amount TEXT NOT NULL,
          decimals INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
    });

    afterAll(() => {
      testDb.close();
    });

    interface TokenStorageCase {
      assetCode: string;
      raw: bigint;
      decimals: number;
      expectedFormatted: string;
      expectedRaw: string;
      description: string;
    }

    const storageCases: TokenStorageCase[] = [
      {
        assetCode: "XLM",
        raw: 1n,
        decimals: 7,
        expectedFormatted: "0.0000001",
        expectedRaw: "1",
        description: "1 stroop minimum unit (10^-7)",
      },
      {
        assetCode: "XLM",
        raw: 15000000n,
        decimals: 7,
        expectedFormatted: "1.5000000",
        expectedRaw: "15000000",
        description: "1.5 XLM with 7 decimal fixed scale",
      },
      {
        assetCode: "XLM",
        raw: 100000000000000n,
        decimals: 7,
        expectedFormatted: "10000000.0000000",
        expectedRaw: "100000000000000",
        description: "10M XLM boundary (15 digits)",
      },
      {
        assetCode: "XLM",
        raw: 987654321098765n,
        decimals: 7,
        expectedFormatted: "98765432.1098765",
        expectedRaw: "987654321098765",
        description: "Max 15-digit safe value with full 7 fractional digits",
      },
      {
        assetCode: "USDC",
        raw: 1n,
        decimals: 6,
        expectedFormatted: "0.000001",
        expectedRaw: "1",
        description: "1 micro-unit USDC",
      },
      {
        assetCode: "USDC",
        raw: 1000000n,
        decimals: 6,
        expectedFormatted: "1.000000",
        expectedRaw: "1000000",
        description: "1 USDC whole unit",
      },
      {
        assetCode: "USDC",
        raw: 1250000n,
        decimals: 6,
        expectedFormatted: "1.250000",
        expectedRaw: "1250000",
        description: "1.25 USDC with trailing zeroes preserved",
      },
      {
        assetCode: "BTC",
        raw: 1n,
        decimals: 8,
        expectedFormatted: "0.00000001",
        expectedRaw: "1",
        description: "1 satoshi BTC",
      },
      {
        assetCode: "BTC",
        raw: 50000000n,
        decimals: 8,
        expectedFormatted: "0.50000000",
        expectedRaw: "50000000",
        description: "0.5 BTC (8 decimal fixed scale)",
      },
      {
        assetCode: "USD",
        raw: 1n,
        decimals: 2,
        expectedFormatted: "0.01",
        expectedRaw: "1",
        description: "1 cent",
      },
      {
        assetCode: "USD",
        raw: 10000n,
        decimals: 2,
        expectedFormatted: "100.00",
        expectedRaw: "10000",
        description: "100 dollars exact (2 decimal scale)",
      },
      {
        assetCode: "USD",
        raw: 999999999999999n,
        decimals: 2,
        expectedFormatted: "9999999999999.99",
        expectedRaw: "999999999999999",
        description: "15 digits cent amount",
      },
      {
        assetCode: "NFT",
        raw: 1n,
        decimals: 0,
        expectedFormatted: "1",
        expectedRaw: "1",
        description: "1 indivisible token unit",
      },
      {
        assetCode: "NFT",
        raw: 999999999999999n,
        decimals: 0,
        expectedFormatted: "999999999999999",
        expectedRaw: "999999999999999",
        description: "15 nines indivisible units",
      },
      {
        assetCode: "ETH",
        raw: 1n,
        decimals: 18,
        expectedFormatted: "0.000000000000000001",
        expectedRaw: "1",
        description: "1 wei minimum unit (18 decimals)",
      },
      {
        assetCode: "ETH",
        raw: 100000000000000n,
        decimals: 18,
        expectedFormatted: "0.000100000000000000",
        expectedRaw: "100000000000000",
        description: "15-digit EVM amount with 18 decimal fixed scale",
      },
    ];

    it("Assert written row attributes preserve full precision", () => {
      const insertStmt = testDb.prepare(`
        INSERT INTO token_records (asset_code, raw_amount, formatted_amount, decimals)
        VALUES (?, ?, ?, ?)
      `);

      const selectStmt = testDb.prepare(`
        SELECT asset_code, raw_amount, formatted_amount, decimals
        FROM token_records
        WHERE id = ?
      `);

      storageCases.forEach(({ assetCode, raw, decimals, expectedFormatted, expectedRaw, description: _description }) => {
        // Format columns using token_decimals_converter
        const formatResult = formatForDbStorage(raw, decimals);
        expect(formatResult.ok).toBe(true);
        if (!formatResult.ok) return;

        const { raw_amount, formatted_amount } = formatResult.value;

        // Write row attributes to database table
        const insertInfo = insertStmt.run(
          assetCode,
          raw_amount,
          formatted_amount,
          decimals
        );
        const rowId = insertInfo.lastInsertRowid;

        // Query written row back from database
        const writtenRow = selectStmt.get(rowId) as {
          asset_code: string;
          raw_amount: string;
          formatted_amount: string;
          decimals: number;
        };

        // Assert written row attributes preserve full precision
        expect(writtenRow).toBeDefined();
        expect(writtenRow.raw_amount).toBe(expectedRaw);
        expect(writtenRow.formatted_amount).toBe(expectedFormatted);
        expect(writtenRow.decimals).toBe(decimals);
        expect(writtenRow.asset_code).toBe(assetCode);

        // Assert exact string format has no scientific notation (no 'e' or 'E')
        expect(writtenRow.raw_amount).not.toMatch(/[eE]/);
        expect(writtenRow.formatted_amount).not.toMatch(/[eE]/);

        // Assert round-trip back to BigInt preserves exact value
        expect(BigInt(writtenRow.raw_amount)).toBe(raw);

        // Assert round-trip back through toRawUnits preserves exact BigInt
        const reConverted = toRawUnits(writtenRow.formatted_amount, writtenRow.decimals);
        expect(reConverted.ok).toBe(true);
        if (reConverted.ok) {
          expect(reConverted.value).toBe(raw);
        }
      });
    });

    it("preserves full precision across multi-row database batch operations", () => {
      const selectAll = testDb.prepare("SELECT raw_amount, formatted_amount, decimals FROM token_records");
      const rows = selectAll.all() as { raw_amount: string; formatted_amount: string; decimals: number }[];

      expect(rows.length).toBeGreaterThanOrEqual(storageCases.length);

      // Verify every row in the database retains full string precision
      rows.forEach((row) => {
        expect(typeof row.raw_amount).toBe("string");
        expect(typeof row.formatted_amount).toBe("string");
        expect(row.raw_amount.length).toBeGreaterThan(0);
        expect(row.formatted_amount.length).toBeGreaterThan(0);

        // Re-conversion verification
        const backToRaw = toRawUnits(row.formatted_amount, row.decimals);
        expect(backToRaw.ok).toBe(true);
        if (backToRaw.ok) {
          expect(backToRaw.value.toString()).toBe(row.raw_amount);
        }
      });
    });
  });
});


