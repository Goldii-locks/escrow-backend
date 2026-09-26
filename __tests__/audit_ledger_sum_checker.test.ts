import {
  MAX_SAFE_DIGITS,
  ERROR_CODES,
  validateLedgerAmount,
  sumLedgerAmounts,
  // Task 4 – rounding policies
  roundHalfEven,
  divideWithRounding,
  applyRoundedScale,
  // Issue #501 – split-sum assertions
  assertLedgerSplitSum,
} from "../src/utils/audit_ledger_sum_checker.js";

// ---------------------------------------------------------------------------
// Existing overflow validation tests
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// TASK 4 – Decimal rounding policies
// ---------------------------------------------------------------------------

describe("audit_ledger_sum_checker rounding policies", () => {
  describe("roundHalfEven", () => {
    // Banker's rounding: round half to nearest even
    //   3 / 2  = 1.5  → rounds to 2  (nearest even)
    //   5 / 2  = 2.5  → rounds to 2  (nearest even – 2 is even)
    //   7 / 2  = 3.5  → rounds to 4  (nearest even)
    //   9 / 2  = 4.5  → rounds to 4  (nearest even)
    //   1 / 4  = 0.25 → rounds to 0  (< 0.5)
    //   3 / 4  = 0.75 → rounds to 1  (> 0.5)

    it("rounds 1/2 = 0.5 up to 1 (nearest even from 0)", () => {
      // quotient=0, remainder=1, 2*1 == 2 === denominator and quotient 0 is even → truncate → 0
      const result = roundHalfEven(1n, 2n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // 1/2 = 0 remainder 1; quotient(0) is even → stay at 0
        expect(result.value).toBe(0n);
      }
    });

    it("rounds 3/2 = 1.5 up to 2 (nearest even from 1)", () => {
      // quotient=1, remainder=1, 2*1 == 2 === denominator, quotient(1) is odd → round up
      const result = roundHalfEven(3n, 2n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2n);
      }
    });

    it("rounds 5/2 = 2.5 to 2 (nearest even from 2 – already even)", () => {
      // quotient=2, remainder=1, 2*1 == denominator, quotient(2) is even → truncate
      const result = roundHalfEven(5n, 2n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2n);
      }
    });

    it("rounds 7/2 = 3.5 up to 4 (nearest even from 3)", () => {
      // quotient=3, remainder=1, quotient is odd → round up
      const result = roundHalfEven(7n, 2n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(4n);
      }
    });

    it("truncates when fractional part is less than 0.5", () => {
      // 1/4 = 0.25 → 0
      const result = roundHalfEven(1n, 4n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0n);
      }
    });

    it("rounds up when fractional part is greater than 0.5", () => {
      // 3/4 = 0.75 → 1
      const result = roundHalfEven(3n, 4n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1n);
      }
    });

    it("returns remainder in the result", () => {
      // 7 / 3 = 2 remainder 1
      const result = roundHalfEven(7n, 3n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.remainder).toBe(1n);
      }
    });

    it("handles exact division (no rounding needed)", () => {
      const result = roundHalfEven(10n, 2n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(5n);
        expect(result.remainder).toBe(0n);
      }
    });

    it("rejects non-bigint inputs", () => {
      const result = roundHalfEven(3 as unknown as bigint, 2n);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.ROUNDING_INVALID_INPUT);
      }
    });

    it("rejects a negative numerator", () => {
      const result = roundHalfEven(-1n, 2n);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.ROUNDING_INVALID_INPUT);
      }
    });

    it("rejects a zero denominator", () => {
      const result = roundHalfEven(5n, 0n);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.ROUNDING_SCALE_INVALID);
      }
    });

    it("rejects a negative denominator", () => {
      const result = roundHalfEven(5n, -1n);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.ROUNDING_SCALE_INVALID);
      }
    });

    it("does not lose remainder value – sum invariant holds", () => {
      // For any rounding: value * denominator + remainder === numerator
      const numerator = 17n;
      const denominator = 5n;
      const result = roundHalfEven(numerator, denominator);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value * denominator + result.remainder).toBe(numerator);
      }
    });
  });

  describe("divideWithRounding", () => {
    it("splits an amount into equal parts with no remainder", () => {
      const result = divideWithRounding("100", 4);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.parts).toHaveLength(4);
        expect(result.parts.every((p) => p === 25n)).toBe(true);
        expect(result.parts.reduce((a, b) => a + b, 0n)).toBe(100n);
      }
    });

    it("distributes dust so parts always sum to amount", () => {
      // 10 / 3 = 3 remainder 1 → parts should be [4, 3, 3]
      const result = divideWithRounding("10", 3);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.parts.reduce((a, b) => a + b, 0n)).toBe(10n);
        expect(result.parts).toHaveLength(3);
      }
    });

    it("parts always sum exactly to the original amount", () => {
      for (const [amount, divisor] of [
        ["7", 2],
        ["13", 4],
        ["100", 7],
        ["999", 13],
      ] as [string, number][]) {
        const result = divideWithRounding(amount, divisor);
        expect(result.ok).toBe(true);
        if (result.ok) {
          const sum = result.parts.reduce((a, b) => a + b, 0n);
          expect(sum).toBe(BigInt(amount));
        }
      }
    });

    it("rejects a non-positive divisor", () => {
      const result = divideWithRounding("100", 0);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.ROUNDING_SCALE_INVALID);
      }
    });

    it("rejects a fractional divisor", () => {
      const result = divideWithRounding("100", 2.5);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.ROUNDING_SCALE_INVALID);
      }
    });

    it("rejects an amount with excessive digits", () => {
      const excessive = "9".repeat(MAX_SAFE_DIGITS + 1);
      const result = divideWithRounding(excessive, 2);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });
  });

  describe("applyRoundedScale", () => {
    it("multiplies amount by a scale fraction and rounds half-to-even", () => {
      // 100 * 1 / 3 = 33.333... → 33 (< 0.5 fractional part)
      const result = applyRoundedScale("100", "1", "3");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(33n);
      }
    });

    it("rounds 5/2 = 2.5 to 2 (even) using half-to-even", () => {
      // amount=5, numerator=1, denominator=2 → 5*1/2 = 2.5 → rounds to 2
      const result = applyRoundedScale("5", "1", "2");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2n);
      }
    });

    it("rounds 3*1/2 = 1.5 to 2 (odd quotient rounds up)", () => {
      const result = applyRoundedScale("3", "1", "2");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2n);
      }
    });

    it("handles exact-integer results with no rounding", () => {
      // 200 * 3 / 4 = 150 exactly
      const result = applyRoundedScale("200", "3", "4");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(150n);
        expect(result.remainder).toBe(0n);
      }
    });

    it("rejects a zero denominator", () => {
      const result = applyRoundedScale("100", "1", "0");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.ROUNDING_SCALE_INVALID);
      }
    });

    it("rejects an invalid (non-integer) amount", () => {
      const result = applyRoundedScale("10.5", "1", "2");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects an amount exceeding the digit limit", () => {
      const excessive = "9".repeat(MAX_SAFE_DIGITS + 1);
      const result = applyRoundedScale(excessive, "1", "2");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

    it("does not drop or leak remainder – invariant: value*denom + remainder == amount*num", () => {
      const amount = 7n;
      const num = 3n;
      const denom = 4n;
      const result = applyRoundedScale(amount, num, denom);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value * denom + result.remainder).toBe(amount * num);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Issue #501 � split-sum assertions
// ---------------------------------------------------------------------------

describe("audit_ledger_sum_checker split-sum assertions", () => {
  it("confirms matching split totals", () => {
    const result = assertLedgerSplitSum(["10", "20", 5n], "35");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.isMatch).toBe(true);
      expect(result.total).toBe(35n);
    }
  });

  it("reports mismatched allocations without failing in default mode", () => {
    const result = assertLedgerSplitSum(["10", "20"], "35");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.isMatch).toBe(false);
      expect(result.total).toBe(30n);
    }
  });

  it("rejects mismatched allocations in reject mode", () => {
    const result = assertLedgerSplitSum(["10", "20"], "35", "reject");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.SUM_MISMATCH);
      expect(result.error).toMatch(/does not match/);
    }
  });

  it("rejects an empty splits array", () => {
    const result = assertLedgerSplitSum([], "0");
    expect(result.ok).toBe(false);
  });

  it("rejects splits with excessive digits before summing", () => {
    const excessive = "9".repeat(MAX_SAFE_DIGITS + 1);
    const result = assertLedgerSplitSum(["1", excessive], "1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
    }
  });

  it("rejects an invalid base amount", () => {
    const result = assertLedgerSplitSum(["10"], "10.5");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
    }
  });

  it("blocks a running total that overflows the digit limit", () => {
    const half = "9".repeat(MAX_SAFE_DIGITS);
    const result = assertLedgerSplitSum([half, half], half);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.SUM_OVERFLOW);
    }
  });
});
