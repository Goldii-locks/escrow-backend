import { calculateFeeDeduction, calculateFeeShares } from "../src/utils/fee-deduction-calculator.js";
import { applyConversionRate, assertConversionSplitSum } from "../src/utils/conversion_rate_math.js";
import { calculateTaxDeduction } from "../src/utils/tax_deduction_estimator.js";
import { allocatePartialPayment } from "../src/utils/partial_payment_allocator.js";
import { assertLedgerSplitSum } from "../src/utils/audit_ledger_sum_checker.js";
import { AMOUNT_OUT_OF_RANGE, MAX_AMOUNT, MIN_AMOUNT } from "../src/utils/digit-limit-validator.js";

/**
 * Acceptance criteria for #698: the old 15-digit cap is gone. A 20-digit raw
 * amount (e.g. a 150M-token escrow at 7 decimals, or any 18-decimal token)
 * works in the fee, split, conversion and tax helpers, and i128 max + 1 is
 * rejected everywhere with the same error code.
 */

const TWENTY_DIGITS = "12345678901234567890";
const OVER_I128 = (MAX_AMOUNT + 1n).toString();

type Outcome = { ok: boolean; code?: string };

describe("i128 amount range (#698)", () => {
  it("exposes the contract's i128 bounds", () => {
    expect(MAX_AMOUNT).toBe(2n ** 127n - 1n);
    expect(MIN_AMOUNT).toBe(-(2n ** 127n));
  });

  describe("a 20-digit raw amount is accepted", () => {
    it("by the fee helpers", () => {
      const fee = calculateFeeDeduction(TWENTY_DIGITS, 250, 10_000);
      expect(fee.ok).toBe(true);

      const shares = calculateFeeShares(TWENTY_DIGITS, [1, 1, 1]);
      expect(shares.ok).toBe(true);
      if (shares.ok) {
        const sum = shares.feeShares.reduce((a, b) => a + b, 0n);
        expect(sum + shares.remainder).toBe(BigInt(TWENTY_DIGITS));
      }
    });

    it("by the split helpers", () => {
      const half = BigInt(TWENTY_DIGITS) / 2n;
      const rest = BigInt(TWENTY_DIGITS) - half;
      expect(assertLedgerSplitSum([half.toString(), rest.toString()], TWENTY_DIGITS).ok).toBe(true);
      expect(assertConversionSplitSum([half.toString(), rest.toString()], TWENTY_DIGITS).ok).toBe(true);

      const allocation = allocatePartialPayment(TWENTY_DIGITS, [3, 1]);
      expect(allocation.ok).toBe(true);
    });

    it("by the conversion helper", () => {
      const converted = applyConversionRate(TWENTY_DIGITS, "2");
      expect(converted).toEqual({ ok: true, value: BigInt(TWENTY_DIGITS) * 2n });
    });

    it("by the tax helper", () => {
      const tax = calculateTaxDeduction(TWENTY_DIGITS, 500, 10_000);
      expect(tax.ok).toBe(true);
    });
  });

  describe("i128 max + 1 is rejected with one error code everywhere", () => {
    const cases: Array<[string, () => Outcome]> = [
      ["calculateFeeDeduction", () => calculateFeeDeduction(OVER_I128, 250, 10_000)],
      ["calculateFeeShares", () => calculateFeeShares(OVER_I128, [1, 1])],
      ["assertLedgerSplitSum", () => assertLedgerSplitSum([OVER_I128], OVER_I128)],
      ["assertConversionSplitSum", () => assertConversionSplitSum([OVER_I128], OVER_I128)],
      ["allocatePartialPayment", () => allocatePartialPayment(OVER_I128, [1, 1])],
      ["applyConversionRate", () => applyConversionRate(OVER_I128, "1")],
      ["calculateTaxDeduction", () => calculateTaxDeduction(OVER_I128, 500, 10_000)],
    ];

    it.each(cases)("%s", (_name, run) => {
      const result = run();
      expect(result.ok).toBe(false);
      expect(result.code).toBe(AMOUNT_OUT_OF_RANGE);
    });
  });
});
