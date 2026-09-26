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
import { digitCount, MAX_SAFE_DIGITS, parseIntegerInput } from "./digit-limit-validator.js";

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

// ---------------------------------------------------------------------------
// Parameter warning codes and error-structure validation (#512)
//
// Response body shapes must match the registered error definition lists
// (parameter names, types, and order).
// ---------------------------------------------------------------------------

export const ERROR_CODES = {
  MISSING_PARAMETER: "FINANCIAL_REPORT_MISSING_PARAMETER",
  EXTRA_PARAMETER: "FINANCIAL_REPORT_EXTRA_PARAMETER",
  INVALID_PARAMETER_TYPE: "FINANCIAL_REPORT_INVALID_PARAMETER_TYPE",
  INVALID_PARAMETER_ORDER: "FINANCIAL_REPORT_INVALID_PARAMETER_ORDER",
  UNKNOWN_ERROR_DEFINITION: "FINANCIAL_REPORT_UNKNOWN_ERROR_DEFINITION",
  CALCULATION_EXCEPTION: "FINANCIAL_REPORT_CALCULATION_EXCEPTION",
  PARAM_STRUCTURE_MISMATCH: "FINANCIAL_REPORT_PARAM_STRUCTURE_MISMATCH",
  INVALID_AMOUNT: "FINANCIAL_REPORT_INVALID_AMOUNT",
  INVALID_ROW: "FINANCIAL_REPORT_INVALID_ROW",
  EMPTY_DATA: "FINANCIAL_REPORT_EMPTY_DATA",
  SERIALIZATION_ERROR: "FINANCIAL_REPORT_SERIALIZATION_ERROR",
  SUM_MISMATCH: "FINANCIAL_REPORT_SUM_MISMATCH",
} as const;

export type FinancialReportWarningCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ParameterDefinition {
  name: string;
  type: "string" | "number" | "bigint" | "boolean" | "object" | "array";
  required?: boolean;
}

export interface ErrorDefinition {
  code: string;
  message?: string;
  parameters: ParameterDefinition[];
  ordered?: boolean;
}

export interface ParameterValidationSuccess {
  ok: true;
  code?: string;
  validatedParams: Record<string, unknown>;
}

export interface ParameterValidationFailure {
  ok: false;
  error: string;
  code: FinancialReportWarningCode;
  details?: {
    expectedDefinition?: ErrorDefinition;
    providedParams?: unknown;
    missingParams?: string[];
    extraParams?: string[];
    typeMismatches?: Array<{ param: string; expected: string; actual: string }>;
    orderMismatches?: Array<{ expected: string; actual: string; index: number }>;
    context?: unknown;
    reason?: string;
  };
}

export type ParameterValidationResult =
  | ParameterValidationSuccess
  | ParameterValidationFailure;

/** Built-in error definitions used by the exporter for calculation warnings. */
export const FINANCIAL_REPORT_ERROR_DEFINITIONS: ErrorDefinition[] = [
  {
    code: ERROR_CODES.CALCULATION_EXCEPTION,
    message: "Calculation exception while aggregating transaction logs",
    parameters: [
      { name: "operation", type: "string", required: true },
      { name: "reason", type: "string", required: true },
      { name: "rowIndex", type: "number", required: false },
    ],
    ordered: true,
  },
  {
    code: ERROR_CODES.SUM_MISMATCH,
    message: "Spreadsheet totals do not match expected sum",
    parameters: [
      { name: "expected", type: "string", required: true },
      { name: "actual", type: "string", required: true },
      { name: "column", type: "string", required: true },
    ],
    ordered: true,
  },
  {
    code: ERROR_CODES.INVALID_AMOUNT,
    message: "Transaction amount is not a valid integer string",
    parameters: [
      { name: "field", type: "string", required: true },
      { name: "value", type: "string", required: true },
    ],
  },
  {
    code: ERROR_CODES.INVALID_ROW,
    message: "Transaction log row failed validation",
    parameters: [
      { name: "rowIndex", type: "number", required: true },
      { name: "reason", type: "string", required: true },
    ],
  },
];

