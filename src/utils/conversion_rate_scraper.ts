/**
 * Oracle conversion-rate scraper helpers with overflow / digit-limit validation,
 * round-half-to-even rounding, unknown asset ticker fallbacks, and DB-column
 * precision formatting.
 *
 * ## Design notes
 *
 * All core arithmetic is performed in `bigint` to avoid IEEE-754 float drift.
 * Rates are treated as integer-scaled fixed-point factors; callers own the
 * scale/exponent.
 *
 * ### Rounding
 * Division that produces a remainder is rounded with the "round-half-to-even"
 * (banker's rounding) protocol: halfway cases round to the nearest *even*
 * digit. This eliminates the systematic upward bias produced by the more
 * common "round half up" rule and is consistent with IEEE 754 default rounding
 * and the approach used by `fee_deduction_calculator`.
 *
 * ### Unknown tickers
 * `resolveAssetTicker` returns a `TickerResolution` that always succeeds —
 * unknown tickers produce a `{ known: false }` fallback instead of throwing.
 * Callers can inspect the `known` flag and decide whether to proceed, reject,
 * or emit a warning without crashing the scraper.
 *
 * ### DB precision formatting
 * `formatRateForDb` and `formatNotionalForDb` convert bigint values to decimal
 * strings with a configurable number of decimal places so that values stored in
 * `data_json` always match the precision schema expected by downstream queries
 * (e.g. 7 decimal places for Stellar stroops / XLM rates). The scale factor is
 * explicit so the formatter is stateless and trivially testable.
 */

import {
  digitCount,
  parseIntegerInput,
  MAX_SAFE_DIGITS,
} from "./digit-limit-validator.js";

export { MAX_SAFE_DIGITS };

export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "OVERFLOW_EXCESSIVE_DIGITS",
  INVALID_RATE: "OVERFLOW_INVALID_RATE",
  PRODUCT_OVERFLOW: "OVERFLOW_PRODUCT_EXCEEDED",
} as const;

export type OverflowErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ValidationResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: OverflowErrorCode };

/**
 * Validate an oracle conversion rate against digit limits.
 */
export function validateConversionRate(
  rate: string | number | bigint
): ValidationResult {
  return parseIntegerInput(
    rate,
    "rate",
    ERROR_CODES.INVALID_RATE,
    ERROR_CODES.EXCESSIVE_DIGITS
  );
}

/**
 * Convert a notional by rate after validating both operands for overflow.
 * Rate is treated as an integer scaled factor (e.g. fixed-point).
 */
