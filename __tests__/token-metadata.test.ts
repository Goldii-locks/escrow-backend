import {
  DEFAULT_TOKEN_DECIMALS,
  DEFAULT_TOKEN_LABEL,
  TOKEN_LABEL_OVERRIDES,
  TokenMetadataError,
  clearTokenMetadataCache,
  formatTokenAmount,
  formatTokenAmountSync,
  getCachedTokenMetadata,
  getTokenDecimals,
  getTokenLabel,
  getTokenSymbol,
  isKnownTokenSymbol,
  normalizeTokenSymbol,
  resolveTokenMetadata,
  setTokenMetadataSimulatorForTests,
  toTokenUnits,
  type TokenMetadataViewMethod,
} from "../src/utils/token-metadata.js";

const TOKEN_ADDRESS = "CTOKENCONTRACTADDRESS0000000000000000000000000000";
const OTHER_TOKEN_ADDRESS = "COTHERTOKENCONTRACTADDRESS000000000000000000000";

function simulator(
  responses: Partial<Record<TokenMetadataViewMethod, unknown>>,
  calls: string[] = []
): (address: string, method: TokenMetadataViewMethod) => Promise<unknown> {
  return async (_address: string, method: TokenMetadataViewMethod) => {
    calls.push(method);
    const value = responses[method];
    if (value instanceof Error) throw value;
    return value;
  };
}

