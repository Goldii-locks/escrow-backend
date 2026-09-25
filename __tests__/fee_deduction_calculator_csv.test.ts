import fs from "fs";
import os from "os";
import path from "path";
import {
  ERROR_CODES,
  buildCsvBlock,
  exportToCsv,
  formatToCsv,
  serializeToCsv,
  formatFeeTable,
  formatDeductionTable,
  exportDeductionToCsv,
  exportFeeToCsv,
  exportToCsvFile,
  serializeToCsvFile,
  serializeFeeRecordsToFile,
  writeCsvToFile,
  escapeCsvField,
  formatRowToCsv,
  parseCsvLine,
  parseCsvBlock,
  readCsvFromFile,
  parseCsvFromFile,
  validateFeeDeductionRecord,
  type FeeDeductionRecord,
} from "../src/utils/fee_deduction_calculator.js";

describe("fee_deduction_calculator CSV format exporters (#435)", () => {
  describe("escapeCsvField and formatRowToCsv", () => {
    it("escapes fields with commas and quotes", () => {
      expect(escapeCsvField('USD, Coin "Gold"')).toBe('"USD, Coin ""Gold"""');
      expect(escapeCsvField("plain")).toBe("plain");
      expect(escapeCsvField(123n)).toBe("123");
      expect(escapeCsvField(null)).toBe("");
    });

    it("formats a row with delimiter", () => {
      expect(formatRowToCsv(["a", "b", "c"])).toBe("a,b,c");
      expect(formatRowToCsv(["a", "b,c"], ",")).toBe('a,"b,c"');
    });
  });

  describe("validateFeeDeductionRecord", () => {
    it("validates a correct record and computes fee fields", () => {
      const res = validateFeeDeductionRecord({ grossAmount: 10000, feeRate: 500 });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.feeAmount).toBe(500n);
        expect(res.value.netAmount).toBe(9500n);
        expect(res.value.grossAmount).toBe(10000n);
      }
    });

    it("rejects non-object records", () => {
      const res = validateFeeDeductionRecord(null as any);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe(ERROR_CODES.INVALID_ROW);
    });

    it("rejects records missing grossAmount or feeRate", () => {
      expect(validateFeeDeductionRecord({ feeRate: 1 } as any).ok).toBe(false);
      expect(validateFeeDeductionRecord({ grossAmount: 1 } as any).ok).toBe(false);
    });

    it("propagates overflow validation failures", () => {
      const tooBig = "1" + "0".repeat(15);
      const res = validateFeeDeductionRecord({ grossAmount: tooBig, feeRate: 1 });
      expect(res.ok).toBe(false);
    });
  });

  describe("buildCsvBlock table outputs", () => {
    it("rejects non-array records", () => {
      const res = buildCsvBlock(null as any);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe(ERROR_CODES.INVALID_INPUT);
    });

    it("builds a header-only CSV for empty records by default", () => {
      const res = buildCsvBlock([]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.rowCount).toBe(0);
        expect(res.value).toContain("grossAmount");
      }
    });

    it("rejects empty records if allowEmpty is false", () => {
      const res = buildCsvBlock([], { allowEmpty: false });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe(ERROR_CODES.EMPTY_DATA);
    });

    it("builds correct CSV formatting block for simple records", () => {
      const records: FeeDeductionRecord[] = [
        { grossAmount: 10000, feeRate: 500 },
        { grossAmount: 2000, feeRate: 1000 },
      ];
      const res = buildCsvBlock(records);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.rowCount).toBe(2);
        expect(res.columns).toEqual([
          "grossAmount",
          "feeRate",
          "scale",
          "feeAmount",
          "netAmount",
          "remainder",
        ]);
        const lines = res.value.trim().split("\n");
        expect(lines[0]).toBe("grossAmount,feeRate,scale,feeAmount,netAmount,remainder");
        // 500 bps of 10000 = 500 fee, 9500 net
        expect(lines[1]).toBe("10000,500,10000,500,9500,0");
        // 1000 bps of 2000 = 200 fee, 1800 net
        expect(lines[2]).toBe("2000,1000,10000,200,1800,0");
      }
    });

    it("includes label column when labels are provided", () => {
      const res = buildCsvBlock([
        { label: "job-1", grossAmount: 1000, feeRate: 100 },
      ]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.columns[0]).toBe("label");
        expect(res.value).toContain("job-1,1000,100,10000,10,990,0");
      }
    });

    it("supports custom columns and headers", () => {
      const res = buildCsvBlock([{ grossAmount: 1000, feeRate: 100 }], {
        columns: ["grossAmount", "feeAmount"],
        headers: ["Gross", "Fee"],
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        const lines = res.value.trim().split("\n");
        expect(lines[0]).toBe("Gross,Fee");
        expect(lines[1]).toBe("1000,10");
      }
    });

    it("supports custom delimiter and line ending", () => {
      const res = buildCsvBlock([{ grossAmount: 1000, feeRate: 100 }], {
        delimiter: ";",
        lineEnding: "\r\n",
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toContain(";");
        expect(res.value).toContain("\r\n");
      }
    });

    it("omits header when includeHeader is false", () => {
      const res = buildCsvBlock([{ grossAmount: 1000, feeRate: 100 }], {
        includeHeader: false,
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBe("1000,100,10000,10,990,0\n");
      }
    });

    it("fails fast on invalid record", () => {
      const res = buildCsvBlock([
        { grossAmount: 100, feeRate: 10 },
        { grossAmount: "bad", feeRate: 10 },
      ]);
      expect(res.ok).toBe(false);
    });

    it("escapes labels with commas and quotes", () => {
      const res = buildCsvBlock([
        { label: 'USD, Coin "Gold"', grossAmount: 1000, feeRate: 10 },
      ]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toContain('"USD, Coin ""Gold"""');
      }
    });

    it("exporter aliases behave identically", () => {
      const records: FeeDeductionRecord[] = [{ grossAmount: 500, feeRate: 50 }];
      const a = exportToCsv(records);
      const b = formatToCsv(records);
      const c = serializeToCsv(records);
      const d = formatFeeTable(records);
      const e = formatDeductionTable(records);
      const f = exportDeductionToCsv(records);
      const g = exportFeeToCsv(records);
      expect(a).toEqual(b);
      expect(a).toEqual(c);
      expect(a).toEqual(d);
      expect(a).toEqual(e);
      expect(a).toEqual(f);
      expect(a).toEqual(g);
    });
  });

  describe("file serialization helpers", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow-fee-csv-test-"));
    });

    afterEach(() => {
      try {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      } catch {
        // ignore cleanup errors
      }
    });

    it("rejects empty filePath", () => {
      const res = exportToCsvFile("", []);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe(ERROR_CODES.INVALID_INPUT);
    });

    it("rejects non-array non-string data", () => {
      const res = exportToCsvFile(path.join(tempDir, "x.csv"), 123 as any);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe(ERROR_CODES.INVALID_INPUT);
    });

    it("serializes fee records to file and verifies correct table outputs", () => {
      const filePath = path.join(tempDir, "nested", "fees.csv");
      const records: FeeDeductionRecord[] = [
        { label: "job-1", grossAmount: 10000, feeRate: 500 },
        { label: "job-2", grossAmount: 2000, feeRate: 1000 },
      ];
      const res = exportToCsvFile(filePath, records);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.filePath).toBe(filePath);
        expect(res.rowCount).toBe(2);
        expect(res.bytesWritten).toBeGreaterThan(0);
      }
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.trim().split(/\r?\n/);
      expect(lines).toEqual([
        "label,grossAmount,feeRate,scale,feeAmount,netAmount,remainder",
        "job-1,10000,500,10000,500,9500,0",
        "job-2,2000,1000,10000,200,1800,0",
      ]);
    });

    it("serializes pre-built CSV string directly to file", () => {
      const filePath = path.join(tempDir, "direct.csv");
      const csv = "grossAmount,feeRate,scale,feeAmount,netAmount,remainder\n100,10,10000,0,100,1000\n";
      const res = writeCsvToFile(filePath, csv);
      expect(res.ok).toBe(true);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(csv);
    });

    it("aliases write identically", () => {
      const p1 = path.join(tempDir, "a.csv");
      const p2 = path.join(tempDir, "b.csv");
      const records: FeeDeductionRecord[] = [{ grossAmount: 999, feeRate: 10 }];
      const r1 = serializeToCsvFile(p1, records);
      const r2 = serializeFeeRecordsToFile(p2, records);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(fs.readFileSync(p1, "utf-8")).toBe(fs.readFileSync(p2, "utf-8"));
    });

    it("propagates validation errors without writing file", () => {
      const filePath = path.join(tempDir, "failed.csv");
      const res = exportToCsvFile(filePath, [{ grossAmount: "bad", feeRate: 1 }]);
      expect(res.ok).toBe(false);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("handles write failures with FILE_WRITE_ERROR", () => {
      const res = exportToCsvFile(path.join(tempDir, "bad\0file.csv"), "content");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe(ERROR_CODES.FILE_WRITE_ERROR);
    });
  });

  describe("CSV parsing round-trip", () => {
    it("parses CSV line with quotes", () => {
      expect(parseCsvLine('a,"b,c",d')).toEqual(["a", "b,c", "d"]);
    });

    it("parses CSV block back into fee records", () => {
      const csv = [
        "label,grossAmount,feeRate,scale,feeAmount,netAmount,remainder",
        "job-1,10000,500,10000,500,9500,0",
      ].join("\n");
      const parsed = parseCsvBlock(csv);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.rowCount).toBe(1);
        expect(parsed.records[0].grossAmount).toBe(10000n);
        expect(parsed.records[0].feeAmount).toBe(500n);
        expect(parsed.records[0].label).toBe("job-1");
      }
    });

    it("reads CSV file from disk and parses correctly", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow-fee-read-"));
      try {
        const filePath = path.join(dir, "fees.csv");
        const records: FeeDeductionRecord[] = [{ grossAmount: 1000, feeRate: 100 }];
        expect(exportToCsvFile(filePath, records).ok).toBe(true);
        const read = readCsvFromFile(filePath);
        expect(read.ok).toBe(true);
        if (read.ok) {
          expect(read.rowCount).toBe(1);
          expect(read.records[0].feeAmount).toBe(10n);
        }
        const alias = parseCsvFromFile(filePath);
        expect(alias).toEqual(read);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns FILE_READ_ERROR for missing file", () => {
      const res = readCsvFromFile(path.join(os.tmpdir(), "does-not-exist-12345.csv"));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe(ERROR_CODES.FILE_READ_ERROR);
    });
  });
});
