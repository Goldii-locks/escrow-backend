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
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  INVALID_CSV_INPUT: "INVALID_CSV_INPUT",
  SUM_MISMATCH: "SUM_MISMATCH",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  NEGATIVE_RATE: "OVERFLOW_NEGATIVE_RATE",
} as const;

export type OverflowErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ValidationResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: OverflowErrorCode };

// ---------------------------------------------------------------------------
// TASK 1 – In-process rate limiter for conversion-rate scraper calls
// ---------------------------------------------------------------------------

type RateBucket = {
  count: number;
  resetAt: number;
};

const conversionRateBuckets = new Map<string, RateBucket>();

/**
 * Reset all in-process rate-limit buckets. Intended for use in tests only.
 */
export function resetConversionRateLimitBuckets(): void {
  conversionRateBuckets.clear();
}

function resolveConversionRateWindowMs(): number {
  const configured = Number(
    process.env.CONVERSION_RATE_WINDOW_MS ?? "60000"
  );
  return Number.isFinite(configured) && configured > 0 ? configured : 60000;
}

function resolveConversionRateMax(): number {
  const configured = Number(
    process.env.CONVERSION_RATE_MAX ?? "30"
  );
  return Number.isFinite(configured) && configured > 0 ? configured : 30;
}

export type RateLimitResult =
  | { allowed: true; remaining: number; resetAt: number }
  | { allowed: false; remaining: 0; resetAt: number; code: typeof ERROR_CODES.RATE_LIMIT_EXCEEDED };

/**
 * Check whether the caller identified by `clientKey` (e.g. an IP address or
 * API-key fingerprint) has exceeded the configured conversion-rate scraper
 * request budget for the current sliding window.
 *
 * Returns `{ allowed: true }` when the request is within budget, or
 * `{ allowed: false, code: "RATE_LIMIT_EXCEEDED" }` when the budget is
 * exhausted so the caller can return HTTP 429.
 */
export function checkConversionRateLimit(clientKey: string): RateLimitResult {
  const windowMs = resolveConversionRateWindowMs();
  const maxRequests = resolveConversionRateMax();
  const now = Date.now();

  let bucket = conversionRateBuckets.get(clientKey);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    conversionRateBuckets.set(clientKey, bucket);
  }

  bucket.count += 1;

  if (bucket.count > maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: bucket.resetAt,
      code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
    };
  }

  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - bucket.count),
    resetAt: bucket.resetAt,
  };
}

/**
 * Validate an oracle conversion rate against digit limits.
 */
export function validateConversionRate(
  rate: string | number | bigint
): ValidationResult {
  const parsed = parseIntegerInput(
    rate,
    "rate",
    ERROR_CODES.INVALID_RATE,
    ERROR_CODES.EXCESSIVE_DIGITS
  );
  if (!parsed.ok) {
    return parsed;
  }
  if (parsed.value < 0n) {
    return {
      ok: false,
      error: "rate cannot be negative",
      code: ERROR_CODES.NEGATIVE_RATE,
    };
  }
  return parsed;
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
  if (amount.value < 0n) {
    return {
      ok: false,
      error: "notional cannot be negative",
      code: ERROR_CODES.NEGATIVE_RATE,
    };
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

// ---------------------------------------------------------------------------
// TASK 2 – CSV format exporters
// ---------------------------------------------------------------------------

/** A single row in a conversion-rate CSV export. */
export interface ConversionRateRow {
  /** Human-readable asset pair label, e.g. "XLM/USDC". */
  pair: string;
  /** Integer-scaled rate value (fixed-point). */
  rate: string | number | bigint;
  /** Optional Unix timestamp (seconds) when the rate was observed. */
  timestamp?: number;
}

export type CsvExportResult =
  | { ok: true; csv: string }
  | { ok: false; error: string; code: OverflowErrorCode };

/**
 * Escape a single CSV cell value.
 * Wraps the value in double-quotes if it contains a comma, double-quote, or
 * newline, and escapes embedded double-quotes by doubling them.
 */
function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Serialize an array of conversion-rate rows to RFC 4180-compatible CSV text.
 *
 * Columns: pair, rate, timestamp (omitted when none of the rows carry one).
 *
 * Each `rate` value is validated against the digit-limit before serialization;
 * the function short-circuits and returns an error result if any rate is
 * invalid, so the caller never writes a file with malformed data.
 */
export function exportConversionRatesToCsv(
  rows: ConversionRateRow[]
): CsvExportResult {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      ok: false,
      error: "rows must be a non-empty array",
      code: ERROR_CODES.INVALID_CSV_INPUT,
    };
  }

  const includeTimestamp = rows.some((r) => r.timestamp !== undefined);
  const headerCols = includeTimestamp
    ? ["pair", "rate", "timestamp"]
    : ["pair", "rate"];
  const lines: string[] = [headerCols.join(",")];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    if (typeof row.pair !== "string" || row.pair.trim() === "") {
      return {
        ok: false,
        error: `rows[${i}].pair must be a non-empty string`,
        code: ERROR_CODES.INVALID_CSV_INPUT,
      };
    }

    const rateCheck = validateConversionRate(row.rate);
    if (!rateCheck.ok) {
      return {
        ok: false,
        error: `rows[${i}].rate: ${rateCheck.error}`,
        code: rateCheck.code,
      };
    }

    const cells: string[] = [
      escapeCsvCell(row.pair.trim()),
      escapeCsvCell(rateCheck.value.toString()),
    ];

    if (includeTimestamp) {
      const ts = row.timestamp;
      if (ts !== undefined) {
        if (
          typeof ts !== "number" ||
          !Number.isFinite(ts) ||
          !Number.isInteger(ts) ||
          ts < 0
        ) {
          return {
            ok: false,
            error: `rows[${i}].timestamp must be a non-negative integer`,
            code: ERROR_CODES.INVALID_CSV_INPUT,
          };
        }
        cells.push(String(ts));
      } else {
        cells.push("");
      }
    }

    lines.push(cells.join(","));
  }

  return { ok: true, csv: lines.join("\r\n") };
}

