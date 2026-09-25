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
