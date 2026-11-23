import fs from "fs";
import os from "os";
import path from "path";
import {
  escapeCsvField,
  escapeCSVField,
  formatRowToCsv,
  parseCsvLine,
  splitCsvRows,
  countCsvDataRows,
  writeCsvFile,
  readCsvFile,
} from "../src/utils/csv-serializer.js";
import * as token from "../src/utils/token_decimals_converter.js";
import {
  escapeAuditLedgerCsvField,
  formatAuditLedgerCsvRow,
} from "../src/utils/audit_ledger_sum_checker.js";

describe("shared CSV primitives (#634)", () => {
  describe("escapeCsvField", () => {
    it.each([
      ["plain", "plain"],
      ["a,b", '"a,b"'],
      ['say "hi"', '"say ""hi"""'],
      ["line\nbreak", '"line\nbreak"'],
      ["carriage\rreturn", '"carriage\rreturn"'],
      [123n, "123"],
      [1.5, "1.5"],
      [null, ""],
      [undefined, ""],
    ])("escapes %p as %p", (value, expected) => {
      expect(escapeCsvField(value)).toBe(expected);
    });

    it("quotes on a custom delimiter", () => {
      expect(escapeCsvField("a;b", ";")).toBe('"a;b"');
      expect(escapeCsvField("a,b", ";")).toBe("a,b");
    });

    it("keeps escapeCSVField as a comma-delimited alias", () => {
      expect(escapeCSVField("a,b")).toBe('"a,b"');
      expect(escapeCSVField(5n)).toBe("5");
    });
  });

  it("formatRowToCsv escapes and joins", () => {
    expect(formatRowToCsv(["a", 'b"c', 1n, null])).toBe('a,"b""c",1,');
    expect(formatRowToCsv(["a", "b;c"], ";")).toBe('a;"b;c"');
  });

  describe("parseCsvLine", () => {
    it("round-trips formatRowToCsv", () => {
      const values = ["a", "b,c", 'd"e', "", "f\ng"];
      expect(parseCsvLine(formatRowToCsv(values))).toEqual(values);
    });

    it("handles a trailing empty field and custom delimiters", () => {
      expect(parseCsvLine("a,b,")).toEqual(["a", "b", ""]);
      expect(parseCsvLine("a;b", ";")).toEqual(["a", "b"]);
    });
  });

  it("splitCsvRows keeps quoted newlines and drops blank rows", () => {
    expect(splitCsvRows('h1,h2\r\n"x\ny",2\n\n3,4\n')).toEqual(['h1,h2', '"x\ny",2', "3,4"]);
  });

  it("countCsvDataRows excludes the header by default", () => {
    expect(countCsvDataRows("h\n1\n2\n")).toBe(2);
    expect(countCsvDataRows("1\n2", false)).toBe(2);
    expect(countCsvDataRows("   ")).toBe(0);
    expect(countCsvDataRows("h")).toBe(0);
  });

  it("writeCsvFile creates parent dirs and readCsvFile reads it back", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-primitives-"));
    try {
      const file = path.join(dir, "nested", "out.csv");
      const bytes = writeCsvFile(file, "a,b\n1,2\n");
      expect(bytes).toBe(8);
      expect(readCsvFile(file)).toBe("a,b\n1,2\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("module-level helpers are the shared implementations", () => {
    expect(token.escapeCsvField).toBe(escapeCsvField);
    expect(token.formatRowToCsv).toBe(formatRowToCsv);
    expect(token.parseCsvLine).toBe(parseCsvLine);
    expect(escapeAuditLedgerCsvField).toBe(escapeCsvField);
    expect(formatAuditLedgerCsvRow).toBe(formatRowToCsv);
  });
});
