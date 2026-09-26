import {
  REPORT_EXPORTER_ERRORS,
  DEFAULT_REPORT_ASSET_FALLBACK,
  resolveReportTicker,
  resolveReportRow,
  resolveReportRows,
} from "../src/utils/financial_report_exporter.js";

describe("financial_report_exporter unknown ticker fallback", () => {
  describe("resolveReportTicker", () => {
    it("resolves known tickers with full config", () => {
      const result = resolveReportTicker("XLM");
      expect(result.known).toBe(true);
      if (result.known) {
        expect(result.config.decimals).toBe(7);
        expect(result.config.label).toMatch(/Lumens/);
      }
    });

    it("normalises case and whitespace", () => {
      expect(resolveReportTicker("  usdc ").known).toBe(true);
    });

    it("applies the default fallback for unknown tickers", () => {
      const result = resolveReportTicker("NOVEL_TOK");
      expect(result.known).toBe(false);
      if (!result.known) {
        expect(result.fallback).toBe(true);
        expect(result.config.decimals).toBe(
          DEFAULT_REPORT_ASSET_FALLBACK.decimals
        );
        expect(result.ticker).toBe("NOVEL_TOK");
      }
    });

    it("falls back for empty or non-string tickers without throwing", () => {
      expect(resolveReportTicker("").known).toBe(false);
      expect(resolveReportTicker(42 as unknown as string).known).toBe(false);
    });
  });

  describe("resolveReportRow", () => {
    it("resolves a known-ticker row without fallback", () => {
      const result = resolveReportRow({ ticker: "USDC", amount: "10000000" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.row.amount).toBe(10000000n);
        expect(result.row.decimals).toBe(7);
        expect(result.row.fallback).toBe(false);
      }
    });

    it("captures unknown tickers with fallback instead of failing", () => {
      const result = resolveReportRow({ ticker: "MYSTERY", amount: 5 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.row.fallback).toBe(true);
        expect(result.row.decimals).toBe(7);
      }
    });

    it("rejects invalid amounts", () => {
      const result = resolveReportRow({ ticker: "XLM", amount: "12.5" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(REPORT_EXPORTER_ERRORS.INVALID_AMOUNT);
      }
    });

    it("rejects non-object rows", () => {
      const result = resolveReportRow(null as unknown as { ticker: string; amount: bigint });
      expect(result.ok).toBe(false);
    });
  });

  describe("resolveReportRows", () => {
    it("resolves mixed known/unknown batches", () => {
      const result = resolveReportRows([
        { ticker: "XLM", amount: "1" },
        { ticker: "FUTURE", amount: "2" },
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rows).toHaveLength(2);
        expect(result.rows[0].fallback).toBe(false);
        expect(result.rows[1].fallback).toBe(true);
      }
    });

    it("short-circuits on invalid amounts but never on unknown tickers", () => {
      const result = resolveReportRows([{ ticker: "XLM", amount: "bad" }]);
      expect(result.ok).toBe(false);
    });

    it("rejects empty batches", () => {
      const result = resolveReportRows([]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(REPORT_EXPORTER_ERRORS.EMPTY_ROWS);
      }
    });
  });
});
