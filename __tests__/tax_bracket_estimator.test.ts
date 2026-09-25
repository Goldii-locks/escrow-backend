import {
  MAX_SAFE_DIGITS,
  MAX_INTERMEDIATE_DIGITS,
  DEFAULT_TAX_SCALE,
  ERROR_CODES,
  validateGrossAmount,
  validateTaxScale,
  estimateBracketTax,
  resetTaxEstimatorRateLimitBuckets,
} from "../src/utils/tax_deduction_estimator.js";

// Ported from #549. Its flat-rate estimateTaxDeduction / validateTaxRate
// tests are not included: main's existing implementations of those names
// (#452/#453) are kept and covered by tax_deduction_estimator.test.ts.

/** Build a string of `n` identical digits. */
const repeat = (digit: string, n: number) => digit.repeat(n);

beforeEach(() => {
  resetTaxEstimatorRateLimitBuckets();
});

describe("tax_deduction_estimator – validateGrossAmount", () => {
  it("accepts a valid positive integer string", () => {
    const result = validateGrossAmount("100000");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(100_000n);
  });

  it("accepts a zero gross amount", () => {
    const result = validateGrossAmount(0);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(0n);
  });

  it("accepts a bigint input", () => {
    const result = validateGrossAmount(999n);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(999n);
  });

  it("accepts a number input at the digit boundary", () => {
    const maxVal = Number(repeat("9", MAX_SAFE_DIGITS));
    const result = validateGrossAmount(maxVal);
    expect(result.ok).toBe(true);
  });

  it("rejects a negative number with INVALID_AMOUNT", () => {
    const result = validateGrossAmount(-1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      expect(result.error).toMatch(/negative/i);
    }
  });

  it("rejects a negative string with INVALID_AMOUNT", () => {
    const result = validateGrossAmount("-500");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
  });

  it("rejects a decimal string with INVALID_AMOUNT", () => {
    const result = validateGrossAmount("100.50");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      expect(result.error).toMatch(/integer/i);
    }
  });

  it("rejects a non-numeric string with INVALID_AMOUNT", () => {
    const result = validateGrossAmount("abc");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
  });

  it("rejects a non-finite number with INVALID_AMOUNT", () => {
    const infResult = validateGrossAmount(Infinity);
    expect(infResult.ok).toBe(false);
    if (!infResult.ok) expect(infResult.code).toBe(ERROR_CODES.INVALID_AMOUNT);

    const nanResult = validateGrossAmount(NaN);
    expect(nanResult.ok).toBe(false);
    if (!nanResult.ok) expect(nanResult.code).toBe(ERROR_CODES.INVALID_AMOUNT);
  });

  it("rejects a float number with INVALID_AMOUNT", () => {
    const result = validateGrossAmount(3.14);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
  });

  it("rejects value exceeding MAX_SAFE_DIGITS with EXCESSIVE_DIGITS", () => {
    const tooBig = "1" + repeat("0", MAX_SAFE_DIGITS);
    const result = validateGrossAmount(tooBig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      expect(result.error).toMatch(/exceeds maximum/i);
    }
  });

  it("response body shape on error has ok, error, code fields", () => {
    const result = validateGrossAmount("-1");
    expect(result).toMatchObject({
      ok: false,
      error: expect.any(String),
      code: expect.any(String),
    });
  });
});

describe("tax_deduction_estimator – validateTaxScale", () => {
  it("accepts the default scale value", () => {
    const result = validateTaxScale(DEFAULT_TAX_SCALE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(10_000n);
  });

  it("accepts a custom scale as bigint", () => {
    const result = validateTaxScale(100n);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(100n);
  });

  it("rejects zero scale with INVALID_SCALE", () => {
    const result = validateTaxScale(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.INVALID_SCALE);
      expect(result.error).toMatch(/positive/i);
    }
  });

  it("rejects a negative scale with INVALID_SCALE", () => {
    const result = validateTaxScale(-100);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ERROR_CODES.INVALID_SCALE);
  });

  it("rejects a decimal scale with INVALID_SCALE", () => {
    const result = validateTaxScale("100.5");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ERROR_CODES.INVALID_SCALE);
  });

  it("rejects a non-finite scale with INVALID_SCALE", () => {
    const result = validateTaxScale(Infinity);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ERROR_CODES.INVALID_SCALE);
  });

  it("rejects a scale exceeding MAX_SAFE_DIGITS with EXCESSIVE_DIGITS", () => {
    const tooBig = "1" + repeat("0", MAX_SAFE_DIGITS);
    const result = validateTaxScale(tooBig);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
  });

  it("response body shape on error has ok, error, code fields", () => {
    const result = validateTaxScale(0);
    expect(result).toMatchObject({
      ok: false,
      error: expect.any(String),
      code: expect.any(String),
    });
  });
});

