import {
  ERROR_CODES,
  MAX_SAFE_DIGITS,
  DEFAULT_STABLECOIN_CONFIG,
  STABLECOIN_CONFIGS,
  getStablecoinConfig,
  stablecoin_cents_multiplier,
  toCents,
} from "../src/utils/stablecoin_cents_multiplier.js";

describe("stablecoin_cents_multiplier ticker configuration (#479)", () => {
  describe("getStablecoinConfig", () => {
    it("returns the configuration for a known ticker", () => {
      expect(getStablecoinConfig("USDC")).toEqual(STABLECOIN_CONFIGS.USDC);
    });

    it("is case-insensitive and ignores surrounding whitespace", () => {
      expect(getStablecoinConfig("  usdt ")).toEqual(STABLECOIN_CONFIGS.USDT);
    });

    it.each([["UNKNOWN"], [""], [null], [undefined], ["toString"]])(
      "falls back to the default config for %p",
      (ticker) => {
        expect(getStablecoinConfig(ticker as string | null | undefined)).toEqual(
          DEFAULT_STABLECOIN_CONFIG
        );
      }
    );
  });

  describe("stablecoin_cents_multiplier", () => {
    it("returns the multiplier for known and unknown tickers", () => {
      expect(stablecoin_cents_multiplier("USDC")).toBe(100);
      expect(stablecoin_cents_multiplier("NOT_A_TOKEN")).toBe(
        DEFAULT_STABLECOIN_CONFIG.centsMultiplier
      );
    });
  });

  describe("toCents", () => {
    it("converts whole and fractional amounts exactly", () => {
      expect(toCents("25", "USDC")).toEqual({ ok: true, value: 2500n });
      expect(toCents("12.34", "USDC")).toEqual({ ok: true, value: 1234n });
      expect(toCents(0.1, "USDC")).toEqual({ ok: true, value: 10n });
      expect(toCents("0", "USDC")).toEqual({ ok: true, value: 0n });
    });

    it("uses the default precision for unknown tickers", () => {
      expect(toCents("1.5", "MYSTERY")).toEqual({ ok: true, value: 150n });
    });

    it("rejects negative amounts (#478)", () => {
      const result = toCents("-1.50", "USDC");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects precision finer than the asset allows", () => {
      const result = toCents("1.005", "USDC");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects non-numeric and non-finite input", () => {
      expect(toCents("abc", "USDC").ok).toBe(false);
      expect(toCents(Number.NaN, "USDC").ok).toBe(false);
    });

    it("rejects results that exceed the digit limit", () => {
      const result = toCents("9".repeat(MAX_SAFE_DIGITS), "USDC");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.CONVERSION_OVERFLOW);
      }
    });
  });
});
