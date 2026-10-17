import { toCents, fromCents } from "../src/stablecoin_cents_multiplier.js";

describe("toCents float-safety (#627)", () => {
  it("floors 0.29 to exactly 29 (not 28)", () => {
    expect(toCents(0.29, { rounding: "floor" })).toBe(29);
  });

  it("ceils 0.07 to exactly 7 (not 8)", () => {
    expect(toCents(0.07, { rounding: "ceil" })).toBe(7);
  });

  it("rounds half-up: toCents('1.005') is 101", () => {
    expect(toCents("1.005")).toBe(101);
  });

  it("rejects unsafe-integer results instead of returning garbage", () => {
    expect(() => toCents(12345678901234.56, { decimals: 7 })).toThrow(RangeError);
  });

  it("fromCents inverts exactly (no float division error)", () => {
    expect(fromCents(29)).toBe(0.29);
    expect(fromCents(7)).toBe(0.07);
    expect(fromCents(101)).toBe(1.01);
    expect(toCents(fromCents(1234))).toBe(1234);
  });

  it("floor/ceil/round agree on exact 2-decimal strings (property)", () => {
    // Deterministic pseudo-random 2-decimal amounts: no digit beyond the
    // 2-decimal precision means no rounding ever applies.
    let seed = 123456789;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 500; i++) {
      const s = `${Math.floor(rand() * 100000)}.${String(Math.floor(rand() * 100)).padStart(2, "0")}`;
      const floor = toCents(s, { rounding: "floor" });
      const ceil = toCents(s, { rounding: "ceil" });
      const round = toCents(s, { rounding: "round" });
      expect({ s, floor, ceil, round }).toEqual({ s, floor, floor, round: floor });
      expect(ceil).toBe(floor);
      expect(round).toBe(floor);
    }
  });
});
