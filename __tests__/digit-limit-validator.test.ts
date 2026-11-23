import {
  digitCount,
  parseIntegerInput,
  MAX_SAFE_DIGITS,
} from "../src/utils/digit-limit-validator.js";
import { MAX_SAFE_DIGITS as AUDIT_MAX } from "../src/utils/audit_ledger_sum_checker.js";
import { MAX_SAFE_DIGITS as ESTIMATOR_MAX } from "../src/utils/interest_yield_estimator.js";

// Smallest amount outside the contract's i128 range (i128 max + 1).
const OVER_I128 = (2n ** 127n).toString();
// The largest amount the contract accepts.
const I128_MAX = (2n ** 127n - 1n).toString();

describe("digit-limit-validator shared module (#530)", () => {
  describe("MAX_SAFE_DIGITS", () => {
    it("exposes 15 as the shared limit", () => {
      expect(MAX_SAFE_DIGITS).toBe(15);
    });

    it("is re-exported unchanged by its callers", () => {
      expect(AUDIT_MAX).toBe(MAX_SAFE_DIGITS);
      expect(ESTIMATOR_MAX).toBe(MAX_SAFE_DIGITS);
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

    it("rejects values outside the i128 range with the out-of-range code", () => {
      const tooBig = OVER_I128;
      for (const input of [tooBig, tooBig] as const) {
        const res = parseIntegerInput(input, "amount", INVALID, EXCESSIVE);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.code).toBe(EXCESSIVE);
      }
      const bigNum = parseIntegerInput(
        BigInt(OVER_I128),
        "amount",
        INVALID,
        EXCESSIVE
      );
      expect(bigNum.ok).toBe(false);
      if (!bigNum.ok) expect(bigNum.code).toBe(EXCESSIVE);
    });

    it("accepts amounts above the old 15-digit cap up to i128 max (#698)", () => {
      const twentyDigits = "1" + "0".repeat(19);
      expect(parseIntegerInput(twentyDigits, "a", INVALID, EXCESSIVE).ok).toBe(true);
      expect(parseIntegerInput(I128_MAX, "a", INVALID, EXCESSIVE).ok).toBe(true);
      expect(parseIntegerInput(BigInt(I128_MAX), "a", INVALID, EXCESSIVE).ok).toBe(true);
      expect(parseIntegerInput((-(2n ** 127n)).toString(), "a", INVALID, EXCESSIVE).ok).toBe(true);
    });

    it("rejects i128 min - 1 with the out-of-range code", () => {
      const res = parseIntegerInput((-(2n ** 127n) - 1n).toString(), "a", INVALID, EXCESSIVE);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe(EXCESSIVE);
    });

    it("accepts safe-integer numbers but rejects numbers above 2^53", () => {
      expect(parseIntegerInput(Number.MAX_SAFE_INTEGER, "a", INVALID, EXCESSIVE).ok).toBe(true);
      // 2^53 + 1 is not representable, so a number this large is already wrong.
      const res = parseIntegerInput(2 ** 53 + 2, "a", INVALID, EXCESSIVE);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(INVALID);
        expect(res.error).toMatch(/pass large amounts as a string/);
      }
    });
  });
});
