/**
 * Financial report exporter (transaction logs spreadsheet writer).
 *
 * Writes transaction rows for reporting exports while tolerating unfamiliar
 * Stellar token types: unknown asset tickers resolve to a default format
 * configuration instead of throwing, so a novel token never blocks a report.
 *
 * Design follows `conversion_rate_scraper.ts` (ticker registry + typed
 * `{ known }` fallback) and the DB-precision vocabulary used by
 * `partial-payment-allocator.ts`.
 */

export interface ReportAssetConfig {
  /** Ticker symbol (e.g. "XLM", "USDC") */
  ticker: string;
  /** Decimal places used when formatting amounts for this asset */
  decimals: number;
  /** Human-readable asset name */
  label: string;
}

const KNOWN_REPORT_ASSETS: Record<string, ReportAssetConfig> = {
  XLM: { ticker: "XLM", decimals: 7, label: "Stellar Lumens" },
  USDC: { ticker: "USDC", decimals: 7, label: "USD Coin (Stellar)" },
  USDT: { ticker: "USDT", decimals: 7, label: "Tether (Stellar)" },
  BTC: { ticker: "BTC", decimals: 7, label: "Bitcoin (Stellar)" },
  ETH: { ticker: "ETH", decimals: 7, label: "Ether (Stellar)" },
};

export type ReportTickerResolution =
  | { known: true; ticker: string; config: ReportAssetConfig }
  | { known: false; ticker: string; config: ReportAssetConfig; fallback: true };

/**
 * Default fallback configuration for tickers absent from the registry.
 * Stellar-native 7-decimal precision keeps downstream formatting valid.
 */
export const DEFAULT_REPORT_ASSET_FALLBACK: ReportAssetConfig = {
  ticker: "UNKNOWN",
  decimals: 7,
  label: "Unknown Stellar Token",
};

export const REPORT_EXPORTER_ERRORS = {
  INVALID_TICKER: "REPORT_INVALID_TICKER",
  INVALID_AMOUNT: "REPORT_INVALID_AMOUNT",
  INVALID_ROW: "REPORT_INVALID_ROW",
  EMPTY_ROWS: "REPORT_EMPTY_ROWS",
} as const;

export type ReportExporterErrorCode =
  (typeof REPORT_EXPORTER_ERRORS)[keyof typeof REPORT_EXPORTER_ERRORS];

/**
 * Resolve a raw asset ticker to its report configuration.
 *
 * Never throws: unrecognised tickers yield `{ known: false, fallback: true }`
 * carrying the default configuration, so exports continue with a marked
 * fallback instead of crashing on novel token types.
 */
export function resolveReportTicker(rawTicker: unknown): ReportTickerResolution {
  if (typeof rawTicker !== "string" || rawTicker.trim() === "") {
    return {
      known: false,
      ticker: typeof rawTicker === "string" ? rawTicker.trim() : "",
      config: { ...DEFAULT_REPORT_ASSET_FALLBACK },
      fallback: true,
    };
  }
  const ticker = rawTicker.trim().toUpperCase();
  const config = KNOWN_REPORT_ASSETS[ticker];
  if (config !== undefined) {
    return { known: true, ticker, config };
  }
  return {
    known: false,
    ticker: rawTicker.trim(),
    config: { ...DEFAULT_REPORT_ASSET_FALLBACK, ticker: rawTicker.trim() },
    fallback: true,
  };
}

/** A single transaction row supplied for export. */
export interface ReportTransactionRow {
  /** Asset ticker for the transacted token */
  ticker: string;
  /** Integer-scaled amount (e.g. stroops) */
  amount: string | number | bigint;
  /** Optional transaction hash / reference */
  txHash?: string;
}

/** A row after ticker resolution, ready for formatting. */
export interface ResolvedReportRow {
  ticker: string;
  amount: bigint;
  decimals: number;
  known: boolean;
  fallback: boolean;
  txHash?: string;
}

export type ResolveReportRowResult =
  | { ok: true; row: ResolvedReportRow }
  | { ok: false; error: string; code: ReportExporterErrorCode };

function parseReportAmount(
  amount: string | number | bigint
): { ok: true; value: bigint } | { ok: false; error: string } {
  if (typeof amount === "bigint") {
    return { ok: true, value: amount };
  }
  if (typeof amount === "number") {
    if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
      return { ok: false, error: "amount must be a finite integer" };
    }
    return { ok: true, value: BigInt(amount) };
  }
  const raw = amount.trim();
  if (!/^-?\d+$/.test(raw)) {
    return { ok: false, error: "amount must be an integer numeric value" };
  }
  return { ok: true, value: BigInt(raw) };
}

/**
 * Resolve one transaction row: amount is validated and the ticker is
 * resolved (with fallback for unknown tickers). Unknown tickers are NOT an
 * error — the row carries `fallback: true` so the report can flag it.
 */
