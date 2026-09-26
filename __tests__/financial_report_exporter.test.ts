import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FINANCIAL_REPORT_EXPORTER_ERRORS,
  REPORT_COLUMNS,
  buildFinancialReport,
  formatMinorUnits,
  resolveReportOptions,
  serializeFinancialReport,
  totalsForRows,
  validateReportRow,
  writeFinancialReportFile,
  type FinancialReportRow,
} from "../src/utils/financial_report_exporter.js";

const ROWS: FinancialReportRow[] = [
  {
    timestamp: "2026-09-01T10:00:00.000Z",
    transactionId: "tx-1",
    walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    direction: "credit",
    amountMinor: 15000000n, // 1.5 units at 7 decimals
    asset: "XLM",
    balanceMinor: 15000000n,
    memo: "deposit",
  },
  {
    timestamp: "2026-09-01T11:30:00.000Z",
    transactionId: "tx-2",
    walletAddress: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    direction: "debit",
    amountMinor: 2500000n, // 0.25 units
    asset: "XLM",
    balanceMinor: 12500000n,
    memo: "fee, settlement",
  },
  {
    timestamp: "2026-09-02T09:15:00.000Z",
    transactionId: "tx-3",
    walletAddress: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    direction: "credit",
    amountMinor: 4000000n, // 0.4 USDC
    asset: "USDC",
    balanceMinor: 4000000n,
    memo: null,
  },
];

