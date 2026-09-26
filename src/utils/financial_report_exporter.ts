/**
 * Financial Report Exporter
 *
 * Builds the CSV formatting blocks that make up a transaction-log spreadsheet:
 * a header block, one row block per ledger entry, and an optional summary
 * footer carrying per-asset totals.
 *
 * Amounts are kept as integers in the smallest unit (bigint) and validated
 * through the shared digit-limit validator, so no value can silently lose
 * precision while a report is being rendered.
 */

import { writeFile } from "node:fs/promises";
import { escapeCSVField } from "./csv-serializer.js";
import { parseIntegerInput } from "./digit-limit-validator.js";

export const FINANCIAL_REPORT_EXPORTER_ERRORS = {
  EMPTY_ROWS: "FRE_EMPTY_ROWS",
  INVALID_ROW: "FRE_INVALID_ROW",
  INVALID_AMOUNT: "FRE_INVALID_AMOUNT",
  INVALID_OPTION: "FRE_INVALID_OPTION",
} as const;

export type FinancialReportErrorCode =
  (typeof FINANCIAL_REPORT_EXPORTER_ERRORS)[keyof typeof FINANCIAL_REPORT_EXPORTER_ERRORS];

export type ReportDirection = "credit" | "debit";

/** A single transaction-log entry as it appears in the spreadsheet. */
export type FinancialReportRow = {
  timestamp: string;
  transactionId: string;
  walletAddress: string;
  direction: ReportDirection;
  amountMinor: string | number | bigint;
  asset: string;
  balanceMinor: string | number | bigint;
  memo?: string | null;
};

export const REPORT_COLUMNS = [
  "timestamp",
  "transaction_id",
  "wallet_address",
  "direction",
  "amount",
  "asset",
  "balance",
  "memo",
] as const;

export type ReportColumn = (typeof REPORT_COLUMNS)[number];

export type FinancialReportOptions = {
  /** Column subset/order. Defaults to every REPORT_COLUMNS entry, in order. */
  columns?: readonly ReportColumn[];
  includeHeader?: boolean;
  includeSummary?: boolean;
  delimiter?: string;
  newline?: "\n" | "\r\n";
  /** Label used in the `timestamp` cell of the summary rows. */
  summaryLabel?: string;
  /** Decimal places used when rendering minor units. Defaults to 7 (stroops). */
  assetDecimals?: number;
};

export type ResolvedReportOptions = {
  columns: readonly ReportColumn[];
  includeHeader: boolean;
  includeSummary: boolean;
  delimiter: string;
  newline: "\n" | "\r\n";
  summaryLabel: string;
  assetDecimals: number;
};

export type NormalizedReportRow = {
  timestamp: string;
  transactionId: string;
  walletAddress: string;
  direction: ReportDirection;
  amountMinor: bigint;
  asset: string;
  balanceMinor: bigint;
  memo: string;
};

export type RowValidation =
  | { ok: true; row: NormalizedReportRow }
  | { ok: false; error: string; code: FinancialReportErrorCode };

export type AssetTotals = {
  credits: bigint;
  debits: bigint;
  net: bigint;
};

export type FinancialReport = {
  csv: string;
  columns: readonly ReportColumn[];
  rowCount: number;
  totals: Map<string, AssetTotals>;
};

const DIRECTIONS: readonly ReportDirection[] = ["credit", "debit"];

/** Apply defaults and reject options that cannot produce a valid table. */
export function resolveReportOptions(
  options: FinancialReportOptions = {}
): ResolvedReportOptions | never {
  const columns = options.columns ?? REPORT_COLUMNS;

  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error(`${FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_OPTION}: columns must not be empty`);
  }
  for (const column of columns) {
    if (!REPORT_COLUMNS.includes(column)) {
      throw new Error(
        `${FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_OPTION}: unknown column "${column}"`
      );
    }
  }

  const delimiter = options.delimiter ?? ",";
  if (delimiter.length === 0) {
    throw new Error(`${FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_OPTION}: delimiter must not be empty`);
  }

  const newline = options.newline ?? "\n";
  if (newline !== "\n" && newline !== "\r\n") {
    throw new Error(`${FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_OPTION}: unsupported newline`);
  }

  const assetDecimals = options.assetDecimals ?? 7;
  if (!Number.isInteger(assetDecimals) || assetDecimals < 0 || assetDecimals > 18) {
    throw new Error(
      `${FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_OPTION}: assetDecimals must be an integer between 0 and 18`
    );
  }

  return {
    columns: [...columns],
    includeHeader: options.includeHeader ?? true,
    includeSummary: options.includeSummary ?? true,
    delimiter,
    newline,
    summaryLabel: options.summaryLabel ?? "TOTAL",
    assetDecimals,
  };
}