export interface TransactionLogRow {
  transactionId: string;
  contractId: string;
  amount: string | number | bigint;
  currency?: string;
  eventType?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface CalculationContext {
  operation?: string;
  amounts?: unknown[];
  expectedTotal?: unknown;
  [key: string]: unknown;
}

export type ExportOutcome =
  | { ok: true; csv: string; rowCount: number; totalAmount: bigint }
  | ParameterValidationFailure;

function checkType(
  value: unknown,
  expectedType: ParameterDefinition["type"]
): boolean {
  if (expectedType === "array") return Array.isArray(value);
  if (expectedType === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  if (expectedType === "bigint") return typeof value === "bigint";
  return typeof value === expectedType;
}

function getActualType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function buildDefinitionMap(
  definitions: ErrorDefinition[] | Record<string, ErrorDefinition> | ErrorDefinition
): Map<string, ErrorDefinition> {
  const defMap = new Map<string, ErrorDefinition>();
  if (Array.isArray(definitions)) {
    for (const def of definitions) {
      defMap.set(def.code, def);
    }
  } else if ("code" in definitions && "parameters" in definitions) {
    const singleDef = definitions as ErrorDefinition;
    defMap.set(singleDef.code, singleDef);
  } else {
    for (const [key, value] of Object.entries(
      definitions as Record<string, ErrorDefinition>
    )) {
      defMap.set(key, value);
    }
  }
  return defMap;
}

/**
 * Validate a response body (or error payload) against error definition lists.
 * Asserts parameter names, types, and optional ordering match the definitions.
 */
export function validateErrorStructure(
  responseBody: unknown,
  definitions:
    | ErrorDefinition[]
    | Record<string, ErrorDefinition>
    | ErrorDefinition = FINANCIAL_REPORT_ERROR_DEFINITIONS,
  explicitCode?: string
): ParameterValidationResult {
  if (responseBody === null || typeof responseBody !== "object") {
    return {
      ok: false,
      error: "Response body must be a non-null object",
      code: ERROR_CODES.PARAM_STRUCTURE_MISMATCH,
      details: { providedParams: responseBody },
    };
  }

  const defMap = buildDefinitionMap(definitions);
  const bodyObj = responseBody as Record<string, unknown>;
  const responseCode =
    explicitCode ||
    (typeof bodyObj.code === "string"
      ? bodyObj.code
      : typeof bodyObj.errorCode === "string"
        ? bodyObj.errorCode
        : typeof bodyObj.error === "string" && defMap.has(bodyObj.error as string)
          ? (bodyObj.error as string)
          : undefined);

  if (!responseCode || !defMap.has(responseCode)) {
    if (defMap.size === 1 && !responseCode && !bodyObj.code && !bodyObj.errorCode) {
      // fall through using the sole definition
    } else {
      return {
        ok: false,
        error: `Unknown or missing error definition code: '${responseCode ?? "undefined"}'`,
        code: ERROR_CODES.UNKNOWN_ERROR_DEFINITION,
        details: { providedParams: responseBody },
      };
    }
  }

  const targetCode = responseCode || Array.from(defMap.keys())[0];
  const expectedDef = defMap.get(targetCode)!;

  let rawParams: unknown =
    bodyObj.parameters ?? bodyObj.params ?? bodyObj.args ?? bodyObj.data;
  if (rawParams === undefined) {
    const {
      code: _code,
      errorCode: _errorCode,
      error: _error,
      message: _message,
      details: _details,
      ...rest
    } = bodyObj;
    rawParams = rest;
  }

  if (typeof rawParams !== "object" || rawParams === null) {
    return {
      ok: false,
      error: `Parameters for error '${targetCode}' must be an object or array`,
      code: ERROR_CODES.PARAM_STRUCTURE_MISMATCH,
      details: { expectedDefinition: expectedDef, providedParams: rawParams },
    };
  }

  const expectedParams = expectedDef.parameters;
  const expectedNames = expectedParams.map((p) => p.name);
  const expectedParamMap = new Map<string, ParameterDefinition>();
  for (const p of expectedParams) {
    expectedParamMap.set(p.name, p);
  }

  if (Array.isArray(rawParams)) {
    const paramArray = rawParams as unknown[];
    const requiredCount = expectedParams.filter((p) => p.required !== false).length;

    if (paramArray.length < requiredCount) {
      const missingNames = expectedNames
        .slice(paramArray.length)
        .filter((_, idx) => expectedParams[paramArray.length + idx]?.required !== false);
      return {
        ok: false,
        error: `Missing required ordered parameters for error '${targetCode}': ${missingNames.join(", ")}`,
        code: ERROR_CODES.MISSING_PARAMETER,
        details: {
          expectedDefinition: expectedDef,
          providedParams: rawParams,
          missingParams: missingNames,
        },
      };
    }

    if (paramArray.length > expectedParams.length) {
      return {
        ok: false,
        error: `Received ${paramArray.length} parameters, expected max ${expectedParams.length} for error '${targetCode}'`,
        code: ERROR_CODES.EXTRA_PARAMETER,
        details: { expectedDefinition: expectedDef, providedParams: rawParams },
      };
    }

    const hasNameProps =
      paramArray.length > 0 &&
      paramArray.every(
        (item) => typeof item === "object" && item !== null && "name" in item
      );

    if (expectedDef.ordered && hasNameProps) {
      const actualNames = (
        paramArray as Array<{ name: string; value?: unknown }>
      ).map((item) => item.name);
      for (let i = 0; i < actualNames.length; i++) {
        if (actualNames[i] !== expectedNames[i]) {
          return {
            ok: false,
            error: `Parameter order mismatch for error '${targetCode}': expected order [${expectedNames.join(
              ", "
            )}], received [${actualNames.join(", ")}]`,
            code: ERROR_CODES.INVALID_PARAMETER_ORDER,
            details: {
              expectedDefinition: expectedDef,
              providedParams: rawParams,
              orderMismatches: [
                {
                  expected: expectedNames[i],
                  actual: actualNames[i],
                  index: i,
                },
              ],
            },
          };
        }
      }
    }

    const validatedParams: Record<string, unknown> = {};
    const typeMismatches: Array<{
      param: string;
      expected: string;
      actual: string;
    }> = [];

    for (let i = 0; i < paramArray.length; i++) {
      const expectedP = expectedParams[i];
      const rawVal = paramArray[i];
      const actualVal =
        typeof rawVal === "object" && rawVal !== null && "value" in rawVal
          ? (rawVal as { value: unknown }).value
          : rawVal;

      if (!checkType(actualVal, expectedP.type)) {
        typeMismatches.push({
          param: expectedP.name,
          expected: expectedP.type,
          actual: getActualType(actualVal),
        });
      }
      validatedParams[expectedP.name] = actualVal;
    }

    if (typeMismatches.length > 0) {
      return {
        ok: false,
        error: `Parameter type mismatch in ordered parameters for '${targetCode}': ${typeMismatches
          .map((m) => `${m.param} (expected ${m.expected}, got ${m.actual})`)
          .join("; ")}`,
        code: ERROR_CODES.INVALID_PARAMETER_TYPE,
        details: {
          expectedDefinition: expectedDef,
          providedParams: rawParams,
          typeMismatches,
        },
      };
    }

    return { ok: true, code: targetCode, validatedParams };
  }

  const paramObj = rawParams as Record<string, unknown>;
  const missingParams: string[] = [];
  const extraParams: string[] = [];
  const typeMismatches: Array<{
    param: string;
    expected: string;
    actual: string;
  }> = [];
  const validatedParams: Record<string, unknown> = {};

  for (const p of expectedParams) {
    if (!(p.name in paramObj) && p.required !== false) {
      missingParams.push(p.name);
    }
  }

  if (missingParams.length > 0) {
    return {
      ok: false,
      error: `Missing required parameter(s) for error '${targetCode}': ${missingParams.join(", ")}`,
      code: ERROR_CODES.MISSING_PARAMETER,
      details: {
        expectedDefinition: expectedDef,
        providedParams: paramObj,
        missingParams,
      },
    };
  }

  for (const key of Object.keys(paramObj)) {
    if (!expectedParamMap.has(key)) {
      extraParams.push(key);
    }
  }

  if (extraParams.length > 0) {
    return {
      ok: false,
      error: `Unexpected extra parameter(s) for error '${targetCode}': ${extraParams.join(", ")}`,
      code: ERROR_CODES.EXTRA_PARAMETER,
      details: {
        expectedDefinition: expectedDef,
        providedParams: paramObj,
        extraParams,
      },
    };
  }

  if (expectedDef.ordered) {
    const actualKeys = Object.keys(paramObj);
    for (let i = 0; i < actualKeys.length; i++) {
      if (actualKeys[i] !== expectedNames[i]) {
        return {
          ok: false,
          error: `Parameter order mismatch for error '${targetCode}': expected key order [${expectedNames.join(
            ", "
          )}], received key order [${actualKeys.join(", ")}]`,
          code: ERROR_CODES.INVALID_PARAMETER_ORDER,
          details: {
            expectedDefinition: expectedDef,
            providedParams: paramObj,
            orderMismatches: [
              {
                expected: expectedNames[i],
                actual: actualKeys[i],
                index: i,
              },
            ],
          },
        };
      }
    }
  }

  for (const p of expectedParams) {
    if (!(p.name in paramObj)) continue;
    const val = paramObj[p.name];
    if (!checkType(val, p.type)) {
      typeMismatches.push({
        param: p.name,
        expected: p.type,
        actual: getActualType(val),
      });
    }
    validatedParams[p.name] = val;
  }

  if (typeMismatches.length > 0) {
    return {
      ok: false,
      error: `Parameter type mismatch for error '${targetCode}': ${typeMismatches
        .map((m) => `${m.param} (expected ${m.expected}, got ${m.actual})`)
        .join("; ")}`,
      code: ERROR_CODES.INVALID_PARAMETER_TYPE,
      details: {
        expectedDefinition: expectedDef,
        providedParams: paramObj,
        typeMismatches,
      },
    };
  }

  return { ok: true, code: targetCode, validatedParams };
}

/**
 * Build a typed warning payload for a calculation exception so callers can
 * assert the body shape against FINANCIAL_REPORT_ERROR_DEFINITIONS.
 */
export function reportCalculationException(
  operation: string,
  reason: string,
  rowIndex?: number
): ParameterValidationFailure {
  const parameters: Record<string, unknown> = { operation, reason };
  if (rowIndex !== undefined) {
    parameters.rowIndex = rowIndex;
  }

  return {
    ok: false,
    error: `Calculation exception during '${operation}': ${reason}`,
    code: ERROR_CODES.CALCULATION_EXCEPTION,
    details: {
      expectedDefinition: FINANCIAL_REPORT_ERROR_DEFINITIONS.find(
        (d) => d.code === ERROR_CODES.CALCULATION_EXCEPTION
      ),
      providedParams: parameters,
      reason,
      context: { operation, rowIndex },
    },
  };
}

function parseAmount(value: unknown, label: string): ParameterValidationResult & { value?: bigint } {
  if (typeof value === "bigint") {
    return { ok: true, validatedParams: { [label]: value }, value };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      return reportCalculationException("parseAmount", `${label} must be a finite integer`);
    }
    return { ok: true, validatedParams: { [label]: value }, value: BigInt(value) };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      return reportCalculationException(
        "parseAmount",
        `${label} must be an integer numeric value`
      );
    }
    return { ok: true, validatedParams: { [label]: trimmed }, value: BigInt(trimmed) };
  }
  return reportCalculationException(
    "parseAmount",
    `${label} has unsupported type ${getActualType(value)}`
  );
}

