import {
  digitCount,
  parseIntegerInput,
  MAX_SAFE_DIGITS,
} from "../src/utils/digit-limit-validator.js";
import { MAX_SAFE_DIGITS as AUDIT_MAX } from "../src/utils/audit_ledger_sum_checker.js";
import { MAX_SAFE_DIGITS as SCRAPER_MAX } from "../src/utils/conversion_rate_scraper.js";
import { MAX_SAFE_DIGITS as ESTIMATOR_MAX } from "../src/utils/interest_yield_estimator.js";
import { MAX_SAFE_DIGITS as REFUND_MAX } from "../src/utils/refund_ratio_helper.js";

describe("digit-limit-validator shared module (#530)", () => {
  describe("MAX_SAFE_DIGITS", () => {
    it("exposes 15 as the shared limit", () => {
      expect(MAX_SAFE_DIGITS).toBe(15);
    });

    it("is re-exported unchanged by all four callers", () => {
      expect(AUDIT_MAX).toBe(MAX_SAFE_DIGITS);
      expect(SCRAPER_MAX).toBe(MAX_SAFE_DIGITS);
      expect(ESTIMATOR_MAX).toBe(MAX_SAFE_DIGITS);
      expect(REFUND_MAX).toBe(MAX_SAFE_DIGITS);
    });
  });

  describe("digitCount", () => {
    it("counts plain digits", () => {
      expect(digitCount("123")).toBe(3);
      expect(digitCount("0")).toBe(1);
      expect(digitCount("")).toBe(1);
    });

    it("strips a leading minus", () => {
      expect(digitCount("-12345")).toBe(5);
    });

    it("strips leading zeroes but keeps at least one digit", () => {
      expect(digitCount("000123")).toBe(3);
      expect(digitCount("0000")).toBe(1);
    });

    it("enforces the digit-limit boundary", () => {
      const atLimit = "9".repeat(MAX_SAFE_DIGITS);
      const overLimit = "9".repeat(MAX_SAFE_DIGITS + 1);
      expect(digitCount(atLimit)).toBe(MAX_SAFE_DIGITS);
      expect(digitCount(overLimit)).toBe(MAX_SAFE_DIGITS + 1);
      expect(digitCount(atLimit) > MAX_SAFE_DIGITS).toBe(false);
      expect(digitCount(overLimit) > MAX_SAFE_DIGITS).toBe(true);
    });
  });

  describe("parseIntegerInput input types", () => {
    const INVALID = "TEST_INVALID" as const;
    const EXCESSIVE = "TEST_EXCESSIVE" as const;

    it("accepts string inputs", () => {
      const res = parseIntegerInput("12345", "amount", INVALID, EXCESSIVE);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value).toBe(12345n);
    });

    it("trims whitespace on strings", () => {
      const res = parseIntegerInput("  42  ", "amount", INVALID, EXCESSIVE);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value).toBe(42n);
    });

    it("accepts number inputs", () => {
      const res = parseIntegerInput(999, "amount", INVALID, EXCESSIVE);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value).toBe(999n);
    });

    it("accepts bigint inputs", () => {
      const res = parseIntegerInput(123456789n, "amount", INVALID, EXCESSIVE);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value).toBe(123456789n);
    });

    it("rejects non-integer strings with the invalid-input code", () => {
      const res = parseIntegerInput("12.5", "amount", INVALID, EXCESSIVE);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe(INVALID);
    });

    it("rejects non-finite and non-integer numbers with the invalid-input code", () => {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
        const res = parseIntegerInput(bad, "amount", INVALID, EXCESSIVE);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.code).toBe(INVALID);
      }
    });

    it("accepts negative values (regex /^-?\\d+$/ behaviour preserved)", () => {
      const res = parseIntegerInput("-42", "amount", INVALID, EXCESSIVE);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value).toBe(-42n);
    });

    it("rejects values over the digit limit with the excessive-digits code", () => {
      const tooBig = "9".repeat(MAX_SAFE_DIGITS + 1);
      for (const input of [tooBig, tooBig] as const) {
        const res = parseIntegerInput(input, "amount", INVALID, EXCESSIVE);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.code).toBe(EXCESSIVE);
      }
      const bigNum = parseIntegerInput(
        BigInt("9".repeat(MAX_SAFE_DIGITS + 1)),
        "amount",
        INVALID,
        EXCESSIVE
      );
      expect(bigNum.ok).toBe(false);
      if (!bigNum.ok) expect(bigNum.code).toBe(EXCESSIVE);
    });

    it("accepts exactly MAX_SAFE_DIGITS digits (boundary)", () => {
      const atLimit = "9".repeat(MAX_SAFE_DIGITS);
      expect(parseIntegerInput(atLimit, "a", INVALID, EXCESSIVE).ok).toBe(true);
      expect(parseIntegerInput(Number("9".repeat(15)), "a", INVALID, EXCESSIVE).ok).toBe(true);
      expect(parseIntegerInput(BigInt(atLimit), "a", INVALID, EXCESSIVE).ok).toBe(true);
    });
  });
});
