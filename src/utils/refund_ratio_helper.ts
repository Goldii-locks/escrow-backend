/**
 * Dispute refund percentage splitter with overflow and parameter validation.
 * Ratios are basis points from 0 to 10,000 and fractional results use half-even rounding.
 * Also resolves asset ticker configs, formats refund rows for DB storage, and
 * exports those rows as CSV.
 */

import { formatRowToCsv, writeCsvFile } from "./csv-serializer.js";
import { formatRefundValueForDb, parseRefundDbValue } from "./db-precision.js";
import {
  parseIntegerInput,
  MAX_SAFE_DIGITS,
  isAmountWithinRange,
} from "./digit-limit-validator.js";

export { MAX_SAFE_DIGITS };

export const MAX_INTERMEDIATE_DIGITS = MAX_SAFE_DIGITS * 2;
export const DEFAULT_REFUND_SCALE = 10_000;

export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "OVERFLOW_EXCESSIVE_DIGITS",
  AMOUNT_OUT_OF_RANGE: "AMOUNT_OUT_OF_RANGE",
  INVALID_RATIO: "OVERFLOW_INVALID_RATIO",
  INVALID_AMOUNT: "OVERFLOW_INVALID_AMOUNT",
  PRODUCT_OVERFLOW: "OVERFLOW_PRODUCT_EXCEEDED",
  MISSING_PARAMETER: "MISSING_PARAMETER",
  INVALID_PARAMETER_TYPE: "INVALID_PARAMETER_TYPE",
  CALCULATION_EXCEPTION: "CALCULATION_EXCEPTION",
  PARAM_STRUCTURE_MISMATCH: "PARAM_STRUCTURE_MISMATCH",
} as const;

export type OverflowErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ValidationResult =
  | { ok: true; value: bigint }
  | {
      ok: false;
      error: string;
      code: OverflowErrorCode;
      parameters: { parameter: string; reason: string };
      details?: { context: unknown; reason: string };
    };

export type ValidationFailure = Extract<ValidationResult, { ok: false }>;

export const ERROR_DEFINITIONS = Object.values(ERROR_CODES).map((code) => ({
  code,
  parameters: [
    { name: "parameter", type: "string" as const, required: true },
    { name: "reason", type: "string" as const, required: true },
  ],
}));

function failure(
  error: string,
  code: OverflowErrorCode,
  parameter: string,
  details?: { context: unknown; reason: string }
): ValidationFailure {
  return {
    ok: false,
    error,
    code,
    parameters: { parameter, reason: error },
    ...(details ? { details } : {}),
  };
}

function calculationFailure(
  operation: string,
  context: unknown,
  cause: unknown
): ValidationFailure {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return failure(
    `Calculation exception during ${operation}: ${reason}`,
    ERROR_CODES.CALCULATION_EXCEPTION,
    operation,
    { context, reason }
  );
}

/**
 * Validate a refund ratio (integer basis points / scaled percent) against digit limits.
 */
export function validateRefundRatio(
  ratio: unknown
): ValidationResult {
  const parsed = parseIntegerInput(
    ratio,
    "ratio",
    ERROR_CODES.INVALID_RATIO,
    ERROR_CODES.AMOUNT_OUT_OF_RANGE,
    {
      nonNegative: true,
      missingCode: ERROR_CODES.MISSING_PARAMETER,
      invalidTypeCode: ERROR_CODES.INVALID_PARAMETER_TYPE,
    }
  );
  if (!parsed.ok) {
    return failure(parsed.error, parsed.code, "ratio");
  }
  if (parsed.value > BigInt(DEFAULT_REFUND_SCALE)) {
    const error = `ratio must be between 0 and ${DEFAULT_REFUND_SCALE}`;
    return failure(error, ERROR_CODES.INVALID_RATIO, "ratio");
  }
  return parsed;
}

/** Validate a non-negative refund amount against the shared digit limit. */
export function validateRefundAmount(amount: unknown): ValidationResult {
  const parsed = parseIntegerInput(
    amount,
    "amount",
    ERROR_CODES.INVALID_AMOUNT,
    ERROR_CODES.AMOUNT_OUT_OF_RANGE,
    {
      nonNegative: true,
      missingCode: ERROR_CODES.MISSING_PARAMETER,
      invalidTypeCode: ERROR_CODES.INVALID_PARAMETER_TYPE,
    }
  );
  return parsed.ok ? parsed : failure(parsed.error, parsed.code, "amount");
}

/**
 * Split a dispute amount by basis-point ratio, rounding the result half-even.
 * The ratio is scaled by 10,000, so 2,500 represents a 25% refund.
 */
