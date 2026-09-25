import {
  BASIS_POINTS_DIVISOR,
  FINANCIAL_REPORT_MATH_ERRORS,
  applyFeeBasisPoints,
  convertMinorDecimals,
  divideHalfEven,
  netAmount,
  parseMinorAmount,
  reconcileTotals,
  splitByWeights,
  sumAmounts,
} from "../src/utils/financial_report_math.js";

// Amounts are 7-decimal minor units (stroops) unless stated otherwise.
// Every expected value below was derived by hand from the integer arithmetic,
// so these assertions pin the exporter's documented calculation outcomes.

describe("financial_report_math", () => {
  describe("parseMinorAmount", () => {
    it("parses integer inputs and rejects non-integers", () => {
      const ok = parseMinorAmount("15000000");
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.value).toBe(15000000n);

      expect(parseMinorAmount("1.5").ok).toBe(false);
    });

    it("rejects negative amounts", () => {
      const result = parseMinorAmount(-1n);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(FINANCIAL_REPORT_MATH_ERRORS.INVALID_AMOUNT);
        expect(result.error).toMatch(/negative/);
      }
    });

    it("rejects values beyond the 15-digit limit", () => {
      expect(parseMinorAmount("1" + "0".repeat(15)).ok).toBe(false);
    });
  });

  describe("divideHalfEven", () => {
    it("rounds a true half to the even neighbour", () => {
      expect(divideHalfEven(5000n, 10000n)).toBe(0n); // 0.5 -> 0 (even)
      expect(divideHalfEven(15000n, 10000n)).toBe(2n); // 1.5 -> 2 (even)
      expect(divideHalfEven(25000n, 10000n)).toBe(2n); // 2.5 -> 2 (even)
      expect(divideHalfEven(35000n, 10000n)).toBe(4n); // 3.5 -> 4 (even)
    });

    it("rounds away from a half normally", () => {
      expect(divideHalfEven(149999n, 100000n)).toBe(1n); // 1.49999
      expect(divideHalfEven(150001n, 100000n)).toBe(2n); // 1.50001
    });
  });

  describe("sumAmounts", () => {
    it("sums a ledger of large 7-decimal amounts", () => {
      const result = sumAmounts([
        "12345678", // 1.2345678
        87654322, // 8.7654322
        500000000n, // 50.0000000
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(600000000n); // 60.0000000
    });

    it("rejects an empty ledger", () => {
      const result = sumAmounts([]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(FINANCIAL_REPORT_MATH_ERRORS.EMPTY_INPUT);
    });

    it("rejects a ledger containing a fractional entry", () => {
      expect(sumAmounts(["100", "2.5"]).ok).toBe(false);
    });
  });

  describe("netAmount", () => {
    it("computes credits minus debits", () => {
      const result = netAmount(15000000, 2500000);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(12500000n);
    });

    it("returns a negative net when debits exceed credits", () => {
      const result = netAmount(100, 250);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(-150n);
    });
  });

  describe("applyFeeBasisPoints", () => {
    it("applies a 2.5% fee exactly", () => {
      const result = applyFeeBasisPoints(15000000n, 250n);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // 1.5000000 * 250 / 10000 = 0.0375000
        expect(result.fee).toBe(375000n);
        expect(result.net).toBe(14625000n);
        expect(result.fee + result.net).toBe(15000000n);
      }
    });

    it("rounds a half fee to even, not always up", () => {
      // 1 stroop at 50% -> 0.5 stroops -> 0 (even), not 1
      const even = applyFeeBasisPoints(1n, 5000n);
      expect(even.ok).toBe(true);
      if (even.ok) {
        expect(even.fee).toBe(0n);
        expect(even.net).toBe(1n);
      }

      // 3 stroops at 50% -> 1.5 stroops -> 2 (even)
      const odd = applyFeeBasisPoints(3n, 5000n);
      expect(odd.ok).toBe(true);
      if (odd.ok) {
        expect(odd.fee).toBe(2n);
        expect(odd.net).toBe(1n);
      }
    });

    it("handles a 100% fee and a 0% fee", () => {
      const full = applyFeeBasisPoints(987654321n, BASIS_POINTS_DIVISOR);
      expect(full.ok).toBe(true);
      if (full.ok) {
        expect(full.fee).toBe(987654321n);
        expect(full.net).toBe(0n);
      }

      const none = applyFeeBasisPoints(987654321n, 0n);
      expect(none.ok).toBe(true);
      if (none.ok) {
        expect(none.fee).toBe(0n);
        expect(none.net).toBe(987654321n);
      }
    });

    it("rejects a rate above 10000 basis points", () => {
      const result = applyFeeBasisPoints(100n, 10001n);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(FINANCIAL_REPORT_MATH_ERRORS.INVALID_RATE);
    });
  });

  describe("splitByWeights", () => {
    it("distributes rounding dust without losing a minor unit", () => {
      const result = splitByWeights(100n, [1, 1, 1]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.parts).toEqual([34n, 33n, 33n]);
        expect(result.parts.reduce((total, part) => total + part, 0n)).toBe(100n);
      }
    });

    it("reconciles a 3:1 split of an odd amount", () => {
      const result = splitByWeights(15000001n, [3, 1]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.parts).toEqual([11250001n, 3750000n]);
        expect(result.parts.reduce((total, part) => total + part, 0n)).toBe(15000001n);
      }
    });

    it("rejects zero weights", () => {
      const result = splitByWeights(100n, [0, 0]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(FINANCIAL_REPORT_MATH_ERRORS.INVALID_SCALE);
    });

    it("rejects an empty weight list", () => {
      const result = splitByWeights(100n, []);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(FINANCIAL_REPORT_MATH_ERRORS.EMPTY_INPUT);
    });
  });

  describe("convertMinorDecimals", () => {
    it("rescales 7-decimal amounts to cents with half-even rounding", () => {
      const exact = convertMinorDecimals(15000000n, 7, 2); // 1.5000000 -> 1.50
      expect(exact.ok).toBe(true);
      if (exact.ok) expect(exact.value).toBe(150n);

      const truncated = convertMinorDecimals(12345678n, 7, 2); // 1.2345678 -> 1.23
      expect(truncated.ok).toBe(true);
      if (truncated.ok) expect(truncated.value).toBe(123n);
    });

    it("rounds an exact half to the even cent", () => {
      const down = convertMinorDecimals(50000n, 7, 2); // 0.005 -> 0.00
      expect(down.ok).toBe(true);
      if (down.ok) expect(down.value).toBe(0n);

      const up = convertMinorDecimals(150000n, 7, 2); // 0.015 -> 0.02
      expect(up.ok).toBe(true);
      if (up.ok) expect(up.value).toBe(2n);
    });

    it("scales up without loss", () => {
      const result = convertMinorDecimals(150n, 2, 7); // 1.50 -> 1.5000000
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(15000000n);
    });

    it("is a no-op when the precision is unchanged", () => {
      const result = convertMinorDecimals(12345678n, 7, 7);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(12345678n);
    });

    it("rejects an out-of-range precision", () => {
      const result = convertMinorDecimals(1n, 7, 25);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(FINANCIAL_REPORT_MATH_ERRORS.INVALID_SCALE);
    });
  });

  describe("reconcileTotals", () => {
    it("confirms a summary that adds up", () => {
      const result = reconcileTotals({ credits: 15000000, debits: 2500000, net: 12500000 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.credits).toBe(15000000n);
        expect(result.debits).toBe(2500000n);
        expect(result.net).toBe(12500000n);
        expect(result.balanced).toBe(true);
      }
    });

    it("flags a summary whose net does not match credits minus debits", () => {
      const result = reconcileTotals({ credits: 15000000, debits: 2500000, net: 14999999 });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.balanced).toBe(false);
    });

    it("allows a negative net but rejects a fractional one", () => {
      const negative = reconcileTotals({ credits: 100, debits: 250, net: -150 });
      expect(negative.ok).toBe(true);
      if (negative.ok) expect(negative.balanced).toBe(true);

      expect(reconcileTotals({ credits: 100, debits: 250, net: "1.5" }).ok).toBe(false);
    });
  });
});