/**
 * Validate calculation context before aggregating transaction totals.
 */
export function validateCalculationParameters(
  context: CalculationContext
): ParameterValidationResult {
  if (context === null || typeof context !== "object") {
    return {
      ok: false,
      error: "Calculation context must be a valid non-null object",
      code: ERROR_CODES.PARAM_STRUCTURE_MISMATCH,
      details: { context },
    };
  }

  if (context.amounts !== undefined) {
    if (!Array.isArray(context.amounts)) {
      return reportCalculationException(
        context.operation ?? "validateCalculationParameters",
        "amounts must be an array"
      );
    }
    for (let i = 0; i < context.amounts.length; i++) {
      const parsed = parseAmount(context.amounts[i], `amounts[${i}]`);
      if (!parsed.ok) {
        return {
          ...parsed,
          details: {
            ...parsed.details,
            context,
          },
        };
      }
    }
  }

  if (context.expectedTotal !== undefined) {
    const parsed = parseAmount(context.expectedTotal, "expectedTotal");
    if (!parsed.ok) {
      return {
        ...parsed,
        details: {
          ...parsed.details,
          context,
        },
      };
    }
  }

  return {
    ok: true,
    validatedParams: context as Record<string, unknown>,
  };
}

function escapeCsvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

/**
 * Export transaction log rows to a CSV spreadsheet block, summing amounts and
 * reporting calculation exceptions via detailed parameter warning codes.
 */