/**
 * Parse a CSV string produced by `exportConversionRatesToCsv` back into an
 * array of `ConversionRateRow` objects. Each rate value is re-validated on
 * the way in so round-tripped data is guaranteed to be within the digit limit.
 */
export function parseConversionRatesCsv(
  csv: string
): { ok: true; rows: ConversionRateRow[] } | { ok: false; error: string; code: OverflowErrorCode } {
  if (typeof csv !== "string" || csv.trim() === "") {
    return {
      ok: false,
      error: "csv must be a non-empty string",
      code: ERROR_CODES.INVALID_CSV_INPUT,
    };
  }

  const rawLines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (rawLines.length < 2) {
    return {
      ok: false,
      error: "csv must contain a header row and at least one data row",
      code: ERROR_CODES.INVALID_CSV_INPUT,
    };
  }

  const header = rawLines[0].split(",").map((h) => h.trim());
  const hasPair = header[0] === "pair";
  const hasRate = header[1] === "rate";
  const hasTimestamp = header[2] === "timestamp";

  if (!hasPair || !hasRate) {
    return {
      ok: false,
      error: "csv header must start with 'pair,rate'",
      code: ERROR_CODES.INVALID_CSV_INPUT,
    };
  }

  const rows: ConversionRateRow[] = [];

  for (let i = 1; i < rawLines.length; i++) {
    const cols = rawLines[i].split(",");

    const pair = cols[0]?.trim() ?? "";
    if (pair === "") {
      return {
        ok: false,
        error: `row ${i}: pair must be a non-empty string`,
        code: ERROR_CODES.INVALID_CSV_INPUT,
      };
    }

    const rateRaw = cols[1]?.trim() ?? "";
    const rateCheck = validateConversionRate(rateRaw);
    if (!rateCheck.ok) {
      return {
        ok: false,
        error: `row ${i}: rate: ${rateCheck.error}`,
        code: rateCheck.code,
      };
    }

    const row: ConversionRateRow = {
      pair,
      rate: rateCheck.value.toString(),
    };

    if (hasTimestamp && cols[2] !== undefined && cols[2].trim() !== "") {
      const ts = Number(cols[2].trim());
      if (!Number.isFinite(ts) || !Number.isInteger(ts) || ts < 0) {
        return {
          ok: false,
          error: `row ${i}: timestamp must be a non-negative integer`,
          code: ERROR_CODES.INVALID_CSV_INPUT,
        };
      }
      row.timestamp = ts;
    }

    rows.push(row);
  }

  return { ok: true, rows };
}

// ---------------------------------------------------------------------------
// TASK 3 – Split-sum assertions
// ---------------------------------------------------------------------------

export type SumCheckResult =
  | { ok: true; total: bigint; isMatch: boolean }
  | { ok: false; error: string; code: OverflowErrorCode };

/**
 * Assert that a set of split amounts adds up to an expected base amount.
 *
 * Each split value and the base amount are individually validated against the
 * digit limit before any arithmetic so the function never silently operates on
 * unsafe integers. When `strict` is true (the default) the function returns
 * `{ isMatch: false }` — rather than an error — whenever the sum does not
 * equal the base; callers that want to treat a mismatch as a hard failure
 * should check `isMatch` and act accordingly.
 */
export function assertConversionSplitSum(
  splits: Array<string | number | bigint>,
  expectedBase: string | number | bigint
): SumCheckResult {
  if (!Array.isArray(splits) || splits.length === 0) {
    return {
      ok: false,
      error: "splits must be a non-empty array",
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  const baseCheck = parseIntegerInput(
    expectedBase,
    "expectedBase",
    ERROR_CODES.INVALID_AMOUNT,
    ERROR_CODES.EXCESSIVE_DIGITS
  );
  if (!baseCheck.ok) {
    return baseCheck;
  }

  let total = 0n;

  for (let i = 0; i < splits.length; i++) {
    const splitCheck = parseIntegerInput(
      splits[i],
      `splits[${i}]`,
      ERROR_CODES.INVALID_AMOUNT,
      ERROR_CODES.EXCESSIVE_DIGITS
    );
    if (!splitCheck.ok) {
      return splitCheck;
    }

    const next = total + splitCheck.value;
    // Guard against the running total itself overflowing the digit limit.
    if (digitCount(next.toString()) > MAX_SAFE_DIGITS) {
      return {
        ok: false,
        error: `split total exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
        code: ERROR_CODES.PRODUCT_OVERFLOW,
      };
    }

    total = next;
  }

  return {
    ok: true,
    total,
    isMatch: total === baseCheck.value,
  };
}
