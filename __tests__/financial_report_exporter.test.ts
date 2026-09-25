import {
  ERROR_CODES,
  MAX_SAFE_DIGITS,
  validateFinancialAmount,
  validateFinancialReportExporterParams,
  financial_report_exporter,
  exportFinancialReport,
  FinancialReportExporterErrorException,
} from "../src/utils/financial_report_exporter.js";

describe("financial_report_exporter (#505)", () => {
  describe("validateFinancialAmount negative parameter rejection", () => {
    it("accepts valid positive numbers, strings, and bigints", () => {
      expect(validateFinancialAmount(100).ok).toBe(true);
      expect(validateFinancialAmount("5000").ok).toBe(true);
      expect(validateFinancialAmount(100000n).ok).toBe(true);
    });

    it("rejects negative numbers with NEGATIVE_PARAMETER", () => {
      const res = validateFinancialAmount(-50);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.NEGATIVE_PARAMETER);
        expect(res.error).toMatch(/negative/i);
      }
    });

    it("rejects negative string numbers with NEGATIVE_PARAMETER", () => {
      const res = validateFinancialAmount("-1000");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.NEGATIVE_PARAMETER);
        expect(res.error).toMatch(/negative/i);
      }
    });

    it("rejects negative bigint with NEGATIVE_PARAMETER", () => {
      const res = validateFinancialAmount(-1n);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.NEGATIVE_PARAMETER);
        expect(res.error).toMatch(/negative/i);
      }
    });

    it("rejects negative zero (-0)", () => {
      const res = validateFinancialAmount(-0);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.NEGATIVE_PARAMETER);
      }
    });

    it("rejects non-numeric string values with INVALID_PARAMETER", () => {
      const res = validateFinancialAmount("abc");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_PARAMETER);
      }
    });

    it("rejects values exceeding MAX_SAFE_DIGITS with OVERFLOW_EXCESSIVE_DIGITS", () => {
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const res = validateFinancialAmount(tooBig);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.OVERFLOW_EXCESSIVE_DIGITS);
      }
    });
  });

  describe("validateFinancialReportExporterParams and financial_report_exporter", () => {
    it("throws exception when negative amount is passed to validateFinancialReportExporterParams", () => {
      expect(() => {
        validateFinancialReportExporterParams({ amount: -100 });
      }).toThrow(FinancialReportExporterErrorException);

      try {
        validateFinancialReportExporterParams({ amount: -100 });
      } catch (err: any) {
        expect(err.code).toBe(ERROR_CODES.NEGATIVE_PARAMETER);
      }
    });

    it("throws exception when negative entry amount is provided in entries array", () => {
      expect(() => {
        validateFinancialReportExporterParams({
          amount: 500,
          entries: [{ amount: -10, category: "fee" }],
        });
      }).toThrow(FinancialReportExporterErrorException);
    });

    it("rejects negative parameters in async financial_report_exporter", async () => {
      await expect(
        financial_report_exporter({ amount: -500 })
      ).rejects.toThrow(FinancialReportExporterErrorException);
    });

    it("exports valid financial report for positive parameters", async () => {
      const res = await financial_report_exporter({
        amount: 1000,
        currency: "USDC",
        entries: [
          { category: "operations", amount: 600, currency: "USDC" },
          { category: "escrow", amount: 400, currency: "USDC" },
        ],
      });

      expect(res.ok).toBe(true);
      expect(res.rowCount).toBe(2);
      expect(res.data).toContain("category,amount,currency");
      expect(res.data).toContain("operations,600,USDC");
      expect(res.data).toContain("escrow,400,USDC");
    });

    it("exports report using synchronous exportFinancialReport helper", () => {
      const res = exportFinancialReport({ amount: 500, currency: "XLM" });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.rowCount).toBe(1);
        expect(res.data).toContain("total,500,XLM");
      }
    });

    it("rejects negative amount in exportFinancialReport without throwing", () => {
      const res = exportFinancialReport({ amount: -500 });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.NEGATIVE_PARAMETER);
      }
    });
  });
});