export function exportTransactionLogs(
  rows: TransactionLogRow[],
  options?: { expectedTotal?: string | number | bigint }
): ExportOutcome {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      ok: false,
      error: "Transaction log rows must be a non-empty array",
      code: ERROR_CODES.EMPTY_DATA,
    };
  }

  const calcCheck = validateCalculationParameters({
    operation: "exportTransactionLogs",
    amounts: rows.map((r) => r.amount),
    expectedTotal: options?.expectedTotal,
  });
  if (!calcCheck.ok) {
    return calcCheck;
  }

  let total = 0n;
  const lines: string[] = [
    "transaction_id,contract_id,amount,currency,event_type,timestamp",
  ];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== "object") {
      return {
        ok: false,
        error: `Invalid transaction row at index ${i}`,
        code: ERROR_CODES.INVALID_ROW,
        details: { reason: "row is not an object", context: { rowIndex: i } },
      };
    }
    if (typeof row.transactionId !== "string" || typeof row.contractId !== "string") {
      return {
        ok: false,
        error: `Invalid transaction row at index ${i}: missing transactionId or contractId`,
        code: ERROR_CODES.INVALID_ROW,
        details: {
          reason: "missing required string fields",
          context: { rowIndex: i },
        },
      };
    }

    const parsed = parseAmount(row.amount, `rows[${i}].amount`);
    if (!parsed.ok || parsed.value === undefined) {
      return {
        ...parsed,
        details: {
          ...(parsed.ok ? {} : parsed.details),
          context: { rowIndex: i, row },
        },
      } as ParameterValidationFailure;
    }

    total += parsed.value;
    lines.push(
      [
        escapeCsvCell(row.transactionId),
        escapeCsvCell(row.contractId),
        escapeCsvCell(parsed.value.toString()),
        escapeCsvCell(row.currency ?? ""),
        escapeCsvCell(row.eventType ?? ""),
        escapeCsvCell(row.timestamp ?? ""),
      ].join(",")
    );
  }

  if (options?.expectedTotal !== undefined) {
    const expected = parseAmount(options.expectedTotal, "expectedTotal");
    if (!expected.ok || expected.value === undefined) {
      return expected as ParameterValidationFailure;
    }
    if (expected.value !== total) {
      const mismatchBody = {
        code: ERROR_CODES.SUM_MISMATCH,
        parameters: {
          expected: expected.value.toString(),
          actual: total.toString(),
          column: "amount",
        },
      };
      const structure = validateErrorStructure(mismatchBody);
      if (!structure.ok) {
        return structure;
      }
      return {
        ok: false,
        error: `Spreadsheet totals mismatch: expected ${expected.value}, got ${total}`,
        code: ERROR_CODES.SUM_MISMATCH,
        details: {
          expectedDefinition: FINANCIAL_REPORT_ERROR_DEFINITIONS.find(
            (d) => d.code === ERROR_CODES.SUM_MISMATCH
          ),
          providedParams: mismatchBody.parameters,
        },
      };
    }
  }

  return {
    ok: true,
    csv: lines.join("\n") + "\n",
    rowCount: rows.length,
    totalAmount: total,
  };
}

