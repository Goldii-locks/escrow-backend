import {
  EXPORTER_PARAM_ERROR_CODES as ERROR_CODES,
  assertFinancialReportSplitSum,
  exportFinancialReport,
  financial_report_exporter,
  FinancialReportExporterErrorException,
  validateFinancialReportExporterParams,
} from "../src/utils/financial_report_exporter.js";

describe("financial_report_exporter split-sum checks (#510)", () => {
  describe("assertFinancialReportSplitSum", () => {
    it("accepts allocations that match the base amount exactly", () => {
      const result = assertFinancialReportSplitSum(["100", 250n, 150], "500");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(500n);
      }
    });

    it("sums multiple split entries with bigint-exact arithmetic", () => {
      // 1_000_000 + 2_500_000 + 6_500_000 = 10_000_000
      const result = assertFinancialReportSplitSum(
        [1_000_000n, "2500000", 6_500_000],
        10_000_000n
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(10_000_000n);
      }
    });

    it("rejects under-allocation", () => {
      const result = assertFinancialReportSplitSum(["10", "20"], "35");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.SUM_MISMATCH);
        expect(result.error).toContain("30");
        expect(result.error).toContain("35");
      }
    });

    it("rejects over-allocation", () => {
      const result = assertFinancialReportSplitSum(["20", "20"], "35");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.SUM_MISMATCH);
        expect(result.error).toContain("40");
        expect(result.error).toContain("35");
      }
    });

    it("accepts a single zero split against a zero base amount", () => {
      const result = assertFinancialReportSplitSum([0n], 0);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0n);
      }
    });

    it("rejects an empty splits array", () => {
      const result = assertFinancialReportSplitSum([], 0);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_PARAMETER);
      }
    });
  });

  describe("exportFinancialReport and financial_report_exporter", () => {
    it("exports when entry amounts reconcile with the base amount", () => {
      const res = exportFinancialReport({
        amount: 1000,
        currency: "USDC",
        entries: [
          { category: "operations", amount: 600, currency: "USDC" },
          { category: "escrow", amount: 400, currency: "USDC" },
        ],
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.rowCount).toBe(2);
        expect(res.data).toContain("operations,600,USDC");
        expect(res.data).toContain("escrow,400,USDC");
      }
    });

    it("still exports a total row when no split entries are provided", () => {
      const res = exportFinancialReport({ amount: 500, currency: "XLM" });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.rowCount).toBe(1);
        expect(res.data).toContain("total,500,XLM");
      }
    });

    it("still exports a total row for an empty entries array", () => {
      const res = exportFinancialReport({ amount: 75, entries: [] });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data).toContain("total,75");
      }
    });

    it("does not produce a successful report when splits are under the base amount", () => {
      const res = exportFinancialReport({
        amount: 1000,
        entries: [
          { category: "a", amount: 100 },
          { category: "b", amount: 200 },
        ],
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.SUM_MISMATCH);
      }
    });

    it("does not produce a successful report when splits exceed the base amount", () => {
      const res = exportFinancialReport({
        amount: 100,
        entries: [
          { amount: 60 },
          { amount: 50 },
        ],
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.SUM_MISMATCH);
      }
    });

    it("rejects mismatched allocations in validateFinancialReportExporterParams", () => {
      expect(() => {
        validateFinancialReportExporterParams({
          amount: 100,
          entries: [{ amount: 40 }, { amount: 40 }],
        });
      }).toThrow(FinancialReportExporterErrorException);

      try {
        validateFinancialReportExporterParams({
          amount: 100,
          entries: [{ amount: 40 }, { amount: 40 }],
        });
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(FinancialReportExporterErrorException);
        if (err instanceof FinancialReportExporterErrorException) {
          expect(err.code).toBe(ERROR_CODES.SUM_MISMATCH);
        }
      }
    });

    it("rejects mismatched allocations in async financial_report_exporter", async () => {
      await expect(
        financial_report_exporter({
          amount: 1000,
          entries: [{ amount: 999 }],
        })
      ).rejects.toThrow(FinancialReportExporterErrorException);
    });

    it("accepts matching allocations in async financial_report_exporter", async () => {
      const res = await financial_report_exporter({
        amount: 9,
        entries: [{ amount: 2 }, { amount: 3 }, { amount: 4 }],
      });
      expect(res.ok).toBe(true);
      expect(res.rowCount).toBe(3);
    });
  });
});