/** Render a minor-unit integer as a fixed-point decimal string. */
export function formatMinorUnits(minor: bigint, decimals = 7): string {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;

  if (decimals === 0) {
    return `${negative ? "-" : ""}${absolute.toString()}`;
  }

  const padded = absolute.toString().padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Validate and normalise one report row; amounts become bigints. */
export function validateReportRow(input: FinancialReportRow, index = 0): RowValidation {
  const fail = (error: string, code: FinancialReportErrorCode): RowValidation => ({
    ok: false,
    error: `row[${index}]: ${error}`,
    code,
  });

  if (typeof input !== "object" || input === null) {
    return fail("expected an object", FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_ROW);
  }

  if (!isNonEmptyString(input.timestamp)) {
    return fail("timestamp is required", FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_ROW);
  }
  if (Number.isNaN(Date.parse(input.timestamp))) {
    return fail(`timestamp "${input.timestamp}" is not a parseable date`, FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_ROW);
  }
  if (!isNonEmptyString(input.transactionId)) {
    return fail("transactionId is required", FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_ROW);
  }
  if (!isNonEmptyString(input.walletAddress)) {
    return fail("walletAddress is required", FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_ROW);
  }
  if (!DIRECTIONS.includes(input.direction)) {
    return fail(`direction must be "credit" or "debit"`, FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_ROW);
  }
  if (!isNonEmptyString(input.asset)) {
    return fail("asset is required", FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_ROW);
  }

  const amount = parseIntegerInput(
    input.amountMinor,
    "amountMinor",
    FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_AMOUNT,
    FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_AMOUNT
  );
  if (!amount.ok) {
    return fail(amount.error, FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_AMOUNT);
  }
  if (amount.value < 0n) {
    return fail("amountMinor must not be negative", FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_AMOUNT);
  }

  const balance = parseIntegerInput(
    input.balanceMinor,
    "balanceMinor",
    FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_AMOUNT,
    FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_AMOUNT
  );
  if (!balance.ok) {
    return fail(balance.error, FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_AMOUNT);
  }

  return {
    ok: true,
    row: {
      timestamp: input.timestamp,
      transactionId: input.transactionId,
      walletAddress: input.walletAddress,
      direction: input.direction,
      amountMinor: amount.value,
      asset: input.asset,
      balanceMinor: balance.value,
      memo: input.memo ?? "",
    },
  };
}

function cellValue(
  column: ReportColumn,
  row: NormalizedReportRow,
  decimals: number
): string {
  switch (column) {
    case "timestamp":
      return row.timestamp;
    case "transaction_id":
      return row.transactionId;
    case "wallet_address":
      return row.walletAddress;
    case "direction":
      return row.direction;
    case "amount":
      return formatMinorUnits(row.amountMinor, decimals);
    case "asset":
      return row.asset;
    case "balance":
      return formatMinorUnits(row.balanceMinor, decimals);
    case "memo":
      return row.memo;
    default:
      return "";
  }
}

/**
 * Build a single CSV line from already-rendered cells. Every cell is escaped
 * so an embedded delimiter, quote or newline cannot break the table.
 */
export function formatBlock(cells: Array<string | number | bigint>, options: ResolvedReportOptions): string {
  return cells.map((cell) => escapeCSVField(cell)).join(options.delimiter);
}

/** The header block: one line holding the column names. */
export function formatHeaderBlock(options: ResolvedReportOptions): string {
  return formatBlock([...options.columns], options);
}

/** The row block for one entry. */
export function formatRowBlock(row: NormalizedReportRow, options: ResolvedReportOptions): string {
  return formatBlock(
    options.columns.map((column) => cellValue(column, row, options.assetDecimals)),
    options
  );
}

/** Per-asset credit/debit/net totals across the given rows. */
export function totalsForRows(rows: NormalizedReportRow[]): Map<string, AssetTotals> {
  const totals = new Map<string, AssetTotals>();

  for (const row of rows) {
    const current = totals.get(row.asset) ?? { credits: 0n, debits: 0n, net: 0n };
    if (row.direction === "credit") {
      current.credits += row.amountMinor;
    } else {
      current.debits += row.amountMinor;
    }
    current.net = current.credits - current.debits;
    totals.set(row.asset, current);
  }

  return totals;
}

/**
 * The summary footer: one line per asset, placed in the same column shape as a
 * data row so downstream spreadsheets can keep a single table.
 */
export function formatSummaryBlock(
  rows: NormalizedReportRow[],
  options: ResolvedReportOptions
): string[] {
  const totals = totalsForRows(rows);
  const lines: string[] = [];

  for (const asset of [...totals.keys()].sort()) {
    const total = totals.get(asset)!;
    const cells = options.columns.map((column) => {
      switch (column) {
        case "timestamp":
          return options.summaryLabel;
        case "transaction_id":
          return "SUMMARY";
        case "direction":
          return "net";
        case "amount":
          return formatMinorUnits(total.net, options.assetDecimals);
        case "asset":
          return asset;
        case "memo":
          return `credits=${formatMinorUnits(total.credits, options.assetDecimals)}; debits=${formatMinorUnits(total.debits, options.assetDecimals)}`;
        default:
          return "";
      }
    });
    lines.push(formatBlock(cells, options));
  }

  return lines;
}

/** Serialize every block into one CSV document. */
export function serializeFinancialReport(
  rows: FinancialReportRow[],
  options: FinancialReportOptions = {}
): string {
  return buildFinancialReport(rows, options).csv;
}

/** Serialize the report and return the totals computed while rendering it. */
export function buildFinancialReport(
  rows: FinancialReportRow[],
  options: FinancialReportOptions = {}
): FinancialReport {
  const resolved = resolveReportOptions(options);

  const normalized: NormalizedReportRow[] = rows.map((row, index) => {
    const validation = validateReportRow(row, index);
    if (!validation.ok) {
      throw new Error(`${validation.code}: ${validation.error}`);
    }
    return validation.row;
  });

  const lines: string[] = [];
  // A report with no rows produces an empty document rather than a lone
  // header line, so callers can treat "" as "nothing to export".
  if (resolved.includeHeader && normalized.length > 0) {
    lines.push(formatHeaderBlock(resolved));
  }
  for (const row of normalized) {
    lines.push(formatRowBlock(row, resolved));
  }
  if (resolved.includeSummary && normalized.length > 0) {
    lines.push(...formatSummaryBlock(normalized, resolved));
  }

  const csv = lines.length === 0 ? "" : `${lines.join(resolved.newline)}${resolved.newline}`;

  return {
    csv,
    columns: resolved.columns,
    rowCount: normalized.length,
    totals: totalsForRows(normalized),
  };
}

/**
 * Render the report and write it to disk. The returned `bytes` is the UTF-8
 * length actually written, so callers can assert on the artefact they created.
 */
export async function writeFinancialReportFile(
  rows: FinancialReportRow[],
  filePath: string,
  options: FinancialReportOptions = {}
): Promise<{ path: string; bytes: number; rowCount: number }> {
  if (!isNonEmptyString(filePath)) {
    throw new Error(`${FINANCIAL_REPORT_EXPORTER_ERRORS.INVALID_OPTION}: filePath is required`);
  }

  const report = buildFinancialReport(rows, options);
  await writeFile(filePath, report.csv, "utf8");

  return {
    path: filePath,
    bytes: Buffer.byteLength(report.csv, "utf8"),
    rowCount: report.rowCount,
  };
}

// ---------------------------------------------------------------------------
// Unknown ticker fallback and DB-column formatting (#506, #507)
//
// Writes transaction rows for reporting exports while tolerating unfamiliar
// Stellar token types: unknown asset tickers resolve to a default format
// configuration instead of throwing, so a novel token never blocks a report.
//
// Design follows `conversion_rate_scraper.ts` (ticker registry + typed
// `{ known }` fallback) and the DB-precision vocabulary used by
// `partial-payment-allocator.ts`.

// ---------------------------------------------------------------------------

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