/**
 * Convenience helper: shape a warning response body and validate it against
 * the exporter's error definition list.
 */
export function buildAndValidateWarningBody(
  code: FinancialReportWarningCode,
  parameters: Record<string, unknown>
): ParameterValidationResult {
  const body = { code, parameters };
  return validateErrorStructure(body, FINANCIAL_REPORT_ERROR_DEFINITIONS);
}

// ---------------------------------------------------------------------------
// Negative parameter rejection and spreadsheet/CSV generation (#496, #497, #505)
// ---------------------------------------------------------------------------

export { MAX_SAFE_DIGITS };

export enum FinancialReportExporterError {
  NEGATIVE_PARAMETER = "NEGATIVE_PARAMETER",
  INVALID_PARAMETER = "INVALID_PARAMETER",
  OVERFLOW_EXCESSIVE_DIGITS = "OVERFLOW_EXCESSIVE_DIGITS",
  EMPTY_DATA = "EMPTY_DATA",
  INVALID_ROW = "INVALID_ROW",
}

export const EXPORTER_PARAM_ERROR_CODES = {
  NEGATIVE_PARAMETER: "NEGATIVE_PARAMETER",
  INVALID_PARAMETER: "INVALID_PARAMETER",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  EXCESSIVE_DIGITS: "OVERFLOW_EXCESSIVE_DIGITS",
  OVERFLOW_EXCESSIVE_DIGITS: "OVERFLOW_EXCESSIVE_DIGITS",
  EMPTY_DATA: "EMPTY_DATA",
  INVALID_ROW: "INVALID_ROW",
} as const;

