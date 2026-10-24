import {
  toCentsExact,
  fromCentsExact,
} from "../src/utils/stablecoin_cents_multiplier.js";

function unwrapCents(result: ReturnType<typeof toCentsExact>): bigint {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected ok: ${result.error}`);
  }
  return result.value;
}

function unwrapDollars(result: ReturnType<typeof fromCentsExact>): string {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected ok: ${result.error}`);
  }
  return result.value;
}

describe("toCentsExact / fromCentsExact (#627, #628)", () => {
  it("floors 0.29 to exactly 29n (not 28)", () => {
    expect(unwrapCents(toCentsExact(0.29, { rounding: "floor" }))).toBe(29n);
  });

  it("ceils 0.07 to exactly 7n (not 8)", () => {
    expect(unwrapCents(toCentsExact(0.07, { rounding: "ceil" }))).toBe(7n);
  });

  it("rounds half-up: toCentsExact('1.005') is 101n", () => {
    expect(unwrapCents(toCentsExact("1.005"))).toBe(101n);
  });

  it("supports configurable decimals with bigint range (12345678901234.56 @ 7 decimals)", () => {
    expect(
      unwrapCents(toCentsExact("12345678901234.56", { decimals: 7 })),
    ).toBe(123456789012345600000n);
  });

  it("fromCentsExact inverts exactly (no float division error)", () => {
    expect(unwrapDollars(fromCentsExact(29))).toBe("0.29");
    expect(unwrapDollars(fromCentsExact(7))).toBe("0.07");
    expect(unwrapDollars(fromCentsExact(101))).toBe("1.01");
    expect(unwrapDollars(fromCentsExact("123456789012345600000", { decimals: 7 }))).toBe(
      "12345678901234.56",
    );
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
      const floor = unwrapCents(toCentsExact(s, { rounding: "floor" }));
      const ceil = unwrapCents(toCentsExact(s, { rounding: "ceil" }));
      const round = unwrapCents(toCentsExact(s, { rounding: "round" }));
      expect({ s, ceil, round }).toEqual({ s, ceil: floor, round: floor });
    }
  });
});