export function applyConversionRate(
  notional: string | number | bigint,
  rate: string | number | bigint
): ValidationResult {
  const amount = parseIntegerInput(
    notional,
    "notional",
    ERROR_CODES.INVALID_RATE,
    ERROR_CODES.EXCESSIVE_DIGITS
  );
  if (!amount.ok) {
    return amount;
  }

  const factor = validateConversionRate(rate);
  if (!factor.ok) {
    return factor;
  }

  const product = amount.value * factor.value;
  if (digitCount(product.toString()) > MAX_SAFE_DIGITS) {
    return {
      ok: false,
      error: `converted value exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
      code: ERROR_CODES.PRODUCT_OVERFLOW,
    };
  }

  return { ok: true, value: product };
}

// ---------------------------------------------------------------------------
// Round-half-to-even (banker's rounding) for division remainders
// ---------------------------------------------------------------------------

/**
 * Divide `numerator` by `divisor` using round-half-to-even (banker's rounding).
 *
 * Pure integer arithmetic (bigint) — no float intermediate. The halfway case
 * (remainder * 2 === divisor) rounds to the nearest even integer, which
 * eliminates the systematic positive bias of "round half up".
 *
 * @example
 * divideRoundHalfEven(5n, 2n)  // 2n — halfway rounds to even (2, not 3)
 * divideRoundHalfEven(7n, 2n)  // 4n — halfway rounds to even (4, not 3)
 * divideRoundHalfEven(3n, 2n)  // 2n — halfway rounds to even (2, not 1)
 */
export function divideRoundHalfEven(numerator: bigint, divisor: bigint): bigint {
  if (divisor === 0n) {
    throw new RangeError("divideRoundHalfEven: divisor must not be zero");
  }

  const quotient = numerator / divisor;
  const remainder = numerator - quotient * divisor;

  // Absolute values for comparison (handles negative inputs)
  const absRemainder = remainder < 0n ? -remainder : remainder;
  const absDivisor = divisor < 0n ? -divisor : divisor;
  const doubleRemainder = absRemainder * 2n;

  if (doubleRemainder < absDivisor) {
    // Below halfway → truncate (round toward zero)
    return quotient;
  }

  if (doubleRemainder > absDivisor) {
    // Above halfway → round away from zero
    const direction = (numerator < 0n) !== (divisor < 0n) ? -1n : 1n;
    return quotient + direction;
  }

  // Exactly halfway → round to the nearest even integer
  const isQuotientEven = quotient % 2n === 0n;
  if (isQuotientEven) {
    return quotient;
  }
  const direction = (numerator < 0n) !== (divisor < 0n) ? -1n : 1n;
  return quotient + direction;
}

/**
 * Scale a bigint `value` by a rational `numerator / denominator` and round
 * the result using round-half-to-even.
 *
 * Useful for applying fractional conversion rates that cannot be expressed as
 * integers without loss of precision.
 *
 * @example
 * scaleWithRounding(100n, 1n, 3n)  // 33n  (100/3 = 33.333… → 33)
 * scaleWithRounding(100n, 2n, 3n)  // 67n  (200/3 = 66.666… → 67)
 */
export function scaleWithRounding(
  value: bigint,
  scaleNumerator: bigint,
  scaleDenominator: bigint
): bigint {
  if (scaleDenominator === 0n) {
    throw new RangeError("scaleWithRounding: scaleDenominator must not be zero");
  }
  return divideRoundHalfEven(value * scaleNumerator, scaleDenominator);
}

// ---------------------------------------------------------------------------
// Unknown asset ticker fallbacks
// ---------------------------------------------------------------------------

/**
 * Well-known Stellar asset tickers with their decimal precision (stroops/units)
 * and a human-readable label.
 */
export interface KnownAssetConfig {
  /** Ticker symbol (e.g. "XLM", "USDC") */
  ticker: string;
  /**
   * Number of decimal places the asset uses.
   * XLM uses 7 (1 XLM = 10^7 stroops); most Stellar tokens use 7.
   */
  decimals: number;
  /** Human-readable asset name */
  label: string;
}

const KNOWN_ASSETS: Record<string, KnownAssetConfig> = {
  XLM:  { ticker: "XLM",  decimals: 7, label: "Stellar Lumens" },
  USDC: { ticker: "USDC", decimals: 7, label: "USD Coin (Stellar)" },
  USDT: { ticker: "USDT", decimals: 7, label: "Tether (Stellar)" },
  BTC:  { ticker: "BTC",  decimals: 7, label: "Bitcoin (Stellar)" },
  ETH:  { ticker: "ETH",  decimals: 7, label: "Ether (Stellar)" },
};

/**
 * Result of a ticker resolution. Callers must inspect `known` before relying
 * on `config` — an unknown ticker always carries the default fallback config.
 */
export type TickerResolution =
  | { known: true;  ticker: string; config: KnownAssetConfig }
  | { known: false; ticker: string; config: KnownAssetConfig; fallback: true };

/**
 * Default fallback configuration used for any ticker not present in
 * `KNOWN_ASSETS`. Uses 7 decimal places (Stellar-native precision) so that
 * downstream formatters produce a valid DB value even for novel token types.
 */
export const DEFAULT_ASSET_FALLBACK: KnownAssetConfig = {
  ticker: "UNKNOWN",
  decimals: 7,
  label: "Unknown Stellar Token",
};

/**
 * Resolve an asset ticker string to its configuration, returning a typed
 * fallback for any ticker not found in the registry.
 *
 * This function **never throws**. Callers receive either:
 * - `{ known: true, config }` — a recognised ticker with its full config, or
 * - `{ known: false, config, fallback: true }` — an unrecognised ticker with
 *   the default fallback config, so the scraper can continue safely.
 *
 * @example
 * resolveAssetTicker("XLM")       // { known: true,  ticker: "XLM",     config: { decimals: 7, … } }
 * resolveAssetTicker("NOVEL_TOK") // { known: false, ticker: "NOVEL_TOK", config: DEFAULT_ASSET_FALLBACK, fallback: true }
 */
export function resolveAssetTicker(rawTicker: string): TickerResolution {
  const ticker = rawTicker.trim().toUpperCase();
  const config = KNOWN_ASSETS[ticker];

  if (config !== undefined) {
    return { known: true, ticker, config };
  }

  return {
    known: false,
    ticker: rawTicker.trim(),
    config: { ...DEFAULT_ASSET_FALLBACK, ticker: rawTicker.trim() },
    fallback: true,
  };
}

// ---------------------------------------------------------------------------
// DB-column precision formatting
// ---------------------------------------------------------------------------

/**
 * Format a bigint `value` as a decimal string with exactly `decimals` places,
 * suitable for storage in `data_json` columns that downstream queries expect
 * to have a fixed number of fractional digits.
 *
 * The `value` is the **already-scaled** integer representation
 * (e.g. stroops for XLM). `decimals` is the number of decimal places to
 * restore (e.g. 7 for XLM so 10_000_000n → "1.0000000").
 *
 * Negative values are handled correctly: the minus sign is preserved.
 *
 * @example
 * formatForDb(10_000_000n, 7)   // "1.0000000"
 * formatForDb(12_345_678n, 7)   // "1.2345678"
 * formatForDb(1n, 7)            // "0.0000001"
 * formatForDb(-5_000_000n, 7)   // "-0.5000000"
 * formatForDb(100n, 0)          // "100"
 */
export function formatForDb(value: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(
      `formatForDb: decimals must be a non-negative integer, got ${decimals}`
    );
  }

  if (decimals === 0) {
    return value.toString();
  }

  const isNegative = value < 0n;
  const abs = isNegative ? -value : value;
  const scale = 10n ** BigInt(decimals);

  const integerPart = abs / scale;
  const fractionalPart = abs % scale;

  // Pad fractional part with leading zeros to `decimals` width
  const fracStr = fractionalPart.toString().padStart(decimals, "0");
  const formatted = `${integerPart.toString()}.${fracStr}`;

  return isNegative ? `-${formatted}` : formatted;
}

/**
 * Format a conversion rate bigint for DB storage with the precision specified
 * by the asset's ticker configuration.
 *
 * Resolves the ticker first (unknown tickers receive the default 7-decimal
 * fallback) and then delegates to `formatForDb`.
 *
 * @example
 * formatRateForDb(12_345_678n, "XLM")  // "1.2345678"
 * formatRateForDb(10_000_000n, "USDC") // "1.0000000"
 * formatRateForDb(5_000_000n, "???")   // "0.5000000"  (fallback: 7 decimals)
 */
export function formatRateForDb(rate: bigint, ticker: string): string {
  const resolution = resolveAssetTicker(ticker);
  return formatForDb(rate, resolution.config.decimals);
}

/**
 * Format a notional amount bigint for DB storage with the precision specified
 * by the asset's ticker configuration.
 *
 * Identical to `formatRateForDb` except the label in the resolution step
 * represents the notional asset rather than the rate asset — useful when the
 * two assets differ.
 *
 * @example
 * formatNotionalForDb(100_000_000n, "USDC") // "10.0000000"
 */
export function formatNotionalForDb(notional: bigint, ticker: string): string {
  const resolution = resolveAssetTicker(ticker);
  return formatForDb(notional, resolution.config.decimals);
}
