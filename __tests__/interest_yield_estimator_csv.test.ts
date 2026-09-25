import fs from "fs";
import os from "os";
import path from "path";
import {
  MAX_SAFE_DIGITS,
  ERROR_CODES,
  escapeCsvField,
  formatRowToCsv,
  validateYieldRecord,
  buildCsvBlock,
  exportToCsv,
  formatToCsv,
  serializeToCsv,
  formatYieldTable,
  exportToCsvFile,
  serializeToCsvFile,
  serializeYieldRecordsToFile,
  writeCsvToFile,
  parseCsvLine,
  parseCsvBlock,
  readCsvFromFile,
  parseCsvFromFile,
  InterestYieldRecord,
} from "../src/utils/interest_yield_estimator.js";

describe("interest_yield_estimator CSV formatting and file serialization", () => {
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
      expect(escapeCsvField("principal")).toBe("principal");
      expect(escapeCsvField("200")).toBe("200");
    });

    it("wraps strings containing delimiters in quotes", () => {
      expect(escapeCsvField("a,b", ",")).toBe('"a,b"');
      expect(escapeCsvField("a;b", ";")).toBe('"a;b"');
    });

    it("doubles internal double quotes and wraps in quotes", () => {
      expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    });

    it("wraps strings containing newlines in quotes", () => {
      expect(escapeCsvField("l1\nl2")).toBe('"l1\nl2"');
      expect(escapeCsvField("l1\r\nl2")).toBe('"l1\r\nl2"');
    });
  });

  describe("formatRowToCsv", () => {
    it("formats an array of values into a delimiter-separated line", () => {
      expect(formatRowToCsv(["100", 2n, 200n])).toBe("100,2,200");
    });

    it("respects custom delimiter in row formatting", () => {
      expect(formatRowToCsv(["100", 2n, 200n], ";")).toBe("100;2;200");
    });
  });

  describe("validateYieldRecord", () => {
    it("rejects non-object records", () => {
      const res = validateYieldRecord(null as unknown as InterestYieldRecord, 0);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_ROW);
      }
    });

    it("rejects records missing principal or rate", () => {
      const missingRate = validateYieldRecord({ principal: "100" }, 0);
      expect(missingRate.ok).toBe(false);
      if (!missingRate.ok) {
        expect(missingRate.code).toBe(ERROR_CODES.INVALID_ROW);
      }

      const missingPrincipal = validateYieldRecord({ rate: "2" }, 0);
      expect(missingPrincipal.ok).toBe(false);
      if (!missingPrincipal.ok) {
        expect(missingPrincipal.code).toBe(ERROR_CODES.INVALID_ROW);
      }
    });

    it("rejects non-numeric operands", () => {
      const res = validateYieldRecord(
        { principal: {}, rate: "2" } as unknown as InterestYieldRecord,
        0,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_ROW);
      }
    });

    it("computes yield for a valid record", () => {
      const res = validateYieldRecord({ principal: "100", rate: "2" });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.principal).toBe(100n);
        expect(res.value.rate).toBe(2n);
        expect(res.value.yield).toBe(200n);
      }
    });

    it("propagates excessive-digit rejections from the estimator", () => {
      const tooBig = "9".repeat(MAX_SAFE_DIGITS + 1);
      const res = validateYieldRecord({ principal: tooBig, rate: "1" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

    it("propagates invalid-rate rejections from the estimator", () => {
      const res = validateYieldRecord({ principal: "100", rate: "1.5" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_RATE);
      }
    });
  });

  describe("CSV block builders and format exporters", () => {
    it("rejects non-array records", () => {
      const res = buildCsvBlock(null as unknown as InterestYieldRecord[]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_INPUT);
      }
    });

    it("builds a header-only CSV for empty records by default", () => {
      const res = buildCsvBlock([]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBe("principal,rate,yield\n");
        expect(res.rowCount).toBe(0);
        expect(res.columns).toEqual(["principal", "rate", "yield"]);
      }
    });

    it("rejects empty records if allowEmpty is false", () => {
      const res = buildCsvBlock([], { allowEmpty: false });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.EMPTY_DATA);
      }
    });

    it("builds correct CSV block for simple records", () => {
      const records: InterestYieldRecord[] = [
        { principal: "100", rate: "2" },
        { principal: "1000", rate: "3" },
      ];
      const res = buildCsvBlock(records);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.rowCount).toBe(2);
        const expected = [
          "principal,rate,yield",
          "100,2,200",
          "1000,3,3000\n",
        ].join("\n");
        expect(res.value).toBe(expected);
      }
    });

    it("supports custom columns and custom headers", () => {
      const records: InterestYieldRecord[] = [
        { principal: "100", rate: "2" },
      ];
      const res = exportToCsv(records, {
        columns: ["principal", "yield", "rate"],
        headers: ["Principal", "Yield", "Rate"],
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        const lines = res.value.trim().split("\n");
        expect(lines[0]).toBe("Principal,Yield,Rate");
        expect(lines[1]).toBe("100,200,2");
      }
    });

    it("supports custom delimiter and line ending", () => {
      const res = formatToCsv([{ principal: "100", rate: "2" }], {
        delimiter: ";",
        lineEnding: "\r\n",
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBe("principal;rate;yield\r\n100;2;200\r\n");
      }
    });

    it("omits header row when includeHeader is false", () => {
      const res = serializeToCsv([{ principal: "100", rate: "2" }], {
        includeHeader: false,
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBe("100,2,200\n");
      }
    });

    it("formatYieldTable alias behaves like buildCsvBlock", () => {
      const res = formatYieldTable([{ principal: "5", rate: "5" }]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBe("principal,rate,yield\n5,5,25\n");
      }
    });

    it("fails fast if any record in the batch violates validation rules", () => {
      const records: InterestYieldRecord[] = [
        { principal: "100", rate: "2" },
        { principal: "100", rate: "1.5" }, // Invalid rate
      ];
      const res = buildCsvBlock(records);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_RATE);
      }
    });
  });

  describe("file serialization helper functions", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow-yield-csv-test-"));
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
      const res = exportToCsvFile(filePath, 123 as unknown as InterestYieldRecord[]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_INPUT);
      }
    });

    it("serializes yield records to a newly created file and verifies table output", () => {
      const filePath = path.join(tempDir, "nested", "yields.csv");
      const records: InterestYieldRecord[] = [
        { principal: "100", rate: "2" },
        { principal: "1000", rate: "3" },
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
        "principal,rate,yield",
        "100,2,200",
        "1000,3,3000",
      ];
      expect(fileContent.trim().split(/\r?\n/)).toEqual(expectedLines);
    });

    it("serializes pre-built CSV string directly to file", () => {
      const filePath = path.join(tempDir, "direct.csv");
      const csvString = "principal,rate,yield\n100,2,200\n200,2,400\n";

      const res = writeCsvToFile(filePath, csvString);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.rowCount).toBe(2);
      }

      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(csvString);
    });

    it("serializeToCsvFile and serializeYieldRecordsToFile aliases work identically", () => {
      const filePath1 = path.join(tempDir, "alias1.csv");
      const filePath2 = path.join(tempDir, "alias2.csv");
      const records = [{ principal: "10", rate: "10" }];

      const res1 = serializeToCsvFile(filePath1, records);
      const res2 = serializeYieldRecordsToFile(filePath2, records);

      expect(res1.ok).toBe(true);
      expect(res2.ok).toBe(true);
      expect(fs.readFileSync(filePath1, "utf-8")).toBe(
        fs.readFileSync(filePath2, "utf-8"),
      );
    });

    it("propagates validation errors and does not write file", () => {
      const filePath = path.join(tempDir, "failed.csv");
      const invalidRecords = [{ principal: "100", rate: "1.5" }];

      const res = exportToCsvFile(filePath, invalidRecords);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_RATE);
      }
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("handles filesystem write failures gracefully with FILE_WRITE_ERROR", () => {
      const invalidPath = path.join(tempDir, "bad\0file.csv");
      const res = exportToCsvFile(invalidPath, "principal,rate,yield\n");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.FILE_WRITE_ERROR);
      }
    });

    describe("CSV reading and deserialization round-trip", () => {
      it("parses CSV line with quotes and escaped characters", () => {
        const line = '100,"2,000",4';
        const fields = parseCsvLine(line);
        expect(fields).toEqual(["100", "2,000", "4"]);
      });

      it("parses CSV block back into yield records", () => {
        const csv = ["principal,rate,yield", "100,2,200", "1000,3,3000"].join("\n");
        const parsed = parseCsvBlock(csv);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
          expect(parsed.rowCount).toBe(2);
          expect(parsed.records[0].principal).toBe(100n);
          expect(parsed.records[0].rate).toBe(2n);
          expect(parsed.records[0].yield).toBe(200n);
          expect(parsed.records[1].yield).toBe(3000n);
        }
      });

      it("reads CSV file from disk and parses correctly", () => {
        const filePath = path.join(tempDir, "read_test.csv");
        const originalRecords: InterestYieldRecord[] = [
          { principal: "100", rate: "2" },
          { principal: "250", rate: "4" },
        ];

        const exportRes = exportToCsvFile(filePath, originalRecords);
        expect(exportRes.ok).toBe(true);

        const readRes = readCsvFromFile(filePath);
        expect(readRes.ok).toBe(true);
        if (readRes.ok) {
          expect(readRes.rowCount).toBe(2);
          expect(readRes.records[0].principal).toBe(100n);
          expect(readRes.records[0].yield).toBe(200n);
          expect(readRes.records[1].principal).toBe(250n);
          expect(readRes.records[1].yield).toBe(1000n);
        }
      });

      it("parseCsvFromFile alias functions identically", () => {
        const filePath = path.join(tempDir, "read_alias.csv");
        exportToCsvFile(filePath, [{ principal: "100", rate: "2" }]);
        const res = parseCsvFromFile(filePath);
        expect(res.ok).toBe(true);
        if (res.ok) {
          expect(res.rowCount).toBe(1);
          expect(res.records[0].yield).toBe(200n);
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
