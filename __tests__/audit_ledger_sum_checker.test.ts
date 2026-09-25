import {
  MAX_SAFE_DIGITS,
  ERROR_CODES,
  validateLedgerAmount,
  sumLedgerAmounts,
} from "../src/utils/audit_ledger_sum_checker.js";

describe("audit_ledger_sum_checker overflow validation", () => {
  describe("validateLedgerAmount", () => {
    it("accepts values within the digit limit", () => {
      const result = validateLedgerAmount("123456789012345");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(123456789012345n);
      }
    });

    it("accepts bigint and number inputs within limits", () => {
      expect(validateLedgerAmount(999n).ok).toBe(true);
      expect(validateLedgerAmount(42).ok).toBe(true);
    });

    it("rejects excessive digits with OVERFLOW_EXCESSIVE_DIGITS", () => {
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const result = validateLedgerAmount(tooBig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
        expect(result.error).toMatch(/exceeds maximum/i);
      }
    });

    it("rejects non-integer strings with OVERFLOW_INVALID_AMOUNT", () => {
      const result = validateLedgerAmount("12.5");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects non-finite numbers", () => {
      const result = validateLedgerAmount(Number.POSITIVE_INFINITY);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });
  });

  describe("sumLedgerAmounts", () => {
    it("sums valid ledger amounts", () => {
      const result = sumLedgerAmounts(["10", "20", 5n]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(35n);
      }
    });

    it("blocks an entry with excessive digits before summing", () => {
      const excessive = "9".repeat(MAX_SAFE_DIGITS + 1);
      const result = sumLedgerAmounts(["1", excessive]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

    it("blocks when the running sum overflows the digit limit", () => {
      const half = "9".repeat(MAX_SAFE_DIGITS);
      const result = sumLedgerAmounts([half, half]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.SUM_OVERFLOW);
      }
    });
  });
});