export function applyRefundRatio(
  amount: unknown,
  ratio: unknown
): ValidationResult {
  const principal = validateRefundAmount(amount);
  if (!principal.ok) {
    return principal;
  }

  const factor = validateRefundRatio(ratio);
  if (!factor.ok) {
    return factor;
  }

  try {
    const numerator = principal.value * factor.value;

    const scale = BigInt(DEFAULT_REFUND_SCALE);
    const quotient = numerator / scale;
    const remainder = numerator % scale;
    const twiceRemainder = remainder * 2n;
    const refund =
      twiceRemainder > scale ||
      (twiceRemainder === scale && quotient % 2n !== 0n)
        ? quotient + 1n
        : quotient;

    if (!isAmountWithinRange(refund)) {
      return failure(
        "refund share exceeds the i128 amount range",
        ERROR_CODES.PRODUCT_OVERFLOW,
        "refund"
      );
    }

    return { ok: true, value: refund };
  } catch (error) {
    return calculationFailure("applyRefundRatio", { amount, ratio }, error);
  }
}

// ---------------------------------------------------------------------------
// Unknown asset ticker fallbacks (#469)
// ---------------------------------------------------------------------------

export interface RefundAssetConfig {
  /** Asset code as stored alongside refund rows (e.g. "XLM", "USDC"). */
  ticker: string;
  /** Fractional digits used when rendering raw stroop amounts. */
  decimals: number;
  /** Human-readable asset name. */
  label: string;
}

export const KNOWN_REFUND_ASSETS: Readonly<Record<string, RefundAssetConfig>> =
  Object.freeze({
    XLM: { ticker: "XLM", decimals: 7, label: "Stellar Lumens" },
    USDC: { ticker: "USDC", decimals: 7, label: "USD Coin (Stellar)" },
    EURC: { ticker: "EURC", decimals: 7, label: "Euro Coin (Stellar)" },
    USDT: { ticker: "USDT", decimals: 7, label: "Tether (Stellar)" },
  });

/** Default format configuration applied to missing or unfamiliar tickers. */
export const DEFAULT_REFUND_ASSET_CONFIG: Readonly<RefundAssetConfig> =
  Object.freeze({
    ticker: "UNKNOWN",
    decimals: 7,
    label: "Unknown Stellar Token",
  });

/** Stellar asset codes are 1-12 alphanumeric characters. */
const STELLAR_ASSET_CODE = /^[A-Za-z0-9]{1,12}$/;

export type RefundTickerResolution =
  | { known: true; fallback: false; ticker: string; config: RefundAssetConfig }
  | { known: false; fallback: true; ticker: string; config: RefundAssetConfig };

/**
 * Resolve a ticker key to its asset configuration. Missing, malformed, or
 * unregistered tickers fall back to DEFAULT_REFUND_ASSET_CONFIG; a well-formed
 * unknown code keeps its own (upper-cased) name so rows stay attributable.
 */
export function resolveRefundAssetTicker(
  rawTicker?: unknown
): RefundTickerResolution {
  const trimmed = typeof rawTicker === "string" ? rawTicker.trim() : "";
  if (!STELLAR_ASSET_CODE.test(trimmed)) {
    return {
      known: false,
      fallback: true,
      ticker: DEFAULT_REFUND_ASSET_CONFIG.ticker,
      config: { ...DEFAULT_REFUND_ASSET_CONFIG },
    };
  }

  const ticker = trimmed.toUpperCase();
  const config = Object.prototype.hasOwnProperty.call(KNOWN_REFUND_ASSETS, ticker)
    ? KNOWN_REFUND_ASSETS[ticker]
    : undefined;
  if (config) {
    return { known: true, fallback: false, ticker, config: { ...config } };
  }

  return {
    known: false,
    fallback: true,
    ticker,
    config: { ...DEFAULT_REFUND_ASSET_CONFIG, ticker },
  };
}

/** Format configuration for a ticker, with defaults applied to unknown keys. */
export function getRefundAssetFormatConfig(
  ticker?: unknown
): { ticker: string; decimals: number } {
  const { config } = resolveRefundAssetTicker(ticker);
  return { ticker: config.ticker, decimals: config.decimals };
}

// ---------------------------------------------------------------------------
// DB-column precision formatting (#470)
// ---------------------------------------------------------------------------

export type RefundDbColumnFormat = "BIGINT" | "TEXT";

export interface RefundDbColumnSchema {
  field: string;
  format: RefundDbColumnFormat;
  maxDigits?: number;
  nullable: boolean;
}

export interface FormattedRefundRow {
  asset_ticker: string;
  decimals: number;
  ratio_bps: number;
  /** Disputed amount rendered with exactly `decimals` fractional digits. */
  amount: string;
  refund_amount: string;
  remaining_amount: string;
  /** Exact integer stroop values, kept for lossless reconstruction. */
  amount_raw: string;
  refund_raw: string;
  remaining_raw: string;
  precision_preserved: true;
}

