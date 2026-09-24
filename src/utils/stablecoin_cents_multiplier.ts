/**
 * Integer precision conversion helper for stablecoin amounts.
 *
 * Stellar assets are identified by their ticker key (e.g. "USDC", "USDT").
 * Each known stablecoin has a fixed number of decimal places (cents multiplier)
 * used to convert between human-readable amounts and integer base units.
 *
 * Unknown or missing ticker keys fall back to a default configuration so that
 * callers never have to guard against unrecognized assets.
 */

export interface StablecoinConfig {
  /** Number of decimal places used by the asset. */
  decimals: number;
  /** Multiplier applied to convert whole units into integer cents. */
  centsMultiplier: number;
}

/**
 * Default configuration applied when a ticker key is missing or unknown.
 * Mirrors the most common stablecoin layout (2 decimals / 100 cents).
 */
export const DEFAULT_STABLECOIN_CONFIG: StablecoinConfig = {
  decimals: 2,
  centsMultiplier: 100,
};

/**
 * Known Stellar stablecoin ticker keys mapped to their precision config.
 * Keys are normalized to upper-case for case-insensitive lookups.
 */
export const STABLECOIN_CONFIGS: Record<string, StablecoinConfig> = {
  USDC: { decimals: 2, centsMultiplier: 100 },
  USDT: { decimals: 2, centsMultiplier: 100 },
  USD: { decimals: 2, centsMultiplier: 100 },
  DAI: { decimals: 2, centsMultiplier: 100 },
  EURC: { decimals: 2, centsMultiplier: 100 },
};

/**
 * Normalize a ticker key for lookup. Returns an empty string for missing or
 * non-string values so callers can rely on a single fallback path.
 */
function normalizeTicker(ticker?: string | null): string {
  if (typeof ticker !== "string") {
    return "";
  }
  return ticker.trim().toUpperCase();
}

/**
 * Resolve the configuration for a given ticker key.
 *
 * Unknown, empty, or missing ticker keys return the default configuration so
 * that parsing never throws on unfamiliar Stellar token types.
 */
export function getStablecoinConfig(
  ticker?: string | null,
): StablecoinConfig {
  const key = normalizeTicker(ticker);
  if (!key) {
    return DEFAULT_STABLECOIN_CONFIG;
  }
  return STABLECOIN_CONFIGS[key] ?? DEFAULT_STABLECOIN_CONFIG;
}

/**
 * Return the cents multiplier for a ticker key, falling back to the default
 * configuration when the ticker is missing or unknown.
 */
export function stablecoin_cents_multiplier(
  ticker?: string | null,
): number {
  return getStablecoinConfig(ticker).centsMultiplier;
}

/**
 * Convert a human-readable stablecoin amount into integer cents using the
 * resolved multiplier for the given ticker key.
 */
export function toCents(
  amount: number,
  ticker?: string | null,
): number {
  const { centsMultiplier } = getStablecoinConfig(ticker);
  return Math.round(amount * centsMultiplier);
}

export default stablecoin_cents_multiplier;
