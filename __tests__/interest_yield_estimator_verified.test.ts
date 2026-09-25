import {
  MAX_SAFE_DIGITS,
  ERROR_CODES,
  estimateInterestYield,
} from "../src/utils/interest_yield_estimator.js";

/**
 * Jest assertions comparing interest_yield_estimator outputs against
 * hand-verified calculation outcomes. The estimator computes yield as
 * `principal * rate` (rate is an integer scaled factor), so each expected
 * value below is the exact product of its two operands, verified independently
 * of the implementation.
 */
describe("interest_yield_estimator verified calculation outcomes", () => {
  interface VerifiedCase {
    principal: string;
    rate: string;
    expected: bigint;
    description: string;
  }

  describe("verified multiplication outcomes", () => {
    const cases: VerifiedCase[] = [
      { principal: "2", rate: "3", expected: 6n, description: "small single-digit operands" },
      { principal: "10", rate: "10", expected: 100n, description: "two-digit operands" },
      { principal: "25", rate: "4", expected: 100n, description: "quarter × four" },
      { principal: "7", rate: "11", expected: 77n, description: "co-prime operands" },
      { principal: "123", rate: "456", expected: 56088n, description: "three-digit operands" },
      { principal: "9999", rate: "9999", expected: 99980001n, description: "(10^4 - 1)^2" },
      { principal: "12345", rate: "6789", expected: 83810205n, description: "five by four digits" },
      { principal: "123456", rate: "789", expected: 97406784n, description: "six by three digits" },
      { principal: "54321", rate: "12345", expected: 670592745n, description: "five by five digits" },
      { principal: "8080808", rate: "123", expected: 993939384n, description: "repeated-digit pattern" },
    ];

    cases.forEach(({ principal, rate, expected, description }) => {
      it(`computes ${description}: ${principal} * ${rate} = ${expected}`, () => {
        const result = estimateInterestYield(principal, rate);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(expected);
          // The estimator always returns the product as a bigint.
          expect(typeof result.value).toBe("bigint");
        }
      });
    });
  });

  describe("powers of ten", () => {
    const cases: VerifiedCase[] = [
      { principal: "10", rate: "100", expected: 1000n, description: "10^3" },
      { principal: "100", rate: "1000", expected: 100000n, description: "10^5" },
      { principal: "1000000", rate: "1000000", expected: 1000000000000n, description: "10^12" },
      { principal: "10000000", rate: "10000000", expected: 100000000000000n, description: "10^14" },
    ];

    cases.forEach(({ principal, rate, expected, description }) => {
      it(`computes ${description}: ${principal} * ${rate}`, () => {
        const result = estimateInterestYield(principal, rate);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(expected);
        }
      });
    });
  });

  describe("zero and identity properties", () => {
    it("returns zero when either operand is zero", () => {
      const left = estimateInterestYield("0", "12345");
      expect(left.ok).toBe(true);
      if (left.ok) expect(left.value).toBe(0n);

      const right = estimateInterestYield("12345", "0");
      expect(right.ok).toBe(true);
      if (right.ok) expect(right.value).toBe(0n);

      const both = estimateInterestYield("0", "0");
      expect(both.ok).toBe(true);
      if (both.ok) expect(both.value).toBe(0n);
    });

    it("returns the principal unchanged when rate is one", () => {
      const result = estimateInterestYield("987654321", "1");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(987654321n);
    });

    it("returns the rate unchanged when principal is one", () => {
      const result = estimateInterestYield("1", "987654321");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(987654321n);
    });

    it("returns one when both operands are one", () => {
      const result = estimateInterestYield("1", "1");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(1n);
    });
  });

  describe("signed operand handling", () => {
    it("computes a negative yield when exactly one operand is negative", () => {
      const negPrincipal = estimateInterestYield("-100", "3");
      expect(negPrincipal.ok).toBe(true);
      if (negPrincipal.ok) expect(negPrincipal.value).toBe(-300n);

      const negRate = estimateInterestYield("100", "-3");
      expect(negRate.ok).toBe(true);
      if (negRate.ok) expect(negRate.value).toBe(-300n);
    });

    it("computes a positive yield when both operands are negative", () => {
      const result = estimateInterestYield("-100", "-3");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(300n);
    });
  });

  describe("input normalization", () => {
    it("strips leading zeros from both operands before multiplying", () => {
      const leadingZeros = estimateInterestYield("000100", "0002");
      expect(leadingZeros.ok).toBe(true);
      if (leadingZeros.ok) expect(leadingZeros.value).toBe(200n);
    });
  });

  describe("type polymorphism", () => {
    it("produces identical yields for string, number, and bigint inputs", () => {
      const fromStrings = estimateInterestYield("100000", "200");
      const fromNumbers = estimateInterestYield(100000, 200);
      const fromBigInts = estimateInterestYield(100000n, 200n);

      expect(fromStrings.ok).toBe(true);
      expect(fromNumbers.ok).toBe(true);
      expect(fromBigInts.ok).toBe(true);
      if (fromStrings.ok && fromNumbers.ok && fromBigInts.ok) {
        expect(fromStrings.value).toBe(20000000n);
        expect(fromNumbers.value).toBe(fromStrings.value);
        expect(fromBigInts.value).toBe(fromStrings.value);
      }
    });
  });

  describe("MAX_SAFE_DIGITS boundary verification", () => {
    it("accepts a product exactly at the 15-digit limit", () => {
      const maxProduct = "9".repeat(MAX_SAFE_DIGITS);
      const result = estimateInterestYield(maxProduct, "1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(BigInt(maxProduct));
        expect(result.value.toString().length).toBe(MAX_SAFE_DIGITS);
      }
    });

    it("accepts a 14-digit product of two large operands", () => {
      const result = estimateInterestYield("9999999", "9999999");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(99999980000001n);
      }
    });

    it("rejects a product that exceeds the 15-digit limit", () => {
      // 10^14 (15 digits) * 10 = 10^15 (16 digits) → overflow
      const result = estimateInterestYield("100000000000000", "10");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.PRODUCT_OVERFLOW);
      }
    });
  });
});