export function resolveReportRow(row: ReportTransactionRow): ResolveReportRowResult {
  if (row === null || typeof row !== "object") {
    return {
      ok: false,
      error: "row must be a non-null object",
      code: REPORT_EXPORTER_ERRORS.INVALID_ROW,
    };
  }
  const parsed = parseReportAmount(row.amount);
  if (!parsed.ok) {
    return {
      ok: false,
      error: `amount: ${parsed.error}`,
      code: REPORT_EXPORTER_ERRORS.INVALID_AMOUNT,
    };
  }
  const resolution = resolveReportTicker(row.ticker);
  return {
    ok: true,
    row: {
      ticker: resolution.ticker,
      amount: parsed.value,
      decimals: resolution.config.decimals,
      known: resolution.known,
      fallback: resolution.known ? false : true,
      ...(row.txHash !== undefined ? { txHash: row.txHash } : {}),
    },
  };
}

/**
 * Database precision schemas for report row columns (issue #507).
 * Amounts render as exact TEXT (bigint-safe); the ticker column is TEXT.
 */
export type ReportDbColumnFormat = "BIGINT" | "DECIMAL" | "TEXT";

export interface ReportDbColumnSchema {
  field: string;
  format: ReportDbColumnFormat;
  maxDigits?: number;
  nullable?: boolean;
}

export const STANDARD_REPORT_DB_SCHEMAS: Record<string, ReportDbColumnSchema> = {
  amount: { field: "amount", format: "TEXT", nullable: false },
  total: { field: "total", format: "TEXT", nullable: false },
  ticker: { field: "ticker", format: "TEXT", nullable: false },
};

export interface FormattedReportRow {
  ticker: string;
  amount: string;
  decimals: number;
  fallback: boolean;
  precision_preserved: boolean;
  original_amount_bigint: string;
  txHash?: string;
}

export type FormatReportRowResult =
  | { ok: true; row: FormattedReportRow }
  | { ok: false; error: string; code: ReportExporterErrorCode };

/**
 * Format a bigint report `value` as a decimal string with exactly `decimals`
 * fractional digits for DB storage. `decimals = 0` renders a plain integer.
 */
export function formatReportValueForDb(value: bigint, decimals: number): string {
  if (typeof value !== "bigint") {
    throw new TypeError("formatReportValueForDb: value must be a bigint");
  }
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(
      `formatReportValueForDb: decimals must be a non-negative integer, got ${decimals}`
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
  const fracStr = fractionalPart.toString().padStart(decimals, "0");
  const formatted = `${integerPart.toString()}.${fracStr}`;
  return isNegative ? `-${formatted}` : formatted;
}

/**
 * Confirm a formatted value round-trips to the original bigint: exact parse
 * for `decimals = 0`, or point-stripped comparison at fixed scale otherwise.
 */
export function reportFormatPreservesPrecision(
  original: bigint,
  formatted: string,
  decimals: number
): boolean {
  try {
    if (decimals === 0) {
      return BigInt(formatted) === original;
    }
    const negative = formatted.startsWith("-");
    const digits = (negative ? formatted.slice(1) : formatted).replace(".", "");
    return BigInt((negative ? "-" : "") + digits) === original;
  } catch {
    return false;
  }
}

/**
 * Format one transaction row for database storage at the precision dictated
 * by its ticker configuration (unknown tickers use the 7-decimal fallback).
 * The written attributes are checked for precision loss before return.
 */
export function formatReportRowForDb(row: ReportTransactionRow): FormatReportRowResult {
  const resolved = resolveReportRow(row);
  if (!resolved.ok) {
    return resolved;
  }
  const { ticker, amount, decimals, fallback, txHash } = resolved.row;
  const formatted = formatReportValueForDb(amount, decimals);
  if (!reportFormatPreservesPrecision(amount, formatted, decimals)) {
    return {
      ok: false,
      error: "precision loss detected while formatting report row for DB storage",
      code: REPORT_EXPORTER_ERRORS.INVALID_ROW,
    };
  }
  return {
    ok: true,
    row: {
      ticker,
      amount: formatted,
      decimals,
      fallback,
      precision_preserved: true,
      original_amount_bigint: amount.toString(),
      ...(txHash !== undefined ? { txHash } : {}),
    },
  };
}

/**
 * Resolve a batch of rows, short-circuiting on the first invalid amount.
 * Unknown tickers never short-circuit — each resolves with its fallback.
 */
export function resolveReportRows(
  rows: ReportTransactionRow[]
): { ok: true; rows: ResolvedReportRow[] } | { ok: false; error: string; code: ReportExporterErrorCode } {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      ok: false,
      error: "rows must be a non-empty array",
      code: REPORT_EXPORTER_ERRORS.EMPTY_ROWS,
    };
  }
  const resolved: ResolvedReportRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const result = resolveReportRow(rows[i]);
    if (!result.ok) {
      return {
        ok: false,
        error: `rows[${i}]: ${result.error}`,
        code: result.code,
      };
    }
    resolved.push(result.row);
  }
  return { ok: true, rows: resolved };
}