type RefundDbColumn = Exclude<keyof FormattedRefundRow, "precision_preserved">;

function amountColumn(field: RefundDbColumn): RefundDbColumnSchema {
  return { field, format: "TEXT", maxDigits: MAX_SAFE_DIGITS, nullable: false };
}

/**
 * Column schemas for persisted refund rows. Amounts are TEXT so the exact
 * bigint rendering is stored without a float round-trip.
 */
export const REFUND_DB_COLUMN_SCHEMAS: Readonly<
  Record<RefundDbColumn, RefundDbColumnSchema>
> = Object.freeze({
  asset_ticker: { field: "asset_ticker", format: "TEXT", nullable: false },
  decimals: { field: "decimals", format: "BIGINT", nullable: false },
  ratio_bps: { field: "ratio_bps", format: "BIGINT", nullable: false },
  amount: amountColumn("amount"),
  refund_amount: amountColumn("refund_amount"),
  remaining_amount: amountColumn("remaining_amount"),
  amount_raw: amountColumn("amount_raw"),
  refund_raw: amountColumn("refund_raw"),
  remaining_raw: amountColumn("remaining_raw"),
});

export type RefundRowResult =
  | { ok: true; row: FormattedRefundRow }
  | ValidationFailure;

// Fixed-scale refund formatters live in db-precision.ts (#635).
export { formatRefundValueForDb, parseRefundDbValue };

/**
 * Compute a refund split and format every column for DB storage. Each
 * formatted amount is parsed back and compared with its raw value, so a row
 * is only returned when all attributes preserve full precision.
 */
export function formatRefundRowForDb(input: {
  amount: unknown;
  ratio: unknown;
  ticker?: unknown;
}): RefundRowResult {
  const principal = validateRefundAmount(input.amount);
  if (!principal.ok) {
    return principal;
  }
  const ratio = validateRefundRatio(input.ratio);
  if (!ratio.ok) {
    return ratio;
  }
  const refund = applyRefundRatio(principal.value, ratio.value);
  if (!refund.ok) {
    return refund;
  }

  const { ticker, decimals } = getRefundAssetFormatConfig(input.ticker);
  const remaining = principal.value - refund.value;

  try {
    const raws = {
      amount: principal.value,
      refund_amount: refund.value,
      remaining_amount: remaining,
    };
    const formatted = {} as Record<keyof typeof raws, string>;
    for (const field of Object.keys(raws) as (keyof typeof raws)[]) {
      const text = formatRefundValueForDb(raws[field], decimals);
      if (parseRefundDbValue(text, decimals) !== raws[field]) {
        return failure(
          `precision loss detected while formatting ${field} for DB storage`,
          ERROR_CODES.CALCULATION_EXCEPTION,
          field
        );
      }
      formatted[field] = text;
    }

    return {
      ok: true,
      row: {
        asset_ticker: ticker,
        decimals,
        ratio_bps: Number(ratio.value),
        ...formatted,
        amount_raw: principal.value.toString(),
        refund_raw: refund.value.toString(),
        remaining_raw: remaining.toString(),
        precision_preserved: true,
      },
    };
  } catch (error) {
    return calculationFailure("formatRefundRowForDb", input, error);
  }
}

// ---------------------------------------------------------------------------
// CSV format exporters (#472)
// ---------------------------------------------------------------------------

export const REFUND_CSV_HEADERS = [
  "asset_ticker",
  "decimals",
  "ratio_bps",
  "amount",
  "refund_amount",
  "remaining_amount",
  "amount_raw",
  "refund_raw",
  "remaining_raw",
] as const satisfies readonly RefundDbColumn[];

/**
 * Build a CSV block (header + one line per row) from formatted refund rows.
 * Throws when `rows` is empty so an export never writes a header-only table.
 */
export function buildRefundCsvBlock(
  rows: readonly FormattedRefundRow[],
  options: { includeHeaders?: boolean } = {}
): string {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("buildRefundCsvBlock: rows must be a non-empty array");
  }

  const lines: string[] = [];
  if (options.includeHeaders !== false) {
    lines.push(formatRowToCsv([...REFUND_CSV_HEADERS]));
  }
  for (const row of rows) {
    lines.push(formatRowToCsv(REFUND_CSV_HEADERS.map((column) => row[column])));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Serialize refund rows as CSV and write them to `filePath`, creating parent
 * directories as needed. Returns the number of data rows written.
 */
export function writeRefundCsvFile(
  filePath: string,
  rows: readonly FormattedRefundRow[],
  options: { includeHeaders?: boolean } = {}
): number {
  const csv = buildRefundCsvBlock(rows, options);
  writeCsvFile(filePath, csv, "utf8");
  return rows.length;
}
