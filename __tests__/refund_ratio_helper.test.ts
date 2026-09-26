import {
  MAX_SAFE_DIGITS,
  ERROR_CODES,
  ERROR_DEFINITIONS,
  DEFAULT_REFUND_SCALE,
  validateRefundRatio,
  validateRefundAmount,
  applyRefundRatio,
} from "../src/utils/refund_ratio_helper.js";
import { validateErrorStructure } from "../src/utils/conversion_rate_scraper.js";

describe("refund_ratio_helper validation and calculations", () => {
  function expectDefinedError(
    result: ReturnType<typeof applyRefundRatio>,
    code: string,
    parameter: string
  ): void {
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(code);
      expect(result.parameters).toEqual({ parameter, reason: result.error });
      expect(validateErrorStructure(result, ERROR_DEFINITIONS)).toEqual(
        expect.objectContaining({ ok: true, code })
      );
    }
  }

  describe("validateRefundRatio", () => {
    it("accepts ratios within the digit limit", () => {
      const result = validateRefundRatio("2500");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2500n);
      }
    });

    it("rejects excessive digits with OVERFLOW_EXCESSIVE_DIGITS", () => {
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const result = validateRefundRatio(tooBig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
        expect(result.error).toMatch(/exceeds maximum/i);
      }
    });

    it("rejects non-integer ratios with OVERFLOW_INVALID_RATIO", () => {
      const result = validateRefundRatio("12.5");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_RATIO);
      }
    });

    it("rejects negative and above-100-percent ratios", () => {
      expectDefinedError(validateRefundRatio(-1), ERROR_CODES.INVALID_RATIO, "ratio");
      expectDefinedError(
        validateRefundRatio(DEFAULT_REFUND_SCALE + 1),
        ERROR_CODES.INVALID_RATIO,
        "ratio"
      );
    });

    it("returns defined errors for missing and unsupported values", () => {
      expectDefinedError(validateRefundRatio(undefined), ERROR_CODES.MISSING_PARAMETER, "ratio");
      expectDefinedError(validateRefundRatio({}), ERROR_CODES.INVALID_PARAMETER_TYPE, "ratio");
    });
  });

  describe("validateRefundAmount", () => {
    it("rejects negative, missing, and unsupported amounts with defined structures", () => {
      expectDefinedError(validateRefundAmount(-1), ERROR_CODES.INVALID_AMOUNT, "amount");
      expectDefinedError(validateRefundAmount(null), ERROR_CODES.MISSING_PARAMETER, "amount");
      expectDefinedError(validateRefundAmount(true), ERROR_CODES.INVALID_PARAMETER_TYPE, "amount");
    });
  });

  describe("applyRefundRatio", () => {
    it.each([
      [10_000n, 2_500n, 2_500n, "25% of 10,000 is 2,500"],
      [0n, 2_500n, 0n, "25% of zero is zero"],
      [12_345n, 0n, 0n, "0% of 12,345 is zero"],
      [12_345n, 10_000n, 12_345n, "100% of 12,345 is 12,345"],
      [8_000n, 2_500n, 2_000n, "25% of 8,000 is 2,000"],
      [8_000n, 7_500n, 6_000n, "75% of 8,000 is 6,000"],
    ])("calculates %s × %s / 10,000 -> %s (%s)", (amount, ratio, expected) => {
      const result = applyRefundRatio(amount, ratio);
      expect(result).toEqual({ ok: true, value: expected });
    });

    it("rounds fractional stroops to the nearest even integer", () => {
      expect(applyRefundRatio(1, 5_000)).toEqual({ ok: true, value: 0n });
      expect(applyRefundRatio(3, 5_000)).toEqual({ ok: true, value: 2n });
      expect(applyRefundRatio(5, 5_000)).toEqual({ ok: true, value: 2n });
    });

    it("returns a defined calculation exception when result formatting fails", () => {
      const originalToString = BigInt.prototype.toString;
      const result = (() => {
        try {
          BigInt.prototype.toString = () => {
            throw new Error("forced formatting failure");
          };
          return applyRefundRatio(100, 2_500);
        } finally {
          BigInt.prototype.toString = originalToString;
        }
      })();

      expectDefinedError(result, ERROR_CODES.CALCULATION_EXCEPTION, "applyRefundRatio");
      if (!result.ok) {
        expect(result.details).toEqual({
          context: { amount: 100, ratio: 2_500 },
          reason: "forced formatting failure",
        });
      }
    });

    it("allows the maximum supported amount at the 100% boundary", () => {
      const amount = "9".repeat(MAX_SAFE_DIGITS);
      expect(applyRefundRatio(amount, DEFAULT_REFUND_SCALE)).toEqual({
        ok: true,
        value: BigInt(amount),
      });
    });

    it("rejects each negative argument independently", () => {
      expectDefinedError(applyRefundRatio(-1, 2_500), ERROR_CODES.INVALID_AMOUNT, "amount");
      expectDefinedError(applyRefundRatio(100, -1), ERROR_CODES.INVALID_RATIO, "ratio");
    });

    it("returns detailed missing and type mismatch errors before calculating", () => {
      expectDefinedError(applyRefundRatio(undefined, 2_500), ERROR_CODES.MISSING_PARAMETER, "amount");
      expectDefinedError(applyRefundRatio(100, "2500.5"), ERROR_CODES.INVALID_RATIO, "ratio");
      expectDefinedError(applyRefundRatio(100, []), ERROR_CODES.INVALID_PARAMETER_TYPE, "ratio");
    });

    it("rejects excessive digits with OVERFLOW_EXCESSIVE_DIGITS", () => {
      const excessive = "9".repeat(MAX_SAFE_DIGITS + 1);
      expectDefinedError(applyRefundRatio(excessive, 1), ERROR_CODES.EXCESSIVE_DIGITS, "amount");
    });

    it("keeps asymmetric refund shares additive for complementary ratios", () => {
      const partialRefund = applyRefundRatio(8_000, 2_500);
      const remainingShare = applyRefundRatio(8_000, 7_500);
      expect(partialRefund).toEqual({ ok: true, value: 2_000n });
      expect(remainingShare).toEqual({ ok: true, value: 6_000n });
      if (partialRefund.ok && remainingShare.ok) {
        expect(partialRefund.value + remainingShare.value).toBe(8_000n);
      }
    });

    it("blocks excessive digits on either operand", () => {
      const excessive = "9".repeat(MAX_SAFE_DIGITS + 1);
      const badAmount = applyRefundRatio(excessive, "1");
      expect(badAmount.ok).toBe(false);
      if (!badAmount.ok) {
        expect(badAmount.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }

      const badRatio = applyRefundRatio("1", excessive);
      expect(badRatio.ok).toBe(false);
      if (!badRatio.ok) {
        expect(badRatio.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

  });
});