describe("financial_report_exporter", () => {
  describe("resolveReportOptions", () => {
    it("defaults to every column, header, summary and a comma delimiter", () => {
      const options = resolveReportOptions();
      expect(options.columns).toEqual([...REPORT_COLUMNS]);
      expect(options.includeHeader).toBe(true);
      expect(options.includeSummary).toBe(true);
      expect(options.delimiter).toBe(",");
      expect(options.newline).toBe("\n");
      expect(options.assetDecimals).toBe(7);
    });

    it("rejects an empty column list", () => {
      expect(() => resolveReportOptions({ columns: [] })).toThrow(
        FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_OPTION
      );
    });

    it("rejects an unknown column", () => {
      expect(() =>
        resolveReportOptions({ columns: ["timestamp" as never, "nope" as never] })
      ).toThrow(/unknown column/);
    });

    it("rejects an empty delimiter and an out-of-range decimals setting", () => {
      expect(() => resolveReportOptions({ delimiter: "" })).toThrow(/delimiter/);
      expect(() => resolveReportOptions({ assetDecimals: 25 })).toThrow(/assetDecimals/);
    });
  });

  describe("formatMinorUnits", () => {
    it("renders seven-decimal minor units", () => {
      expect(formatMinorUnits(15000000n, 7)).toBe("1.5000000");
      expect(formatMinorUnits(1n, 7)).toBe("0.0000001");
      expect(formatMinorUnits(0n, 7)).toBe("0.0000000");
    });

    it("renders whole units when decimals is zero", () => {
      expect(formatMinorUnits(1500n, 0)).toBe("1500");
    });

    it("keeps the sign for net-total balances", () => {
      expect(formatMinorUnits(-2500000n, 7)).toBe("-0.2500000");
    });
  });

  describe("validateReportRow", () => {
    it("normalises amounts to bigint", () => {
      const result = validateReportRow(ROWS[0]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.row.amountMinor).toBe(15000000n);
        expect(result.row.balanceMinor).toBe(15000000n);
        expect(result.row.memo).toBe("deposit");
      }
    });

    it("defaults a missing memo to an empty string", () => {
      const result = validateReportRow({ ...ROWS[0], memo: undefined });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.row.memo).toBe("");
      }
    });

    it("rejects an unparseable timestamp, a bad direction and a fractional amount", () => {
      const badDate = validateReportRow({ ...ROWS[0], timestamp: "not-a-date" }, 4);
      expect(badDate.ok).toBe(false);
      if (!badDate.ok) {
        expect(badDate.code).toBe(FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_ROW);
        expect(badDate.error).toContain("row[4]");
      }

      expect(validateReportRow({ ...ROWS[0], direction: "sideways" as never }).ok).toBe(false);

      const fractional = validateReportRow({ ...ROWS[0], amountMinor: "12.5" });
      expect(fractional.ok).toBe(false);
      if (!fractional.ok) {
        expect(fractional.code).toBe(FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_AMOUNT);
      }
    });

    it("rejects a negative amount", () => {
      const result = validateReportRow({ ...ROWS[0], amountMinor: -1n });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_AMOUNT);
      }
    });
  });

  describe("totalsForRows", () => {
    it("computes per-asset credits, debits and net", () => {
      const rows = ROWS.map((row) => {
        const validation = validateReportRow(row);
        if (!validation.ok) throw new Error(validation.error);
        return validation.row;
      });

      const totals = totalsForRows(rows);
      expect(totals.get("XLM")).toEqual({ credits: 15000000n, debits: 2500000n, net: 12500000n });
      expect(totals.get("USDC")).toEqual({ credits: 4000000n, debits: 0n, net: 4000000n });
    });
  });

  describe("serializeFinancialReport", () => {
    it("emits a header block, one row block per entry and a sorted summary footer", () => {
      const csv = serializeFinancialReport(ROWS);
      const lines = csv.split("\n");

      expect(lines[0]).toBe(
        "timestamp,transaction_id,wallet_address,direction,amount,asset,balance,memo"
      );
      expect(lines[1]).toContain("tx-1,GA");
      expect(lines[1]).toContain(",credit,1.5000000,XLM,1.5000000,deposit");
      expect(lines[2]).toContain(",debit,0.2500000,XLM,1.2500000,");
      expect(lines[3]).toContain(",credit,0.4000000,USDC,0.4000000,");

      // Summary rows are sorted by asset: USDC before XLM.
      expect(lines[4]).toContain("TOTAL,SUMMARY,,net,0.4000000,USDC,,");
      expect(lines[5]).toContain("TOTAL,SUMMARY,,net,1.2500000,XLM,,");
      expect(lines[5]).toContain("credits=1.5000000; debits=0.2500000");
      expect(lines).toHaveLength(7); // 6 lines + trailing newline artefact
    });

    it("escapes a memo containing a comma", () => {
      const csv = serializeFinancialReport(ROWS);
      expect(csv).toContain('"fee, settlement"');
    });

    it("honours a column subset and order", () => {
      const csv = serializeFinancialReport(ROWS, {
        columns: ["transaction_id", "amount"],
        includeSummary: false,
      });
      const lines = csv.split("\n");
      expect(lines[0]).toBe("transaction_id,amount");
      expect(lines[1]).toBe("tx-1,1.5000000");
    });

    it("supports disabling the header and the summary", () => {
      const csv = serializeFinancialReport(ROWS, { includeHeader: false, includeSummary: false });
      const lines = csv.split("\n").filter((line) => line.length > 0);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatch(/^2026-09-01T10:00:00/);
    });

    it("supports a custom delimiter", () => {
      const csv = serializeFinancialReport(ROWS, {
        delimiter: ";",
        columns: ["transaction_id", "asset"],
        includeSummary: false,
      });
      expect(csv.split("\n")[0]).toBe("transaction_id;asset");
    });

    it("supports CRLF line endings", () => {
      const csv = serializeFinancialReport(ROWS, { newline: "\r\n", includeSummary: false });
      expect(csv).toContain("\r\n");
      expect(csv.split("\r\n")[1]).toContain("tx-1");
    });

    it("returns an empty document and empty totals for no rows", () => {
      const report = buildFinancialReport([]);
      expect(report.csv).toBe("");
      expect(report.rowCount).toBe(0);
      expect(report.totals.size).toBe(0);
    });

    it("throws with the validating code when a row is invalid", () => {
      expect(() => serializeFinancialReport([{ ...ROWS[0], amountMinor: "abc" }])).toThrow(
        FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_AMOUNT
      );
    });
  });

  describe("writeFinancialReportFile", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "fre-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("writes the table to disk with the expected contents", async () => {
      const file = path.join(dir, "report.csv");
      const result = await writeFinancialReportFile(ROWS, file);

      expect(result.path).toBe(file);
      expect(result.rowCount).toBe(3);
      expect(result.bytes).toBeGreaterThan(0);

      const written = await readFile(file, "utf8");
      expect(written).toBe(serializeFinancialReport(ROWS));
      expect(written.split("\n")[0]).toBe(
        "timestamp,transaction_id,wallet_address,direction,amount,asset,balance,memo"
      );
      expect(written).toContain("tx-2");
      expect(written).toContain('"fee, settlement"');
      expect(written).toContain("TOTAL,SUMMARY,,net,1.2500000,XLM,,");
    });

    it("rejects a blank path", async () => {
      await expect(writeFinancialReportFile(ROWS, "   ")).rejects.toThrow(/filePath/);
    });
  });
});
