import { describe, it, expect } from "@jest/globals";
import {
  toRawUnits,
  toHumanUnits,
  createTokenBucket as createDecimalsTokenBucket,
  ERROR_CODES as DECIMALS_ERROR_CODES,
} from "../src/utils/token_decimals_converter.js";
import {
  calculateTaxDeduction,
  previewTaxWithholding,
  createTaxTokenBucket,
  ERROR_CODES as TAX_ERROR_CODES,
} from "../src/utils/tax_deduction_estimator.js";
import {
  sumLedgerAmounts,
  createAuditTokenBucket,
  ERROR_CODES as AUDIT_ERROR_CODES,
} from "../src/utils/audit_ledger_sum_checker.js";
import {
  validateConversionRate,
  createConversionRateTokenBucket,
  ERROR_CODES as SCRAPER_ERROR_CODES,
} from "../src/utils/conversion_rate_math.js";

describe("Pure math functions rate limit opt-in", () => {
  describe("token_decimals_converter", () => {
    it("calling toRawUnits 5,000 times in a loop never returns DECIMALS_RATE_LIMITED without explicit limiter", () => {
      for (let i = 0; i < 5000; i++) {
        const result = toRawUnits("10.5", 7);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(105000000n);
        }
      }
    });

    it("calling toHumanUnits 5,000 times in a loop never returns rate limited without explicit limiter", () => {
      for (let i = 0; i < 5000; i++) {
        const result = toHumanUnits(105000000n, 7);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe("10.5");
        }
      }
    });

    it("rate limits toRawUnits only when an explicit limiter is passed", () => {
      const limiter = createDecimalsTokenBucket({ maxCalls: 5 });
      for (let i = 0; i < 5; i++) {
        const res = toRawUnits("1.0", 7, { limiter });
        expect(res.ok).toBe(true);
      }
      const denied = toRawUnits("1.0", 7, { limiter });
      expect(denied.ok).toBe(false);
      if (!denied.ok) {
        expect(denied.code).toBe(DECIMALS_ERROR_CODES.RATE_LIMITED);
      }
    });
  });

  describe("tax_deduction_estimator", () => {
    it("calling calculateTaxDeduction 5,000 times in a loop never returns RATE_LIMITED without explicit limiter", () => {
      for (let i = 0; i < 5000; i++) {
        const result = calculateTaxDeduction("1000", "500");
        expect(result.ok).toBe(true);
      }
    });

    it("calling previewTaxWithholding 5,000 times in a loop never returns RATE_LIMITED without explicit limiter", () => {
      for (let i = 0; i < 5000; i++) {
        const result = previewTaxWithholding("1000", "500");
        expect(result.ok).toBe(true);
      }
    });

    it("rate limits calculateTaxDeduction when an explicit limiter is passed", () => {
      const limiter = createTaxTokenBucket({ maxCalls: 3 });
      for (let i = 0; i < 3; i++) {
        const res = calculateTaxDeduction("1000", "500", undefined, { limiter });
        expect(res.ok).toBe(true);
      }
      const denied = calculateTaxDeduction("1000", "500", undefined, { limiter });
      expect(denied.ok).toBe(false);
      if (!denied.ok) {
        expect(denied.code).toBe(TAX_ERROR_CODES.RATE_LIMITED);
      }
    });
  });

  describe("audit_ledger_sum_checker", () => {
    it("calling sumLedgerAmounts 5,000 times in a loop never returns RATE_LIMITED without explicit limiter", () => {
      for (let i = 0; i < 5000; i++) {
        const result = sumLedgerAmounts(["100", "200"]);
        expect(result.ok).toBe(true);
      }
    });

    it("rate limits sumLedgerAmounts when an explicit limiter is passed", () => {
      const limiter = createAuditTokenBucket({ maxCalls: 3 });
      for (let i = 0; i < 3; i++) {
        const res = sumLedgerAmounts(["100", "200"], { limiter });
        expect(res.ok).toBe(true);
      }
      const denied = sumLedgerAmounts(["100", "200"], { limiter });
      expect(denied.ok).toBe(false);
      if (!denied.ok) {
        expect(denied.code).toBe(AUDIT_ERROR_CODES.RATE_LIMITED);
      }
    });
  });

  describe("conversion_rate_math (scraper)", () => {
    it("calling validateConversionRate 5,000 times in a loop never returns RATE_LIMIT_EXCEEDED without explicit limiter", () => {
      for (let i = 0; i < 5000; i++) {
        const result = validateConversionRate("12345");
        expect(result.ok).toBe(true);
      }
    });

    it("rate limits validateConversionRate when an explicit limiter is passed", () => {
      const limiter = createConversionRateTokenBucket({ maxCalls: 3 });
      for (let i = 0; i < 3; i++) {
        const res = validateConversionRate("12345", { limiter });
        expect(res.ok).toBe(true);
      }
      const denied = validateConversionRate("12345", { limiter });
      expect(denied.ok).toBe(false);
      if (!denied.ok) {
        expect(denied.code).toBe(SCRAPER_ERROR_CODES.RATE_LIMIT_EXCEEDED);
      }
    });
  });
});