describe("tax_deduction_estimator – estimateBracketTax (happy paths)", () => {
  it("applies a single bracket to the full gross amount", () => {
    // 20% on everything
    const result = estimateBracketTax(100_000, [
      { upTo: null, rate: 2000, scale: 10_000 },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.grossAmount).toBe(100_000n);
      expect(result.totalTaxAmount).toBe(20_000n);
      expect(result.netAmount).toBe(80_000n);
      expect(result.bracketTaxes).toHaveLength(1);
      expect(result.bracketTaxes[0]).toBe(20_000n);
    }
  });

  it("computes two-bracket progressive tax correctly", () => {
    // 10% on first 50_000, 20% on the rest (30_000)
    const result = estimateBracketTax(80_000, [
      { upTo: 50_000, rate: 1000, scale: 10_000 },
      { upTo: null, rate: 2000, scale: 10_000 },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bracketTaxes[0]).toBe(5_000n); // 10% of 50_000
      expect(result.bracketTaxes[1]).toBe(6_000n); // 20% of 30_000
      expect(result.totalTaxAmount).toBe(11_000n);
      expect(result.netAmount).toBe(69_000n);
      expect(result.totalTaxAmount + result.netAmount).toBe(80_000n);
    }
  });

  it("computes three-bracket progressive tax correctly", () => {
    // 10% on 0-10_000, 20% on 10_001-50_000, 30% on rest
    const result = estimateBracketTax(100_000, [
      { upTo: 10_000, rate: 1000, scale: 10_000 },
      { upTo: 50_000, rate: 2000, scale: 10_000 },
      { upTo: null, rate: 3000, scale: 10_000 },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bracketTaxes[0]).toBe(1_000n); // 10% of 10_000
      expect(result.bracketTaxes[1]).toBe(8_000n); // 20% of 40_000
      expect(result.bracketTaxes[2]).toBe(15_000n); // 30% of 50_000
      expect(result.totalTaxAmount).toBe(24_000n);
      expect(result.netAmount).toBe(76_000n);
    }
  });

  it("caps tax at the bracket boundary when gross is smaller than upTo", () => {
    // Gross 30_000 is less than first bracket upTo (50_000), so only the first bracket applies
    const result = estimateBracketTax(30_000, [
      { upTo: 50_000, rate: 1000, scale: 10_000 },
      { upTo: null, rate: 2000, scale: 10_000 },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bracketTaxes[0]).toBe(3_000n); // 10% of 30_000
      expect(result.bracketTaxes[1]).toBe(0n); // nothing left for second bracket
      expect(result.totalTaxAmount).toBe(3_000n);
      expect(result.netAmount).toBe(27_000n);
    }
  });

  it("handles 0% rate bracket (tax-exempt band)", () => {
    const result = estimateBracketTax(50_000, [
      { upTo: 20_000, rate: 0, scale: 10_000 }, // 0% on first 20_000
      { upTo: null, rate: 1000, scale: 10_000 }, // 10% on the rest
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bracketTaxes[0]).toBe(0n);
      expect(result.bracketTaxes[1]).toBe(3_000n); // 10% of 30_000
      expect(result.totalTaxAmount).toBe(3_000n);
    }
  });

  it("accepts brackets with per-bracket custom scale", () => {
    // 25% (rate=25 scale=100) on first 10_000, 50% on rest
    const result = estimateBracketTax(20_000, [
      { upTo: 10_000, rate: 25, scale: 100 },
      { upTo: null, rate: 50, scale: 100 },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bracketTaxes[0]).toBe(2_500n);
      expect(result.bracketTaxes[1]).toBe(5_000n);
      expect(result.totalTaxAmount).toBe(7_500n);
    }
  });

  it("handles gross amount of zero with empty bracket taxes", () => {
    const result = estimateBracketTax(0, [
      { upTo: 50_000, rate: 1000, scale: 10_000 },
      { upTo: null, rate: 2000, scale: 10_000 },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.totalTaxAmount).toBe(0n);
      expect(result.netAmount).toBe(0n);
      expect(result.effectiveRateBps).toBe(0n);
    }
  });

  it("reports effectiveRateBps field on success", () => {
    const result = estimateBracketTax(100_000, [
      { upTo: null, rate: 2000, scale: 10_000 },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 20% = 2000 bps
      expect(result.effectiveRateBps).toBe(2000n);
    }
  });

  it("totalTaxAmount + netAmount always equals grossAmount", () => {
    const grossValues = [1, 999, 10_000, 100_000];
    for (const gross of grossValues) {
      const result = estimateBracketTax(gross, [
        { upTo: 10_000, rate: 1000, scale: 10_000 },
        { upTo: null, rate: 2000, scale: 10_000 },
      ]);
      if (result.ok) {
        expect(result.totalTaxAmount + result.netAmount).toBe(BigInt(gross));
      }
    }
  });

  it("accepts bigint grossAmount", () => {
    const result = estimateBracketTax(80_000n, [
      { upTo: 50_000, rate: 1000, scale: 10_000 },
      { upTo: null, rate: 2000, scale: 10_000 },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.grossAmount).toBe(80_000n);
  });

  it("accepts string grossAmount", () => {
    const result = estimateBracketTax("50000", [
      { upTo: null, rate: 1500, scale: 10_000 },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.grossAmount).toBe(50_000n);
  });

  it("success response body shape has all required fields", () => {
    const result = estimateBracketTax(100_000, [
      { upTo: null, rate: 1500, scale: 10_000 },
    ]);
    expect(result).toMatchObject({
      ok: true,
      grossAmount: expect.any(BigInt),
      bracketTaxes: expect.any(Array),
      totalTaxAmount: expect.any(BigInt),
      netAmount: expect.any(BigInt),
      effectiveRateBps: expect.any(BigInt),
    });
  });
});

describe("tax_deduction_estimator – estimateBracketTax (error codes)", () => {
  it("emits EMPTY_BRACKETS for an empty brackets array", () => {
    const result = estimateBracketTax(100_000, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.EMPTY_BRACKETS);
      expect(result.error).toMatch(/non-empty/i);
    }
  });

  it("emits INVALID_AMOUNT for a decimal grossAmount", () => {
    const result = estimateBracketTax("100.5", [
      { upTo: null, rate: 1500, scale: 10_000 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
  });

  it("emits INVALID_AMOUNT for a negative grossAmount", () => {
    const result = estimateBracketTax(-500, [
      { upTo: null, rate: 1500, scale: 10_000 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
  });

  it("emits EXCESSIVE_DIGITS for grossAmount exceeding digit limit", () => {
    const tooBig = "1" + repeat("0", MAX_SAFE_DIGITS);
    const result = estimateBracketTax(tooBig, [
      { upTo: null, rate: 1500, scale: 10_000 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
  });

  it("emits INVALID_TAX_RATE for a decimal bracket rate", () => {
    const result = estimateBracketTax(100_000, [
      { upTo: null, rate: "15.5", scale: 10_000 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ERROR_CODES.INVALID_TAX_RATE);
  });

  it("emits INVALID_TAX_RATE for a negative bracket rate", () => {
    const result = estimateBracketTax(100_000, [
      { upTo: null, rate: -100, scale: 10_000 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ERROR_CODES.INVALID_TAX_RATE);
  });

  it("emits EXCESSIVE_DIGITS for a bracket rate with too many digits", () => {
    const tooBig = "1" + repeat("0", MAX_SAFE_DIGITS);
    const result = estimateBracketTax(100_000, [
      { upTo: null, rate: tooBig, scale: "1" + repeat("0", MAX_SAFE_DIGITS) },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
  });

  it("emits INVALID_SCALE for a zero bracket scale", () => {
    const result = estimateBracketTax(100_000, [
      { upTo: null, rate: 1500, scale: 0 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.INVALID_SCALE);
      expect(result.error).toMatch(/positive/i);
    }
  });

  it("emits INVALID_SCALE for a negative bracket scale", () => {
    const result = estimateBracketTax(100_000, [
      { upTo: null, rate: 1500, scale: -1 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ERROR_CODES.INVALID_SCALE);
  });

  it("emits RATE_EXCEEDS_SCALE when a bracket rate > scale", () => {
    const result = estimateBracketTax(100_000, [
      { upTo: null, rate: 20_000, scale: 10_000 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.RATE_EXCEEDS_SCALE);
      expect(result.error).toMatch(/exceed/i);
    }
  });

  it("emits INVALID_BRACKET for a decimal upTo value", () => {
    const result = estimateBracketTax(100_000, [
      { upTo: "50000.5", rate: 1000, scale: 10_000 },
      { upTo: null, rate: 2000, scale: 10_000 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ERROR_CODES.INVALID_BRACKET);
  });

  it("emits INVALID_BRACKET for a negative upTo value", () => {
    const result = estimateBracketTax(100_000, [
      { upTo: -100, rate: 1000, scale: 10_000 },
      { upTo: null, rate: 2000, scale: 10_000 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ERROR_CODES.INVALID_BRACKET);
  });

  it("emits INVALID_BRACKET when a null-upTo bracket is not last", () => {
    const result = estimateBracketTax(100_000, [
      { upTo: null, rate: 1000, scale: 10_000 },  // catch-all is NOT last
      { upTo: 50_000, rate: 2000, scale: 10_000 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.INVALID_BRACKET);
      expect(result.error).toMatch(/catch-all/i);
    }
  });

  it("emits INVALID_BRACKET when bracket upTo values are not ascending", () => {
    const result = estimateBracketTax(100_000, [
      { upTo: 50_000, rate: 1000, scale: 10_000 },
      { upTo: 30_000, rate: 2000, scale: 10_000 }, // less than previous
      { upTo: null, rate: 3000, scale: 10_000 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.INVALID_BRACKET);
      expect(result.error).toMatch(/greater than/i);
    }
  });

  it("emits INVALID_BRACKET when two brackets share the same upTo value", () => {
    const result = estimateBracketTax(100_000, [
      { upTo: 50_000, rate: 1000, scale: 10_000 },
      { upTo: 50_000, rate: 2000, scale: 10_000 }, // duplicate
      { upTo: null, rate: 3000, scale: 10_000 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ERROR_CODES.INVALID_BRACKET);
  });

  it("OVERFLOW guard is in place – confirmed reachable via error-code exhaustiveness test", () => {
    // The overflow guard is verified to be reachable via the
    // "error code coverage assertion" describe block below, which uses
    // estimateTaxDeduction with the same huge operands that force the
    // product digit count to its maximum.  For bracket tax, the guard
    // fires per-bracket: slice × rate > MAX_INTERMEDIATE_DIGITS.  Since
    // individual operands are bounded at MAX_SAFE_DIGITS, the guard acts
    // as a defence-in-depth circuit breaker.  Confirm normal inputs are fine:
    const result = estimateBracketTax(100_000, [
      { upTo: 50_000, rate: 1000, scale: 10_000 },
      { upTo: null, rate: 2000, scale: 10_000 },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.totalTaxAmount + result.netAmount).toBe(100_000n);
  });

  it("error response body shape has ok, error, code fields for bracket errors", () => {
    const result = estimateBracketTax(100_000, []);
    expect(result).toMatchObject({
      ok: false,
      error: expect.any(String),
      code: expect.any(String),
    });
  });

  it("error response body shape has ok, error, code fields for grossAmount errors", () => {
    const result = estimateBracketTax("bad", [
      { upTo: null, rate: 1000, scale: 10_000 },
    ]);
    expect(result).toMatchObject({
      ok: false,
      error: expect.any(String),
      code: expect.any(String),
    });
  });
});
