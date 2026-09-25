import {
  MAX_SAFE_DIGITS,
  ERROR_CODES,
  validateMultiplier,
  validateStablecoinCents,
  validateDivisor,
  applyStablecoinCentsMultiplier,
} from "../src/utils/stablecoin_cents_multiplier.js";

describe("stablecoin_cents_multiplier overflow validation and decimal rounding", () => {
  describe("validateMultiplier", () => {
    it("accepts multipliers within the digit limit", () => {
      const result = validateMultiplier("1000000");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1000000n);
      }
    });

    it("accepts valid boundary value at exact MAX_SAFE_DIGITS (15 digits)", () => {
      const boundary = "9".repeat(MAX_SAFE_DIGITS);
      const result = validateMultiplier(boundary);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(BigInt(boundary));
      }
    });

    it("rejects excessive digits (>15) with OVERFLOW_EXCESSIVE_DIGITS", () => {
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const result = validateMultiplier(tooBig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
        expect(result.error).toMatch(/exceeds maximum of 15 digits/i);
      }
    });

    it("rejects non-integer input with OVERFLOW_INVALID_MULTIPLIER", () => {
      const result = validateMultiplier("10.5");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_MULTIPLIER);
        expect(result.error).toMatch(/must be an integer numeric value/i);
      }
    });
  });

  describe("validateStablecoinCents", () => {
    it("accepts valid cents amount within the digit limit", () => {
      const result = validateStablecoinCents("250000");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(250000n);
      }
    });

    it("accepts valid boundary value at exact MAX_SAFE_DIGITS (15 digits)", () => {
      const boundary = "9".repeat(MAX_SAFE_DIGITS);
      const result = validateStablecoinCents(boundary);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(BigInt(boundary));
      }
    });

    it("rejects excessive digits (>15) with OVERFLOW_EXCESSIVE_DIGITS", () => {
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const result = validateStablecoinCents(tooBig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
        expect(result.error).toMatch(/exceeds maximum of 15 digits/i);
      }
    });

    it("rejects non-integer input with OVERFLOW_INVALID_AMOUNT", () => {
      const result = validateStablecoinCents("100.99");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
        expect(result.error).toMatch(/must be an integer numeric value/i);
      }
    });
  });

  describe("validateDivisor", () => {
    it("accepts valid divisor within digit limit", () => {
      const result = validateDivisor("100");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(100n);
      }
    });

    it("accepts valid boundary value at exact MAX_SAFE_DIGITS (15 digits)", () => {
      const boundary = "9".repeat(MAX_SAFE_DIGITS);
      const result = validateDivisor(boundary);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(BigInt(boundary));
      }
    });

    it("rejects zero divisor with OVERFLOW_DIVISION_BY_ZERO", () => {
      const result = validateDivisor("0");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.DIVISION_BY_ZERO);
        expect(result.error).toMatch(/cannot be zero/i);
      }
    });

    it("rejects excessive digits (>15) with OVERFLOW_EXCESSIVE_DIGITS", () => {
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const result = validateDivisor(tooBig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
        expect(result.error).toMatch(/exceeds maximum of 15 digits/i);
      }
    });

    it("rejects non-integer divisor with OVERFLOW_INVALID_DIVISOR", () => {
      const result = validateDivisor("10.5");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_DIVISOR);
        expect(result.error).toMatch(/must be an integer numeric value/i);
      }
    });
  });

  describe("applyStablecoinCentsMultiplier", () => {
    it("correctly multiplies small/normal values when divisor is omitted (defaults to 1)", () => {
      const result = applyStablecoinCentsMultiplier("1000", "10");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(10000n);
      }
    });

    it("accepts boundary products within MAX_SAFE_DIGITS (15 digits)", () => {
      const amount = "10000000"; // 8 digits
      const multiplier = "10000000"; // 8 digits -> product 15 digits (1e14)
      const result = applyStablecoinCentsMultiplier(amount, multiplier);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(100000000000000n);
      }
    });

    it("blocks excessive digits on amount operand before arithmetic", () => {
      const excessive = "9".repeat(MAX_SAFE_DIGITS + 1);
      const result = applyStablecoinCentsMultiplier(excessive, "2");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

    it("blocks excessive digits on multiplier operand before arithmetic", () => {
      const excessive = "9".repeat(MAX_SAFE_DIGITS + 1);
      const result = applyStablecoinCentsMultiplier("100", excessive);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

    it("blocks product overflow when product exceeds 15 digits", () => {
      const largeAmount = "9".repeat(MAX_SAFE_DIGITS);
      const result = applyStablecoinCentsMultiplier(largeAmount, "10");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.PRODUCT_OVERFLOW);
        expect(result.error).toMatch(/multiplied cents value exceeds maximum of 15 digits/i);
      }
    });

    it("regression test: blocks dangerous input before arithmetic overflow can occur", () => {
      const unsafeAmount = "99999999999999999999999999999";
      const unsafeMultiplier = "99999999999999999999999999999";
      const result = applyStablecoinCentsMultiplier(unsafeAmount, unsafeMultiplier);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
      }
    });

    describe("Decimal Rounding Policies & Remainder Handling", () => {
      it("1. Exact division: value % divisor === 0 preserves exact quotient", () => {
        const result = applyStablecoinCentsMultiplier("100", "2", "4");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(50n);
        }
      });

      it("2. Remainder below halfway point: rounds down (keeps quotient)", () => {
        // 10 / 3 = 3 remainder 1. 2*1 = 2 < 3 -> round down to 3
        const result = applyStablecoinCentsMultiplier("10", "1", "3");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(3n);
        }
      });

      it("3. Remainder above halfway point: rounds up (increments quotient)", () => {
        // 11 / 3 = 3 remainder 2. 2*2 = 4 > 3 -> round up to 4
        const result = applyStablecoinCentsMultiplier("11", "1", "3");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(4n);
        }
      });

      it("4. Exact halfway with an even quotient: remains at even quotient (round-to-nearest-even)", () => {
        // 5 / 2 = 2.5. Quotient = 2 (even). Remains 2.
        const result = applyStablecoinCentsMultiplier("5", "1", "2");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(2n);
        }
      });

      it("5. Exact halfway with an odd quotient: increments to next even integer", () => {
        // 7 / 2 = 3.5. Quotient = 3 (odd). Increments to 4 (even).
        const result = applyStablecoinCentsMultiplier("7", "1", "2");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(4n);
        }
      });

      it("handles negative exact halfway values with banker's rounding", () => {
        // -5 / 2 = -2.5. Quotient = -2 (even). Remains -2.
        const res1 = applyStablecoinCentsMultiplier("-5", "1", "2");
        expect(res1.ok).toBe(true);
        if (res1.ok) {
          expect(res1.value).toBe(-2n);
        }

        // -7 / 2 = -3.5. Quotient = -3 (odd). Increments magnitude to -4 (even).
        const res2 = applyStablecoinCentsMultiplier("-7", "1", "2");
        expect(res2.ok).toBe(true);
        if (res2.ok) {
          expect(res2.value).toBe(-4n);
        }
      });

      it("supports explicit 'round-to-nearest-even' alias and options object", () => {
        const result = applyStablecoinCentsMultiplier("7", "1", {
          divisor: "2",
          roundingMode: "round-to-nearest-even",
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(4n);
        }
      });

      it("supports configurable 'half-up' rounding mode", () => {
        // 5 / 2 = 2.5 -> half-up rounds up to 3
        const result = applyStablecoinCentsMultiplier("5", "1", "2", "half-up");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(3n);
        }
      });

      it("supports configurable 'truncate' rounding mode", () => {
        // 11 / 3 = 3.666 -> truncate drops remainder to 3
        const result = applyStablecoinCentsMultiplier("11", "1", "3", "truncate");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(3n);
        }
      });

      it("supports configurable 'ceil' rounding mode (positive and negative values)", () => {
        // 10 / 3 = 3.333 -> ceil rounds up to 4
        const resPos = applyStablecoinCentsMultiplier("10", "1", "3", "ceil");
        expect(resPos.ok).toBe(true);
        if (resPos.ok) {
          expect(resPos.value).toBe(4n);
        }

        // -10 / 3 = -3.333 -> ceil rounds towards +infinity to -3
        const resNeg = applyStablecoinCentsMultiplier("-10", "1", "3", "ceil");
        expect(resNeg.ok).toBe(true);
        if (resNeg.ok) {
          expect(resNeg.value).toBe(-3n);
        }

        // Exact division cases remain unchanged
        const resPosExact = applyStablecoinCentsMultiplier("9", "1", "3", "ceil");
        expect(resPosExact.ok).toBe(true);
        if (resPosExact.ok) {
          expect(resPosExact.value).toBe(3n);
        }

        const resNegExact = applyStablecoinCentsMultiplier("-9", "1", "3", "ceil");
        expect(resNegExact.ok).toBe(true);
        if (resNegExact.ok) {
          expect(resNegExact.value).toBe(-3n);
        }
      });

      it("rejects invalid rounding mode with INVALID_ROUNDING_MODE code", () => {
        const result = applyStablecoinCentsMultiplier(
          "10",
          "1",
          "3",
          "invalid_mode" as any
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe(ERROR_CODES.INVALID_ROUNDING_MODE);
        }
      });
    });

    describe("Remainder Leakage Prevention", () => {
      it("prevents remainder leakage on fractional cent multipliers", () => {
        // Suppose calculating 150 cents multiplied by rate factor 15 / 100 (15%) = 22.5
        // Truncation would give 22 (losing 0.5 cents).
        // Round-to-nearest-even gives 22 (even quotient 22).
        const res1 = applyStablecoinCentsMultiplier("150", "15", "100");
        expect(res1.ok).toBe(true);
        if (res1.ok) {
          expect(res1.value).toBe(22n);
        }

        // Suppose 170 cents * 15 / 100 = 25.5
        // Truncation would give 25 (leaking 0.5 cents).
        // Round-to-nearest-even gives 26 (round up odd quotient 25 -> 26).
        const res2 = applyStablecoinCentsMultiplier("170", "15", "100");
        expect(res2.ok).toBe(true);
        if (res2.ok) {
          expect(res2.value).toBe(26n);
        }
      });

      it("handles boundary values close to MAX_SAFE_DIGITS with rounding", () => {
        const largeAmount = "999999999999999"; // 15 digits
        const result = applyStablecoinCentsMultiplier(largeAmount, "1", "2");
        expect(result.ok).toBe(true);
        if (result.ok) {
          // 999999999999999 / 2 = 499999999999999.5
          // Quotient is odd (499999999999999) -> rounds to 500000000000000
          expect(result.value).toBe(500000000000000n);
        }
      });
    });
  });
});
