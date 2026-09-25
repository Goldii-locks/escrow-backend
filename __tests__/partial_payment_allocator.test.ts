import {
  MAX_SAFE_DIGITS,
  MAX_INTERMEDIATE_DIGITS,
  ERROR_CODES,
  validatePaymentAmount,
  allocatePartialPayment,
  getTokenConfig,
  validateTokenConfig,
  allocatePartialPaymentWithTicker,
  DEFAULT_TOKEN_CONFIG,
  FALLBACK_TOKEN_CONFIG,
} from "../src/utils/partial_payment_allocator.js";

describe("partial_payment_allocator overflow validation", () => {
  describe("validatePaymentAmount", () => {
    it("accepts values within the digit limit", () => {
      const result = validatePaymentAmount("123456789012345");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(123456789012345n);
      }
    });

    it("accepts bigint and number inputs within limits", () => {
      expect(validatePaymentAmount(999n).ok).toBe(true);
      expect(validatePaymentAmount(1000).ok).toBe(true);
    });

    it("rejects excessive digits with ALLOCATOR_EXCESSIVE_DIGITS", () => {
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const result = validatePaymentAmount(tooBig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
        expect(result.error).toMatch(/exceeds maximum/i);
      }
    });

    it("rejects non-integer strings with ALLOCATOR_INVALID_AMOUNT", () => {
      const result = validatePaymentAmount("12.5");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects non-finite numbers", () => {
      const result = validatePaymentAmount(Number.POSITIVE_INFINITY);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });
  });

  describe("allocatePartialPayment", () => {
    it("splits a total amount across equal shares correctly", () => {
      const result = allocatePartialPayment(1000, [1, 1, 1]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.allocations).toHaveLength(3);
        const sum = result.allocations.reduce((a, b) => a + b, 0n);
        expect(sum + result.remainder).toBe(1000n);
      }
    });

    it("splits across unequal weighted shares correctly", () => {
      const result = allocatePartialPayment(1000, [70, 20, 10]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.allocations).toEqual([700n, 200n, 100n]);
        const sum = result.allocations.reduce((a, b) => a + b, 0n);
        expect(sum + result.remainder).toBe(1000n);
      }
    });

    it("rejects an invalid total amount, propagating INVALID_AMOUNT", () => {
      const result = allocatePartialPayment("12.5", [1, 1]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects a total amount with excessive digits, propagating EXCESSIVE_DIGITS", () => {
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const result = allocatePartialPayment(tooBig, [1, 1]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

    it("rejects an empty shares array with ALLOCATOR_INVALID_SHARES", () => {
      const result = allocatePartialPayment(1000, []);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_SHARES);
      }
    });

    it("rejects a shares array containing zero or negative values", () => {
      const zeroResult = allocatePartialPayment(1000, [1, 0]);
      expect(zeroResult.ok).toBe(false);
      if (!zeroResult.ok) {
        expect(zeroResult.code).toBe(ERROR_CODES.INVALID_SHARES);
      }

      const negativeResult = allocatePartialPayment(1000, [1, -5]);
      expect(negativeResult.ok).toBe(false);
      if (!negativeResult.ok) {
        expect(negativeResult.code).toBe(ERROR_CODES.INVALID_SHARES);
      }
    });

    it("rejects a shares array containing non-finite values", () => {
      const result = allocatePartialPayment(1000, [1, Number.POSITIVE_INFINITY]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_SHARES);
      }
    });

    it("blocks an allocation whose intermediate multiplication would overflow", () => {
      // A total amount right at the max allowed digit count (15 nines) combined
      // with a large share numerator forces the intermediate product
      // (total * scaledNumerator) well past MAX_INTERMEDIATE_DIGITS.
      const hugeTotal = "9".repeat(MAX_SAFE_DIGITS);
      const result = allocatePartialPayment(hugeTotal, [5_000_000_000, 1]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.ALLOCATION_OVERFLOW);
        expect(result.error).toMatch(/overflow/i);
      }
    });

    it("never lets allocations + remainder drift from the original total", () => {
      const result = allocatePartialPayment(123457, [3, 3, 3, 1]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const sum = result.allocations.reduce((a, b) => a + b, 0n);
        expect(sum + result.remainder).toBe(123457n);
      }
    });

    it("exposes MAX_INTERMEDIATE_DIGITS as a wider bound than MAX_SAFE_DIGITS", () => {
      expect(MAX_INTERMEDIATE_DIGITS).toBeGreaterThan(MAX_SAFE_DIGITS);
    });
  });

  describe("negative amount rejection", () => {
    it("rejects negative totalAmount as string with NEGATIVE_AMOUNT", () => {
      const result = allocatePartialPayment("-1000", [1, 1]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.NEGATIVE_AMOUNT);
        expect(result.error).toMatch(/must be non-negative/i);
      }
    });

    it("rejects negative totalAmount as number with NEGATIVE_AMOUNT", () => {
      const result = allocatePartialPayment(-500, [1, 1]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.NEGATIVE_AMOUNT);
      }
    });

    it("rejects negative totalAmount as bigint with NEGATIVE_AMOUNT", () => {
      const result = allocatePartialPayment(-100n, [1, 1]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.NEGATIVE_AMOUNT);
      }
    });

    it("rejects negative zero string with NEGATIVE_AMOUNT", () => {
      const result = allocatePartialPayment("-0", [1, 1]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.NEGATIVE_AMOUNT);
      }
    });

    it("validatePaymentAmount rejects negative string directly", () => {
      const result = validatePaymentAmount("-100");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.NEGATIVE_AMOUNT);
      }
    });

    it("validatePaymentAmount rejects negative number directly", () => {
      const result = validatePaymentAmount(-50);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.NEGATIVE_AMOUNT);
      }
    });

    it("validatePaymentAmount rejects negative bigint directly", () => {
      const result = validatePaymentAmount(-1n);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.NEGATIVE_AMOUNT);
      }
    });

    it("accepts zero as valid amount", () => {
      const result = allocatePartialPayment(0, [1, 1]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.allocations).toEqual([0n, 0n]);
        expect(result.remainder).toBe(0n);
      }
    });
  });

  describe("mismatched parameter type rejection", () => {
    it("rejects null totalAmount with INVALID_AMOUNT", () => {
      const result = validatePaymentAmount(null as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
        expect(result.error).toMatch(/must be a string, number, or bigint/i);
      }
    });

    it("rejects undefined totalAmount with INVALID_AMOUNT", () => {
      const result = validatePaymentAmount(undefined as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects object totalAmount with INVALID_AMOUNT", () => {
      const result = validatePaymentAmount({ value: 100 } as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects array totalAmount with INVALID_AMOUNT", () => {
      const result = validatePaymentAmount([100] as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects boolean totalAmount with INVALID_AMOUNT", () => {
      const result = validatePaymentAmount(true as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects null shares with INVALID_SHARES", () => {
      const result = allocatePartialPayment(1000, null as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_SHARES);
      }
    });

    it("rejects object shares with INVALID_SHARES", () => {
      const result = allocatePartialPayment(1000, {} as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_SHARES);
      }
    });

    it("rejects string shares with INVALID_SHARES", () => {
      const result = allocatePartialPayment(1000, "1,2" as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_SHARES);
      }
    });
  });

  describe("token configuration and ticker fallback", () => {
    it("DEFAULT_TOKEN_CONFIG contains known tickers", () => {
      expect(DEFAULT_TOKEN_CONFIG.XLM).toEqual({ decimals: 7 });
      expect(DEFAULT_TOKEN_CONFIG.USDC).toEqual({ decimals: 7 });
      expect(DEFAULT_TOKEN_CONFIG.EURC).toEqual({ decimals: 6 });
      expect(DEFAULT_TOKEN_CONFIG.XRP).toEqual({ decimals: 6 });
    });

    it("FALLBACK_TOKEN_CONFIG has default decimals", () => {
      expect(FALLBACK_TOKEN_CONFIG.decimals).toBe(7);
    });

    it("getTokenConfig returns known config for XLM", () => {
      const config = getTokenConfig("XLM");
      expect(config).toEqual({ decimals: 7 });
    });

    it("getTokenConfig returns known config for USDC", () => {
      const config = getTokenConfig("USDC");
      expect(config).toEqual({ decimals: 7 });
    });

    it("getTokenConfig returns known config for lowercase ticker", () => {
      const config = getTokenConfig("xlm");
      expect(config).toEqual({ decimals: 7 });
    });

    it("getTokenConfig returns fallback for unknown ticker", () => {
      const config = getTokenConfig("UNKNOWN");
      expect(config).toEqual(FALLBACK_TOKEN_CONFIG);
    });

    it("getTokenConfig returns fallback for random ticker", () => {
      const config = getTokenConfig("RANDOM123");
      expect(config).toEqual(FALLBACK_TOKEN_CONFIG);
    });

    it("validateTokenConfig accepts known ticker", () => {
      const result = validateTokenConfig("XLM");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ decimals: 7 });
      }
    });

    it("validateTokenConfig accepts unknown ticker with fallback", () => {
      const result = validateTokenConfig("UNKNOWN_TOKEN");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(FALLBACK_TOKEN_CONFIG);
      }
    });

    it("validateTokenConfig rejects empty string", () => {
      const result = validateTokenConfig("");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.UNKNOWN_TICKER);
      }
    });

    it("validateTokenConfig rejects null", () => {
      const result = validateTokenConfig(null as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.UNKNOWN_TICKER);
      }
    });

    it("validateTokenConfig rejects non-string", () => {
      const result = validateTokenConfig(123 as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.UNKNOWN_TICKER);
      }
    });

    it("allocatePartialPaymentWithTicker works with known ticker XLM", () => {
      const result = allocatePartialPaymentWithTicker(1000, [70, 20, 10], "XLM");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.allocations).toEqual([700n, 200n, 100n]);
        expect(result.ticker).toBe("XLM");
        expect(result.decimals).toBe(7);
        expect(result.remainder).toBe(0n);
      }
    });

    it("allocatePartialPaymentWithTicker works with known ticker USDC", () => {
      const result = allocatePartialPaymentWithTicker(1000, [50, 50], "USDC");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.allocations).toEqual([500n, 500n]);
        expect(result.ticker).toBe("USDC");
        expect(result.decimals).toBe(7);
      }
    });

    it("allocatePartialPaymentWithTicker uses fallback for unknown ticker", () => {
      const result = allocatePartialPaymentWithTicker(1000, [1, 1], "RANDOM_TOKEN");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.allocations).toEqual([500n, 500n]);
        expect(result.ticker).toBe("RANDOM_TOKEN");
        expect(result.decimals).toBe(7); // fallback decimals
      }
    });

    it("allocatePartialPaymentWithTicker uses fallback for lowercase unknown ticker", () => {
      const result = allocatePartialPaymentWithTicker(1000, [3, 1], "unknown");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.allocations).toEqual([750n, 250n]);
        expect(result.ticker).toBe("UNKNOWN");
        expect(result.decimals).toBe(7);
      }
    });

    it("allocatePartialPaymentWithTicker propagates allocation errors", () => {
      const result = allocatePartialPaymentWithTicker("12.5", [1, 1], "XLM");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("allocatePartialPaymentWithTicker propagates negative amount error", () => {
      const result = allocatePartialPaymentWithTicker(-1000, [1, 1], "XLM");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.NEGATIVE_AMOUNT);
      }
    });

    it("allocatePartialPaymentWithTicker handles zero amount", () => {
      const result = allocatePartialPaymentWithTicker(0, [1, 1], "XLM");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.allocations).toEqual([0n, 0n]);
        expect(result.remainder).toBe(0n);
        expect(result.ticker).toBe("XLM");
      }
    });

    it("allocatePartialPaymentWithTicker handles large amounts", () => {
      const result = allocatePartialPaymentWithTicker(999999999999999n, [50, 50], "XLM");
      expect(result.ok).toBe(true);
      if (result.ok) {
        // With SHARE_SCALE rounding, 999999999999999 / 2 = 499999999999999.5 -> both get 499999999999999
        expect(result.allocations).toEqual([499999999999999n, 499999999999999n]);
        expect(result.remainder).toBe(1n);
      }
    });

    it("allocatePartialPaymentWithTicker handles many shares", () => {
      const shares = Array(10).fill(10);
      const result = allocatePartialPaymentWithTicker(10000, shares, "USDC");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.allocations).toHaveLength(10);
        expect(result.allocations.every(a => a === 1000n)).toBe(true);
        expect(result.ticker).toBe("USDC");
      }
    });
  });

  describe("numeric allocation verification", () => {
    it("allocates 1000 across [1, 1] = [500, 500]", () => {
      const result = allocatePartialPayment(1000, [1, 1]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.allocations).toEqual([500n, 500n]);
        expect(result.remainder).toBe(0n);
      }
    });

    it("allocates 1000 across [3, 2] = [600, 400]", () => {
      const result = allocatePartialPayment(1000, [3, 2]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.allocations).toEqual([600n, 400n]);
        expect(result.remainder).toBe(0n);
      }
    });

    it("allocates 100 across [1, 2, 3] = [16, 33, 50] remainder 1", () => {
      const result = allocatePartialPayment(100, [1, 2, 3]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.allocations).toEqual([16n, 33n, 50n]);
        expect(result.remainder).toBe(1n);
      }
    });

    it("allocates 999 across [1, 1] = [499, 499] remainder 1", () => {
      const result = allocatePartialPayment(999, [1, 1]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.allocations).toEqual([499n, 499n]);
        expect(result.remainder).toBe(1n);
      }
    });

    it("single share gets full amount", () => {
      const result = allocatePartialPayment(500, [1]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.allocations).toEqual([500n]);
        expect(result.remainder).toBe(0n);
      }
    });

    it("allocations sum plus remainder equals original total", () => {
      const testCases = [
        { total: 1000, shares: [1, 1] },
        { total: 1000, shares: [3, 2, 1] },
        { total: 123457, shares: [3, 3, 3, 1] },
        { total: 999, shares: [1, 1] },
        { total: 100, shares: [1, 2, 3] },
      ];

      for (const tc of testCases) {
        const result = allocatePartialPayment(tc.total, tc.shares);
        expect(result.ok).toBe(true);
        if (result.ok) {
          const sum = result.allocations.reduce((a, b) => a + b, 0n);
          expect(sum + result.remainder).toBe(BigInt(tc.total));
        }
      }
    });
  });
});
