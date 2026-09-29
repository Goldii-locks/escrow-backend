import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ERROR_CODES,
  MAX_SAFE_DIGITS,
  AUDIT_LEDGER_CSV_COLUMNS,
  escapeAuditLedgerCsvField,
  formatAuditLedgerCsvRow,
  buildAuditLedgerCsvBlock,
  exportAuditLedgerToCsv,
  serializeAuditLedgerToCsv,
  formatAuditLedgerTable,
  writeAuditLedgerCsvFile,
  type AuditLedgerCsvRecord,
} from "../src/utils/audit_ledger_sum_checker.js";

describe("audit_ledger_sum_checker CSV format exporters (#500)", () => {
  describe("escapeAuditLedgerCsvField and formatAuditLedgerCsvRow", () => {
    it("leaves plain values unquoted and serializes bigints exactly", () => {
      expect(escapeAuditLedgerCsvField("plain")).toBe("plain");
      expect(escapeAuditLedgerCsvField(123n)).toBe("123");
      expect(escapeAuditLedgerCsvField(0n)).toBe("0");
      expect(escapeAuditLedgerCsvField(null)).toBe("");
      expect(escapeAuditLedgerCsvField(undefined)).toBe("");
    });

    it("escapes commas, quotes, and newlines", () => {
      expect(escapeAuditLedgerCsvField("hello, world")).toBe('"hello, world"');
      expect(escapeAuditLedgerCsvField('say "hi"')).toBe('"say ""hi"""');
      expect(escapeAuditLedgerCsvField("line1\nline2")).toBe('"line1\nline2"');
      expect(escapeAuditLedgerCsvField("a;b", ";")).toBe('"a;b"');
    });

    it("formats a row with the delimiter and escaped cells", () => {
      expect(formatAuditLedgerCsvRow(["a", "b", "c"])).toBe("a,b,c");
      expect(formatAuditLedgerCsvRow(["a", "b,c"], ",")).toBe('a,"b,c"');
    });
  });

  describe("buildAuditLedgerCsvBlock", () => {
    const records: AuditLedgerCsvRecord[] = [
      { label: "deposit", amount: "15000000", ticker: "XLM", memo: "opening" },
      { label: "fee", amount: 2500000, ticker: "xlm", memo: "fee, settlement" },
      { amount: 4000000n, ticker: "USDC" },
    ];

    it("builds a header plus rows with deterministic column order", () => {
      const res = buildAuditLedgerCsvBlock(records);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.columns).toEqual([...AUDIT_LEDGER_CSV_COLUMNS]);
      expect(res.rowCount).toBe(3);
      expect(res.total).toBe(21500000n);
      expect(res.value).toBe(
        "index,label,amount,running_total,ticker,memo\n" +
          "0,deposit,15000000,15000000,XLM,opening\n" +
          '1,fee,2500000,17500000,XLM,"fee, settlement"\n' +
          "2,,4000000,21500000,USDC,\n"
      );
    });

    it("is deterministic across repeated calls", () => {
      const first = exportAuditLedgerToCsv(records);
      const second = serializeAuditLedgerToCsv(records);
      const third = formatAuditLedgerTable(records);
      expect(first).toEqual(second);
      expect(second).toEqual(third);
    });

    it("serializes numeric values as exact integer strings", () => {
      const res = buildAuditLedgerCsvBlock([
        { amount: 10n },
        { amount: "20" },
        { amount: 5 },
      ]);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toContain("0,,10,10,,");
      expect(res.value).toContain("1,,20,30,,");
      expect(res.value).toContain("2,,5,35,,");
      expect(res.total).toBe(35n);
    });

    it("treats empty optional label/ticker/memo as empty cells", () => {
      const res = buildAuditLedgerCsvBlock([{ amount: 1n }]);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.split("\n")[1]).toBe("0,,1,1,,");
    });

    it("escapes quotes inside memo fields", () => {
      const res = buildAuditLedgerCsvBlock([
        { amount: 1, memo: 'say "hi"' },
      ]);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toContain('"say ""hi"""');
    });

    it("omits the header when includeHeader is false", () => {
      const res = buildAuditLedgerCsvBlock([{ amount: 9 }], {
        includeHeader: false,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toBe("0,,9,9,,\n");
    });

    it("applies custom columns, headers, delimiter, and CRLF", () => {
      const res = buildAuditLedgerCsvBlock([{ label: "A", amount: "100" }], {
        columns: ["label", "amount"],
        headers: ["Label", "Amount"],
        delimiter: ";",
        lineEnding: "\r\n",
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toBe("Label;Amount\r\nA;100\r\n");
    });

    it("builds a header-only table for an empty records array by default", () => {
      const res = buildAuditLedgerCsvBlock([]);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.rowCount).toBe(0);
      expect(res.total).toBe(0n);
      expect(res.value).toBe("index,label,amount,running_total,ticker,memo\n");
    });

    it("rejects an empty records array when allowEmpty is false", () => {
      const res = buildAuditLedgerCsvBlock([], { allowEmpty: false });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.EMPTY_CSV_DATA);
      }
    });

    it("rejects a non-array records argument", () => {
      const res = buildAuditLedgerCsvBlock(null as unknown as AuditLedgerCsvRecord[]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_CSV_INPUT);
      }
    });

    it("rejects invalid amounts before producing a table", () => {
      const res = buildAuditLedgerCsvBlock([{ amount: "12.5" }]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects a running total that overflows the digit limit", () => {
      const half = "9".repeat(MAX_SAFE_DIGITS);
      const res = buildAuditLedgerCsvBlock([{ amount: half }, { amount: half }]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.SUM_OVERFLOW);
      }
    });
  });

  describe("writeAuditLedgerCsvFile", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-ledger-csv-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("writes a usable CSV file with the expected table contents", () => {
      const filePath = path.join(tmpDir, "nested", "ledger.csv");
      const written = writeAuditLedgerCsvFile(filePath, [
        { label: "a", amount: 10 },
        { label: "b", amount: 20 },
      ]);
      expect(written.ok).toBe(true);
      if (!written.ok) return;

      expect(written.rowCount).toBe(2);
      expect(fs.existsSync(filePath)).toBe(true);

      const contents = fs.readFileSync(filePath, "utf8");
      expect(contents).toBe(
        "index,label,amount,running_total,ticker,memo\n" +
          "0,a,10,10,,\n" +
          "1,b,20,30,,\n"
      );
      expect(written.bytesWritten).toBe(Buffer.byteLength(contents, "utf8"));
    });

    it("rejects an empty file path", () => {
      const written = writeAuditLedgerCsvFile("  ", [{ amount: 1 }]);
      expect(written.ok).toBe(false);
      if (!written.ok) {
        expect(written.code).toBe(ERROR_CODES.INVALID_CSV_INPUT);
      }
    });

    it("propagates validation failures instead of writing a file", () => {
      const filePath = path.join(tmpDir, "bad.csv");
      const written = writeAuditLedgerCsvFile(filePath, [{ amount: "nope" }]);
      expect(written.ok).toBe(false);
      expect(fs.existsSync(filePath)).toBe(false);
    });
  });
});
