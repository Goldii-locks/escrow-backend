import {
  ERROR_CODES,
  DEFAULT_STABLECOIN_CONFIG,
  getStablecoinConfig,
  toCents,
} from "../src/utils/stablecoin_cents_multiplier.js";
import {
  clearTokenMetadataCache,
  setTokenMetadataSimulatorForTests,
  type TokenMetadataViewMethod,
} from "../src/utils/token-metadata.js";

// A token contract address used as the lookup key. The simulation is mocked,
// so the value never has to exist on chain.
const TOKEN_ADDRESS = "CTOKENCONTRACTADDRESS0000000000000000000000000000";

// The largest amount the contract accepts.
const I128_MAX = (2n ** 127n - 1n).toString();

function mockToken(
  decimals: number,
  symbol = "USDC",
  name = "USD Coin"
): (address: string, method: TokenMetadataViewMethod) => Promise<unknown> {
  return async (_address: string, method: TokenMetadataViewMethod) => {
    if (method === "decimals") return decimals;
    if (method === "symbol") return symbol;
    return name;
  };
}

describe("stablecoin_cents_multiplier token precision (#699)", () => {
  beforeEach(() => {
    clearTokenMetadataCache();
    setTokenMetadataSimulatorForTests(mockToken(7));
  });

  afterEach(() => {
    setTokenMetadataSimulatorForTests(null);
    clearTokenMetadataCache();
  });

  describe("getStablecoinConfig", () => {
    it("reads the precision from the token contract", async () => {
      const config = await getStablecoinConfig(TOKEN_ADDRESS);
      expect(config).toEqual({ decimals: 7, centsMultiplier: 10_000_000 });
    });

    it("uses the on-chain decimals instead of assuming 7", async () => {
      setTokenMetadataSimulatorForTests(mockToken(6));
      const config = await getStablecoinConfig(TOKEN_ADDRESS);
      expect(config.decimals).toBe(6);
      expect(config.centsMultiplier).toBe(1_000_000);
    });

    it("supports tokens without fractional digits", async () => {
      setTokenMetadataSimulatorForTests(mockToken(0));
      const config = await getStablecoinConfig(TOKEN_ADDRESS);
      expect(config).toEqual({ decimals: 0, centsMultiplier: 1 });
    });

    it("falls back to the Stellar-native default precision", () => {
      expect(DEFAULT_STABLECOIN_CONFIG).toEqual({
        decimals: 7,
        centsMultiplier: 10_000_000,
      });
    });
  });

  describe("toCents", () => {
    it("converts whole and fractional amounts at the token precision", async () => {
      await expect(toCents("25", TOKEN_ADDRESS)).resolves.toEqual({
        ok: true,
        value: 250_000_000n,
      });
      await expect(toCents("12.34", TOKEN_ADDRESS)).resolves.toEqual({
        ok: true,
        value: 123_400_000n,
      });
      await expect(toCents(0.1, TOKEN_ADDRESS)).resolves.toEqual({
        ok: true,
        value: 1_000_000n,
      });
      await expect(toCents("0", TOKEN_ADDRESS)).resolves.toEqual({
        ok: true,
        value: 0n,
      });
    });

    it("scales with the on-chain decimals", async () => {
      setTokenMetadataSimulatorForTests(mockToken(2));
      await expect(toCents("1.5", TOKEN_ADDRESS)).resolves.toEqual({
        ok: true,
        value: 150n,
      });
    });

    it("rejects negative amounts (#478)", async () => {
      const result = await toCents("-1.50", TOKEN_ADDRESS);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects precision finer than the asset allows", async () => {
      // 8 fractional digits for a 7-decimal token.
      const result = await toCents("1.00000001", TOKEN_ADDRESS);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("rejects non-numeric and non-finite input", async () => {
      expect((await toCents("abc", TOKEN_ADDRESS)).ok).toBe(false);
      expect((await toCents(Number.NaN, TOKEN_ADDRESS)).ok).toBe(false);
    });

    it("rejects results that leave the i128 range", async () => {
      const result = await toCents(I128_MAX, TOKEN_ADDRESS);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.CONVERSION_OVERFLOW);
      }
    });

    it("reports an error when the token metadata cannot be resolved", async () => {
      setTokenMetadataSimulatorForTests(async () => {
        throw new Error("RPC unavailable");
      });
      const result = await toCents("1", TOKEN_ADDRESS);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/RPC unavailable/);
      }
    });
  });
});