export type FinancialReportParamErrorCode =
  | (typeof EXPORTER_PARAM_ERROR_CODES)[keyof typeof EXPORTER_PARAM_ERROR_CODES]
  | FinancialReportExporterError;

export class FinancialReportExporterErrorException extends Error {
  public readonly code: FinancialReportParamErrorCode;

  constructor(code: FinancialReportParamErrorCode, message: string) {
    super(message);
    this.name = "FinancialReportExporterErrorException";
    this.code = code;
  }
}

export type ValidationResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: FinancialReportParamErrorCode };

export interface FinancialReportEntry {
  id?: string | number;
  label?: string;
  category?: string;
  amount: number | string | bigint;
  currency?: string;
  timestamp?: number;
}

export interface FinancialReportExporterParams {
  amount: number | string | bigint;
  currency?: string;
  entries?: FinancialReportEntry[];
}

/**
 * Validate a non-negative numeric amount parameter.
 * Rejects negative amounts with error code NEGATIVE_PARAMETER / INVALID_AMOUNT.
 */
export function validateFinancialAmount(
  value: number | string | bigint,
  name = "amount"
): ValidationResult {
  if (typeof value === "bigint") {
    if (value < 0n) {
      return {
        ok: false,
        error: `Parameter "${name}" must not be negative`,
        code: EXPORTER_PARAM_ERROR_CODES.NEGATIVE_PARAMETER,
      };
    }
    const raw = value.toString();
    if (digitCount(raw) > MAX_SAFE_DIGITS) {
      return {
        ok: false,
        error: `Parameter "${name}" exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
        code: EXPORTER_PARAM_ERROR_CODES.EXCESSIVE_DIGITS,
      };
    }
    return { ok: true, value };
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || Number.isNaN(value)) {
      return {
        ok: false,
        error: `Parameter "${name}" must be a valid finite number`,
        code: EXPORTER_PARAM_ERROR_CODES.INVALID_PARAMETER,
      };
    }
    if (value < 0 || Object.is(value, -0)) {
      return {
        ok: false,
        error: `Parameter "${name}" must not be negative`,
        code: EXPORTER_PARAM_ERROR_CODES.NEGATIVE_PARAMETER,
      };
    }
    if (!Number.isInteger(value)) {
      // Human decimal representation: check digit count
      const raw = String(value).replace(".", "");
      if (digitCount(raw) > MAX_SAFE_DIGITS) {
        return {
          ok: false,
          error: `Parameter "${name}" exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
          code: EXPORTER_PARAM_ERROR_CODES.EXCESSIVE_DIGITS,
        };
      }
      return { ok: true, value: BigInt(Math.round(value)) };
    }
    const raw = String(value);
    if (digitCount(raw) > MAX_SAFE_DIGITS) {
      return {
        ok: false,
        error: `Parameter "${name}" exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
        code: EXPORTER_PARAM_ERROR_CODES.EXCESSIVE_DIGITS,
      };
    }
    return { ok: true, value: BigInt(value) };
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("-")) {
      return {
        ok: false,
        error: `Parameter "${name}" must not be negative`,
        code: EXPORTER_PARAM_ERROR_CODES.NEGATIVE_PARAMETER,
      };
    }
    return parseIntegerInput(
      trimmed,
      name,
      EXPORTER_PARAM_ERROR_CODES.INVALID_PARAMETER,
      EXPORTER_PARAM_ERROR_CODES.EXCESSIVE_DIGITS
    );
  }

  return {
    ok: false,
    error: `Parameter "${name}" must be a string, number, or bigint`,
    code: EXPORTER_PARAM_ERROR_CODES.INVALID_PARAMETER,
  };
}

/**
 * Validate input parameters for financial report exporter.
 * Throws FinancialReportExporterErrorException when parameters are invalid or negative.
 */
export function validateFinancialReportExporterParams(
  params: FinancialReportExporterParams
): void {
  if (!params || typeof params !== "object") {
    throw new FinancialReportExporterErrorException(
      EXPORTER_PARAM_ERROR_CODES.INVALID_PARAMETER,
      "Parameters object is required"
    );
  }

  const check = validateFinancialAmount(params.amount, "amount");
  if (!check.ok) {
    throw new FinancialReportExporterErrorException(check.code, check.error);
  }

  if (params.entries) {
    if (!Array.isArray(params.entries)) {
      throw new FinancialReportExporterErrorException(
        EXPORTER_PARAM_ERROR_CODES.INVALID_PARAMETER,
        'Parameter "entries" must be an array'
      );
    }
    for (let i = 0; i < params.entries.length; i++) {
      const entry = params.entries[i];
      if (!entry || typeof entry !== "object") {
        throw new FinancialReportExporterErrorException(
          EXPORTER_PARAM_ERROR_CODES.INVALID_ROW,
          `Entry at index ${i} must be an object`
        );
      }
      const entryCheck = validateFinancialAmount(
        entry.amount,
        `entries[${i}].amount`
      );
      if (!entryCheck.ok) {
        throw new FinancialReportExporterErrorException(
          entryCheck.code,
          entryCheck.error
        );
      }
    }
  }
}

/**
 * Main financial report exporter function.
 * Validates inputs, rejects negative parameters, and generates report output.
 */
export async function financial_report_exporter(
  params: FinancialReportExporterParams
): Promise<{ ok: true; data: string; rowCount: number }> {
  validateFinancialReportExporterParams(params);

  const lines = ["category,amount,currency"];
  let rowCount = 0;

  if (params.entries && params.entries.length > 0) {
    for (const entry of params.entries) {
      lines.push(
        `${entry.category ?? "general"},${entry.amount},${entry.currency ?? params.currency ?? "XLM"}`
      );
      rowCount += 1;
    }
  } else {
    lines.push(`total,${params.amount},${params.currency ?? "XLM"}`);
    rowCount = 1;
  }

  return {
    ok: true,
    data: lines.join("\n") + "\n",
    rowCount,
  };
}

/**
 * Synchronous exporter alias.
 */
export function exportFinancialReport(
  params: FinancialReportExporterParams
): { ok: true; data: string; rowCount: number } | { ok: false; error: string; code: FinancialReportParamErrorCode } {
  const check = validateFinancialAmount(params.amount, "amount");
  if (!check.ok) {
    return check;
  }

  if (params.entries) {
    for (let i = 0; i < params.entries.length; i++) {
      const entryCheck = validateFinancialAmount(
        params.entries[i].amount,
        `entries[${i}].amount`
      );
      if (!entryCheck.ok) {
        return entryCheck;
      }
    }
  }

  const lines = ["category,amount,currency"];
  let rowCount = 0;

  if (params.entries && params.entries.length > 0) {
    for (const entry of params.entries) {
      lines.push(
        `${entry.category ?? "general"},${entry.amount},${entry.currency ?? params.currency ?? "XLM"}`
      );
      rowCount += 1;
    }
  } else {
    lines.push(`total,${params.amount},${params.currency ?? "XLM"}`);
    rowCount = 1;
  }

  return {
    ok: true,
    data: lines.join("\n") + "\n",
    rowCount,
  };
}