describe("token metadata registry (#699)", () => {
  beforeEach(() => {
    clearTokenMetadataCache();
  });

  afterEach(() => {
    setTokenMetadataSimulatorForTests(null);
    clearTokenMetadataCache();
  });

  describe("resolveTokenMetadata", () => {
    it("resolves symbol, decimals and name from the SEP-41 view calls", async () => {
      setTokenMetadataSimulatorForTests(
        simulator({ decimals: 7, symbol: "USDC", name: "USD Coin" }),
      );

      const metadata = await resolveTokenMetadata(TOKEN_ADDRESS);

      expect(metadata).toEqual({
        address: TOKEN_ADDRESS,
        symbol: "USDC",
        decimals: 7,
        name: "USD Coin",
      });
    });

    it("uses the on-chain decimals, not an assumed precision", async () => {
      setTokenMetadataSimulatorForTests(
        simulator({ decimals: 6, symbol: "USDC", name: "USD Coin" }),
      );

      await expect(getTokenDecimals(TOKEN_ADDRESS)).resolves.toBe(6);
    });

    it("caches the resolved metadata instead of simulating again", async () => {
      const calls: string[] = [];
      setTokenMetadataSimulatorForTests(
        simulator({ decimals: 7, symbol: "USDC", name: "USD Coin" }, calls),
      );

      const first = await resolveTokenMetadata(TOKEN_ADDRESS);
      const second = await resolveTokenMetadata(TOKEN_ADDRESS);

      expect(second).toBe(first);
      expect(calls).toHaveLength(3); // decimals(), symbol(), name() – once
    });

    it("keeps separate cache entries per token address", async () => {
      setTokenMetadataSimulatorForTests(
        simulator({ decimals: 6, symbol: "USDC", name: "USD Coin" }),
      );

      await resolveTokenMetadata(TOKEN_ADDRESS);
      await expect(getTokenDecimals(OTHER_TOKEN_ADDRESS)).resolves.toBe(6);
    });

    it("falls back to the display label when name() is empty", async () => {
      setTokenMetadataSimulatorForTests(
        simulator({ decimals: 7, symbol: "USDC", name: "" }),
      );

      const metadata = await resolveTokenMetadata(TOKEN_ADDRESS);
      expect(metadata.name).toBe(TOKEN_LABEL_OVERRIDES.USDC);
    });

    it("throws when decimals() cannot be simulated", async () => {
      setTokenMetadataSimulatorForTests(
        simulator({ decimals: new Error("contract error") }),
      );

      await expect(resolveTokenMetadata(TOKEN_ADDRESS)).rejects.toBeInstanceOf(
        TokenMetadataError,
      );
    });

    it("rejects an out-of-range decimals value", async () => {
      setTokenMetadataSimulatorForTests(simulator({ decimals: 99 }));

      await expect(resolveTokenMetadata(TOKEN_ADDRESS)).rejects.toBeInstanceOf(
        TokenMetadataError,
      );
    });

    it("requires a token address", async () => {
      await expect(resolveTokenMetadata("  ")).rejects.toBeInstanceOf(
        TokenMetadataError,
      );
    });
  });

  describe("cache accessors", () => {
    it("returns null for a token that was never resolved", () => {
      expect(getCachedTokenMetadata(TOKEN_ADDRESS)).toBeNull();
    });

    it("exposes the cached metadata after a resolution", async () => {
      setTokenMetadataSimulatorForTests(
        simulator({ decimals: 7, symbol: "XLM", name: "Stellar Lumens" }),
      );

      await resolveTokenMetadata(TOKEN_ADDRESS);

      expect(getCachedTokenMetadata(TOKEN_ADDRESS)?.symbol).toBe("XLM");
    });
  });

  describe("formatting", () => {
    it("formats raw amounts with the on-chain precision", async () => {
      setTokenMetadataSimulatorForTests(
        simulator({ decimals: 6, symbol: "USDC", name: "USD Coin" }),
      );

      await expect(formatTokenAmount(1_500_000n, TOKEN_ADDRESS)).resolves.toBe(
        "1.5",
      );
      await expect(formatTokenAmount(1_500_000n, TOKEN_ADDRESS, {
        fixedScale: true,
      })).resolves.toBe("1.500000");
    });

    it("uses the cached precision for the synchronous helper", async () => {
      setTokenMetadataSimulatorForTests(
        simulator({ decimals: 6, symbol: "USDC", name: "USD Coin" }),
      );

      await resolveTokenMetadata(TOKEN_ADDRESS);

      expect(formatTokenAmountSync(1_500_000n, TOKEN_ADDRESS)).toBe("1.5");
    });

    it("falls back to the Stellar-native precision when nothing is cached", () => {
      expect(formatTokenAmountSync(10_000_000n, TOKEN_ADDRESS)).toBe("1");
      expect(DEFAULT_TOKEN_DECIMALS).toBe(7);
    });

    it("converts human amounts into raw units", async () => {
      setTokenMetadataSimulatorForTests(
        simulator({ decimals: 6, symbol: "USDC", name: "USD Coin" }),
      );

      await expect(toTokenUnits("1.5", TOKEN_ADDRESS)).resolves.toBe(1_500_000n);
    });

    it("rejects human amounts that exceed the token precision", async () => {
      setTokenMetadataSimulatorForTests(
        simulator({ decimals: 6, symbol: "USDC", name: "USD Coin" }),
      );

      await expect(toTokenUnits("1.0000001", TOKEN_ADDRESS)).rejects.toThrow();
    });
  });

  describe("label overrides", () => {
    it("exposes a single static table of display labels", () => {
      expect(getTokenLabel("USDC")).toBe("USD Coin (Stellar)");
      expect(getTokenLabel("usdc")).toBe("USD Coin (Stellar)");
      expect(getTokenLabel("NOT_A_TOKEN")).toBe(DEFAULT_TOKEN_LABEL);
    });

    it("knows which symbols have a label override", () => {
      expect(isKnownTokenSymbol("XLM")).toBe(true);
      expect(isKnownTokenSymbol("constructor")).toBe(false);
      expect(isKnownTokenSymbol("toString")).toBe(false);
    });

    it("normalises ticker symbols", () => {
      expect(normalizeTokenSymbol("  usdc ")).toBe("USDC");
      expect(normalizeTokenSymbol("TOO-LONG-ASSET-CODE")).toBe("");
      expect(normalizeTokenSymbol(undefined)).toBe("");
    });
  });

  describe("symbol resolution", () => {
    it("returns the simulated symbol", async () => {
      setTokenMetadataSimulatorForTests(
        simulator({ decimals: 7, symbol: "EURC", name: "Euro Coin" }),
      );

      await expect(getTokenSymbol(TOKEN_ADDRESS)).resolves.toBe("EURC");
    });
  });
});
