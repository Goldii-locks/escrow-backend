import {
  MAX_SAFE_DIGITS,
  ERROR_CODES,
  validateRefundAmount,
  validateRefundRatioBps,
  applyRefundRatioHalfEven,
} from "../src/utils/refund_ratio_helper.js";

describe("refund_ratio_helper round-half-to-even refund splitter", () => {
  describe("validateRefundAmount", () => {
    it("accepts non-negative amounts within the digit limit", () => {
      expect(validateRefundAmount("0").ok).toBe(true);
      expect(validateRefundAmount("123456789012345").ok).toBe(true);
      expect(validateRefundAmount(42).ok).toBe(true);
      expect(validateRefundAmount(10000n).ok).toBe(true);
    });

    it("accepts zero across input types", () => {
      const fromString = validateRefundAmount("0");
      const fromNumber = validateRefundAmount(0);
      const fromBigInt = validateRefundAmount(0n);
      expect(fromString.ok).toBe(true);
      expect(fromNumber.ok).toBe(true);
      expect(fromBigInt.ok).toBe(true);
      if (fromString.ok && fromNumber.ok && fromBigInt.ok) {
        expect(fromString.value).toBe(0n);
        expect(fromNumber.value).toBe(0n);
        expect(fromBigInt.value).toBe(0n);
      }
    });

    it("rejects negative amounts with REFUND_INVALID_AMOUNT", () => {
      const cases: Array<string | number | bigint> = [-1n, -42, "-10", "-0"];
      for (const input of cases) {
        const res = validateRefundAmount(input);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.code).toBe(ERROR_CODES.INVALID_AMOUNT);
        }
      }
    });

    it("rejects non-integer and non-finite amounts", () => {
      expect(validateRefundAmount("12.5").ok).toBe(false);
      expect(validateRefundAmount(1.5).ok).toBe(false);
      expect(validateRefundAmount(Number.POSITIVE_INFINITY).ok).toBe(false);
      expect(validateRefundAmount(NaN).ok).toBe(false);
    });

    it("rejects excessive digits with OVERFLOW_EXCESSIVE_DIGITS", () => {
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const res = validateRefundAmount(tooBig);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });
  });

  describe("validateRefundRatioBps", () => {
    it("accepts basis points within 0-10000", () => {
      expect(validateRefundRatioBps(0).ok).toBe(true);
      expect(validateRefundRatioBps(5000).ok).toBe(true);
      expect(validateRefundRatioBps(10000).ok).toBe(true);
    });

    it("rejects out-of-range basis points with REFUND_INVALID_RATIO_BPS", () => {
      expect(validateRefundRatioBps(-1).ok).toBe(false);
      expect(validateRefundRatioBps(10001).ok).toBe(false);
      const res = validateRefundRatioBps(10001);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_RATIO_BPS);
      }
    });

    it("rejects non-integer and non-finite basis points", () => {
      expect(validateRefundRatioBps(0.5).ok).toBe(false);
      expect(validateRefundRatioBps(NaN).ok).toBe(false);
      expect(validateRefundRatioBps(Number.POSITIVE_INFINITY).ok).toBe(false);
    });
  });

  describe("applyRefundRatioHalfEven", () => {
    it("computes an exact 50% refund without remainder", () => {
      const res = applyRefundRatioHalfEven(10_000, 5000);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.refundAmount).toBe(5000n);
        expect(res.retainedAmount).toBe(5000n);
      }
    });

    it("computes a 0% refund (everything retained)", () => {
      const res = applyRefundRatioHalfEven(10_000, 0);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.refundAmount).toBe(0n);
        expect(res.retainedAmount).toBe(10000n);
      }
    });

    it("computes a 100% refund (nothing retained)", () => {
      const res = applyRefundRatioHalfEven(10_000, 10_000);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.refundAmount).toBe(10000n);
        expect(res.retainedAmount).toBe(0n);
      }
    });

    it("rounds an exact half toward the even quotient (banker's rounding)", () => {
      // amount * 0.5 = 0.5 → rounds to 0 (even)
      const down = applyRefundRatioHalfEven(1, 5000);
      expect(down.ok).toBe(true);
      if (down.ok) {
        expect(down.refundAmount).toBe(0n);
        expect(down.retainedAmount).toBe(1n);
      }

      // amount * 0.5 = 1.5 → rounds to 2 (even)
      const up = applyRefundRatioHalfEven(3, 5000);
      expect(up.ok).toBe(true);
      if (up.ok) {
        expect(up.refundAmount).toBe(2n);
        expect(up.retainedAmount).toBe(1n);
      }
    });

    it("rounds exact halves to even across a sequence of amounts", () => {
      // amount 1..10 at 50%: 0.5→0, 1.0→1, 1.5→2, 2.0→2, 2.5→2,
      // 3.0→3, 3.5→4, 4.0→4, 4.5→4, 5.0→5
      const expected = [0n, 1n, 2n, 2n, 2n, 3n, 4n, 4n, 4n, 5n];
      for (let amount = 1; amount <= 10; amount++) {
        const res = applyRefundRatioHalfEven(amount, 5000);
        expect(res.ok).toBe(true);
        if (res.ok) {
          expect(res.refundAmount).toBe(expected[amount - 1]);
        }
      }
    });

    it("rounds up when the remainder exceeds half", () => {
      // amount * 0.75 = 0.75 → rounds to 1
      const res = applyRefundRatioHalfEven(1, 7500);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.refundAmount).toBe(1n);
        expect(res.retainedAmount).toBe(0n);
      }
    });

    it("rounds down when the remainder is below half", () => {
      // amount * 0.25 = 0.25 → rounds to 0
      const res = applyRefundRatioHalfEven(1, 2500);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.refundAmount).toBe(0n);
        expect(res.retainedAmount).toBe(1n);
      }
    });

    it("never drops or leaks the remainder across many inputs", () => {
      const amounts = [1, 2, 3, 7, 9, 100, 12345, 999999];
      const ratios = [0, 1, 7, 2500, 3333, 5000, 5001, 9999, 10000];
      for (const amount of amounts) {
        for (const bps of ratios) {
          const res = applyRefundRatioHalfEven(amount, bps);
          expect(res.ok).toBe(true);
          if (res.ok) {
            // refundAmount + retainedAmount always reconstructs the amount exactly
            expect(res.refundAmount + res.retainedAmount).toBe(BigInt(amount));
          }
        }
      }
    });

    it("propagates INVALID_AMOUNT for a negative amount", () => {
      const res = applyRefundRatioHalfEven(-1000, 5000);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("propagates EXCESSIVE_DIGITS for an over-long amount", () => {
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const res = applyRefundRatioHalfEven(tooBig, 5000);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

    it("propagates INVALID_RATIO_BPS for an out-of-range ratio", () => {
      const res = applyRefundRatioHalfEven(1000, 10001);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODES.INVALID_RATIO_BPS);
      }
    });
  });
});
