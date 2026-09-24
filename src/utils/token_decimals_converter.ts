import fs from "fs";
import path from "path";

/**
 * Token decimals converter with overflow / digit-limit validation.
 * Converts between a Soroban token's raw on-chain integer amount and its
 * human-readable decimal amount, rejecting inputs whose digit count or
 * decimals value would risk unsafe numeric overflow when scaling by
 * 10^decimals.
 */

/** Max decimal digits allowed for a single amount (below Number.MAX_SAFE_INTEGER). */
export const MAX_SAFE_DIGITS = 15;

/**
 * Practical upper bound for a token's `decimals` value used by this converter.
 * The SEP-41 token interface technically allows `decimals()` to be any u32
 * (up to 255), but real Soroban/Stellar tokens use values in the 0-18 range.
 * Capping at 18 keeps the 10^decimals scaling factor safe to combine with
 * MAX_SAFE_DIGITS without risking silent precision loss or overflow.
 */
export const MAX_TOKEN_DECIMALS = 18;

export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "DECIMALS_EXCESSIVE_DIGITS",
  INVALID_AMOUNT: "DECIMALS_INVALID_AMOUNT",
  INVALID_DECIMALS: "DECIMALS_INVALID_DECIMALS",
  CONVERSION_OVERFLOW: "DECIMALS_CONVERSION_OVERFLOW",
  RATE_LIMITED: "DECIMALS_RATE_LIMITED",
  SUM_MISMATCH: "DECIMALS_SUM_MISMATCH",
  INVALID_SCHEMA: "DECIMALS_INVALID_SCHEMA",
  EMPTY_DATA: "DECIMALS_EMPTY_DATA",
  INVALID_INPUT: "DECIMALS_INVALID_INPUT",
  INVALID_ROW: "DECIMALS_INVALID_ROW",
  SERIALIZATION_ERROR: "DECIMALS_SERIALIZATION_ERROR",
  FILE_WRITE_ERROR: "DECIMALS_FILE_WRITE_ERROR",
  FILE_READ_ERROR: "DECIMALS_FILE_READ_ERROR",
} as const;

export type DecimalsErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ConversionResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: DecimalsErrorCode };

/** Max conversion calls allowed per rate-limit window before calls are rejected. */
export const RATE_LIMIT_MAX_CALLS = 1000;

/** Rate-limit window size, in milliseconds. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

let rateLimitWindowStart = Date.now();
let rateLimitCallCount = 0;

/**
 * Clear the rolling rate-limit window. The counter is module-global, so a test
 * (or a caller that legitimately needs a fresh window) has no other way to get
 * back to a known state.
 */
export function resetConversionRateLimit(): void {
  rateLimitWindowStart = Date.now();
  rateLimitCallCount = 0;
}

/**
 * Guard against excessive conversion call volume within a rolling window.
 * This module has no HTTP route of its own, so callers get the same 429-style
 * rejection semantics used by the app's request-level rate limiters, scoped
 * to this module's own call volume instead of a client IP.
 */
function checkConversionRateLimit():
  | { ok: true }
  | { ok: false; error: string; code: DecimalsErrorCode } {
  const now = Date.now();
  if (now - rateLimitWindowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitWindowStart = now;
    rateLimitCallCount = 0;
  }

  rateLimitCallCount += 1;

  if (rateLimitCallCount > RATE_LIMIT_MAX_CALLS) {
    return {
      ok: false,
      error: `conversion rate limit exceeded: max ${RATE_LIMIT_MAX_CALLS} calls per ${RATE_LIMIT_WINDOW_MS}ms`,
      code: ERROR_CODES.RATE_LIMITED,
    };
  }

  return { ok: true };
}

/**
 * Configuration options for database precision schema and column mapping.
 */
export interface DbPrecisionSchema {
  /** Column scale (decimal places). Defaults to token decimals if not specified. */
  scale?: number;
  /** Maximum safe precision (total digits). Defaults to MAX_SAFE_DIGITS (15). */
  precision?: number;
  /**
   * Whether to format with fixed decimal scale by padding fractional digits
   * with trailing zeroes to match the column scale (e.g. "1.5000000" for decimals=7).
   * Defaults to true for database precision schemas.
   */
  fixedScale?: boolean;
  /**
   * Whether input is raw units, human units, or auto-detected.
   * Defaults to "auto".
   */
  inputType?: "auto" | "raw" | "human";
  /** Custom column names for database storage mapping. */
  columns?: {
    rawAmount?: string;
    formattedAmount?: string;
    decimals?: string;
  };
}

/**
 * Attributes for a database row storing a token amount with full precision.
 */
export interface DbStorageRow {
  /** Raw on-chain integer amount string (exact integer, no precision loss). */
  raw_amount: string;
  /** Decimal amount string formatted to match database precision schema. */
  formatted_amount: string;
  /** Token decimals (scale). */
  decimals: number;
  /** Alias for raw_amount in camelCase. */
  rawAmount: string;
  /** Alias for formatted_amount in camelCase. */
  formattedAmount: string;
  /** Human-readable string with trimmed trailing zeroes. */
  trimmed_amount: string;
  /** Dynamic custom column mapping if custom column names were configured. */
  [key: string]: string | number;
}

export type DbStorageColumns = DbStorageRow;

export type DbFormatResult =
  | {
      ok: true;
      value: DbStorageRow;
      columns: DbStorageRow;
      row: DbStorageRow;
    }
  | { ok: false; error: string; code: DecimalsErrorCode };

/**
 * Input record representing a token amount conversion entry for serialization / export.
 */
export interface TokenConversionRecord {
  symbol?: string;
  token?: string;
  label?: string;
  rawAmount?: string | number | bigint;
  raw_amount?: string | number | bigint;
  humanAmount?: string | number;
  human_amount?: string | number;
  decimals: number;
  [key: string]: unknown;
}

/**
 * Resolved and validated conversion row used in serialization.
 */
export interface ValidatedConversionRow {
  symbol?: string;
  token?: string;
  label?: string;
  rawAmount: bigint;
  humanAmount: string;
  decimals: number;
  [key: string]: unknown;
}

/**
 * Options configuring CSV table export and file serialization.
 */
export interface CsvExportOptions {
  /** Delimiter character, defaults to ',' */
  delimiter?: string;
  /** Line ending string, defaults to '\n' */
  lineEnding?: string;
  /** Whether to output the header row, defaults to true */
  includeHeader?: boolean;
  /** Column keys to export in order */
  columns?: string[];
  /** Custom header labels matching columns */
  headers?: string[];
  /** Whether to allow empty records array (default true). When false, rejects empty arrays. */
  allowEmpty?: boolean;
  /** File encoding when writing to disk, defaults to 'utf-8' */
  encoding?: BufferEncoding;
}

/**
 * Outcome of CSV formatting.
 */
export type CsvFormattingOutcome =
  | {
      ok: true;
      value: string;
      rowCount: number;
      columns: string[];
    }
  | {
      ok: false;
      error: string;
      code: DecimalsErrorCode;
    };

/**
 * Outcome of file serialization.
 */
export type FileSerializationOutcome =
  | {
      ok: true;
      filePath: string;
      bytesWritten: number;
      rowCount: number;
    }
  | {
      ok: false;
      error: string;
      code: DecimalsErrorCode;
    };

/**
 * Outcome of CSV deserialization / parsing.
 */
export type CsvParseOutcome =
  | {
      ok: true;
      records: ValidatedConversionRow[];
      rowCount: number;
    }
  | {
      ok: false;
      error: string;
      code: DecimalsErrorCode;
    };

function digitCount(normalized: string): number {
  const digits = normalized.replace(/^-/, "").replace(/^0+(?=\d)/, "");
  return digits.length === 0 ? 1 : digits.length;
}

/**
 * Validate a token's `decimals` value against the practical safe range.
 */
export function validateDecimals(
  decimals: number
): { ok: true } | { ok: false; error: string; code: DecimalsErrorCode } {
  if (
    typeof decimals !== "number" ||
    !Number.isFinite(decimals) ||
    !Number.isInteger(decimals)
  ) {
    return {
      ok: false,
      error: "decimals must be a finite integer",
      code: ERROR_CODES.INVALID_DECIMALS,
    };
  }

  if (decimals < 0 || decimals > MAX_TOKEN_DECIMALS) {
    return {
      ok: false,
      error: `decimals must be between 0 and ${MAX_TOKEN_DECIMALS}`,
      code: ERROR_CODES.INVALID_DECIMALS,
    };
  }

  return { ok: true };
}

/**
 * Parse and validate a raw (integer, on-chain) token amount against digit limits.
 * Rejects negative amounts as token balances/transfers cannot be negative.
 */
export function validateRawAmount(
  input: string | number | bigint,
  label = "amount"
): ConversionResult {
  let raw: string;

  if (typeof input === "bigint") {
    if (input < 0n) {
      return {
        ok: false,
        error: `${label} cannot be negative`,
        code: ERROR_CODES.INVALID_AMOUNT,
      };
    }
    raw = input.toString();
  } else if (typeof input === "number") {
    if (!Number.isFinite(input) || !Number.isInteger(input)) {
      return {
        ok: false,
        error: `${label} must be a finite integer`,
        code: ERROR_CODES.INVALID_AMOUNT,
      };
    }
    if (input < 0 || Object.is(input, -0)) {
      return {
        ok: false,
        error: `${label} cannot be negative`,
        code: ERROR_CODES.INVALID_AMOUNT,
      };
    }
    raw = String(input);
  } else {
    if (typeof input !== "string") {
      return {
        ok: false,
        error: `${label} must be a string, number, or bigint`,
        code: ERROR_CODES.INVALID_AMOUNT,
      };
    }
    raw = input.trim();
    if (raw.startsWith("-")) {
      return {
        ok: false,
        error: `${label} cannot be negative`,
        code: ERROR_CODES.INVALID_AMOUNT,
      };
    }
    if (!/^\d+$/.test(raw)) {
      return {
        ok: false,
        error: `${label} must be an integer numeric value`,
        code: ERROR_CODES.INVALID_AMOUNT,
      };
    }
  }

  if (digitCount(raw) > MAX_SAFE_DIGITS) {
    return {
      ok: false,
      error: `${label} exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
      code: ERROR_CODES.EXCESSIVE_DIGITS,
    };
  }

  return { ok: true, value: BigInt(raw) };
}

/**
 * Confirm that a set of split raw amounts sums exactly to the given base
 * raw amount, rejecting allocations that over- or under-allocate the total.
 */
export function validateSplitSum(
  parts: Array<string | number | bigint>,
  baseAmount: string | number | bigint
): ConversionResult {
  let total = 0n;

  for (let i = 0; i < parts.length; i++) {
    const checked = validateRawAmount(parts[i], `parts[${i}]`);
    if (!checked.ok) {
      return checked;
    }
    total += checked.value;
  }

  const baseCheck = validateRawAmount(baseAmount, "baseAmount");
  if (!baseCheck.ok) {
    return baseCheck;
  }

  if (total !== baseCheck.value) {
    return {
      ok: false,
      error: `split total (${total}) does not match base amount (${baseCheck.value})`,
      code: ERROR_CODES.SUM_MISMATCH,
    };
  }

  return { ok: true, value: total };
}

/**
 * Convert a human-readable decimal amount (e.g. "12.5") into raw integer
 * units by scaling with the token's decimals value (raw = human * 10^decimals).
 * Rejects negative amounts as token amounts cannot be negative.
 */
export function toRawUnits(
  humanAmount: string | number,
  decimals: number
): ConversionResult {
  const rateCheck = checkConversionRateLimit();
  if (!rateCheck.ok) {
    return rateCheck;
  }

  const decimalsCheck = validateDecimals(decimals);
  if (!decimalsCheck.ok) {
    return decimalsCheck;
  }

  if (
    typeof humanAmount === "number" &&
    !Number.isFinite(humanAmount)
  ) {
    return {
      ok: false,
      error: "amount must be a finite number",
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  if (
    typeof humanAmount === "number" &&
    (humanAmount < 0 || Object.is(humanAmount, -0))
  ) {
    return {
      ok: false,
      error: "amount cannot be negative",
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  const raw = String(humanAmount).trim();
  if (raw.startsWith("-")) {
    return {
      ok: false,
      error: "amount cannot be negative",
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  if (!/^\d+(\.\d+)?$/.test(raw)) {
    return {
      ok: false,
      error: "amount must be a numeric decimal value",
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  const [wholePart, fractionalPart = ""] = raw.split(".");

  if (fractionalPart.length > decimals) {
    return {
      ok: false,
      error: `amount has more fractional digits than decimals (${decimals}) allows`,
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  const paddedFractional = fractionalPart.padEnd(decimals, "0");
  const combined = `${wholePart}${paddedFractional}`.replace(/^0+(?=\d)/, "");

  if (digitCount(combined) > MAX_SAFE_DIGITS) {
    return {
      ok: false,
      error: `converted amount would exceed maximum of ${MAX_SAFE_DIGITS} digits`,
      code: ERROR_CODES.CONVERSION_OVERFLOW,
    };
  }

  const value = BigInt(combined);
  return { ok: true, value };
}

export interface ToHumanUnitsOptions {
  /**
   * When true, preserves fractional zeros up to `decimals` (fixed scale),
   * matching database precision schemas (e.g. "1.5000000" for 7 decimals).
   * Defaults to false (trimmed trailing zeros, e.g. "1.5").
   */
  fixedScale?: boolean;
}

/**
 * Convert a raw integer token amount back into a human-readable decimal
 * string by inserting the decimal point at the position given by decimals.
 * Rejects negative amounts as token amounts cannot be negative.
 *
 * @param rawAmount - The raw integer amount (bigint, number, or string)
 * @param decimals - Token decimal places (0 to 18)
 * @param options - Formatting options, e.g. fixedScale to preserve trailing zeroes
 */
export function toHumanUnits(
  rawAmount: string | number | bigint,
  decimals: number,
  options?: ToHumanUnitsOptions
): { ok: true; value: string } | { ok: false; error: string; code: DecimalsErrorCode } {
  const rateCheck = checkConversionRateLimit();
  if (!rateCheck.ok) {
    return rateCheck;
  }

  const decimalsCheck = validateDecimals(decimals);
  if (!decimalsCheck.ok) {
    return decimalsCheck;
  }

  const rawCheck = validateRawAmount(rawAmount, "rawAmount");
  if (!rawCheck.ok) {
    return rawCheck;
  }

  const digits = rawCheck.value.toString();

  if (decimals === 0) {
    return { ok: true, value: digits };
  }

  const padded = digits.padStart(decimals + 1, "0");
  const wholePart = padded.slice(0, padded.length - decimals);
  const fractionalPart = padded.slice(padded.length - decimals);
  const trimmedFractional = options?.fixedScale
    ? fractionalPart
    : fractionalPart.replace(/0+$/, "");

  const value = trimmedFractional.length > 0
    ? `${wholePart}.${trimmedFractional}`
    : wholePart;

  return { ok: true, value };
}

/**
 * Format a raw token amount to a decimal string matching a database precision schema's fixed scale.
 */
export function formatToDbPrecision(
  rawAmount: string | number | bigint,
  decimals: number,
  options?: { fixedScale?: boolean; precision?: number }
): { ok: true; value: string } | { ok: false; error: string; code: DecimalsErrorCode } {
  return toHumanUnits(rawAmount, decimals, { fixedScale: options?.fixedScale ?? true });
}

/**
 * Validate a database precision schema configuration.
 */
export function validateDbPrecisionSchema(
  schema: DbPrecisionSchema
): { ok: true } | { ok: false; error: string; code: DecimalsErrorCode } {
  if (schema.scale !== undefined) {
    const scaleCheck = validateDecimals(schema.scale);
    if (!scaleCheck.ok) {
      return scaleCheck;
    }
  }

  if (schema.precision !== undefined) {
    if (
      typeof schema.precision !== "number" ||
      !Number.isFinite(schema.precision) ||
      !Number.isInteger(schema.precision) ||
      schema.precision <= 0
    ) {
      return {
        ok: false,
        error: "schema precision must be a positive integer",
        code: ERROR_CODES.INVALID_SCHEMA,
      };
    }
    if (schema.precision > MAX_SAFE_DIGITS) {
      return {
        ok: false,
        error: `schema precision cannot exceed ${MAX_SAFE_DIGITS} digits`,
        code: ERROR_CODES.INVALID_SCHEMA,
      };
    }
    if (schema.scale !== undefined && schema.scale > schema.precision) {
      return {
        ok: false,
        error: "schema scale cannot exceed precision",
        code: ERROR_CODES.INVALID_SCHEMA,
      };
    }
  }

  return { ok: true };
}

/**
 * Format values calculated by token_decimals_converter to match database
 * precision schemas, producing row attributes that preserve full precision.
 *
 * @param amount - The raw integer amount (bigint, integer string/number) or human decimal amount (string/number with decimal point)
 * @param decimals - The token decimals scale (0 to 18)
 * @param schema - Optional database precision schema options (scale, precision, fixedScale, column mappings)
 */
export function formatForDbStorage(
  amount: string | number | bigint | ConversionResult | { ok: true; value: string },
  decimals: number,
  schema?: DbPrecisionSchema
): DbFormatResult {
  const decimalsCheck = validateDecimals(decimals);
  if (!decimalsCheck.ok) {
    return decimalsCheck;
  }

  if (schema) {
    const schemaCheck = validateDbPrecisionSchema(schema);
    if (!schemaCheck.ok) {
      return schemaCheck;
    }
  }

  let unwrapped: string | number | bigint;
  if (typeof amount === "object" && amount !== null && "ok" in amount) {
    if (!amount.ok) {
      return amount;
    }
    unwrapped = amount.value;
  } else {
    unwrapped = amount;
  }

  const effectiveScale = schema?.scale !== undefined ? schema.scale : decimals;
  const isFixedScale = schema?.fixedScale ?? true;
  const inputType = schema?.inputType ?? "auto";

  let rawBigInt: bigint;
  let rawStr: string;

  if (typeof unwrapped === "bigint") {
    if (inputType === "human") {
      const rawResult = toRawUnits(unwrapped.toString(), effectiveScale);
      if (!rawResult.ok) {
        return rawResult;
      }
      rawBigInt = rawResult.value;
      rawStr = rawBigInt.toString();
    } else {
      const rawCheck = validateRawAmount(unwrapped, "amount");
      if (!rawCheck.ok) {
        return rawCheck;
      }
      rawBigInt = rawCheck.value;
      rawStr = rawBigInt.toString();
    }
  } else if (typeof unwrapped === "number") {
    if (!Number.isFinite(unwrapped)) {
      return {
        ok: false,
        error: "amount must be a finite number",
        code: ERROR_CODES.INVALID_AMOUNT,
      };
    }
    if (unwrapped < 0 || Object.is(unwrapped, -0)) {
      return {
        ok: false,
        error: "amount cannot be negative",
        code: ERROR_CODES.INVALID_AMOUNT,
      };
    }
    if (inputType === "human" || !Number.isInteger(unwrapped)) {
      const rawResult = toRawUnits(unwrapped, effectiveScale);
      if (!rawResult.ok) {
        return rawResult;
      }
      rawBigInt = rawResult.value;
      rawStr = rawBigInt.toString();
    } else {
      const rawCheck = validateRawAmount(unwrapped, "amount");
      if (!rawCheck.ok) {
        return rawCheck;
      }
      rawBigInt = rawCheck.value;
      rawStr = rawBigInt.toString();
    }
  } else {
    const trimmed = unwrapped.trim();
    if (trimmed.startsWith("-")) {
      return {
        ok: false,
        error: "amount cannot be negative",
        code: ERROR_CODES.INVALID_AMOUNT,
      };
    }
    if (inputType === "human" || trimmed.includes(".")) {
      const rawResult = toRawUnits(trimmed, effectiveScale);
      if (!rawResult.ok) {
        return rawResult;
      }
      rawBigInt = rawResult.value;
      rawStr = rawBigInt.toString();
    } else {
      const rawCheck = validateRawAmount(trimmed, "amount");
      if (!rawCheck.ok) {
        return rawCheck;
      }
      rawBigInt = rawCheck.value;
      rawStr = rawBigInt.toString();
    }
  }

  const maxDigits = schema?.precision ?? MAX_SAFE_DIGITS;
  if (digitCount(rawStr) > maxDigits) {
    return {
      ok: false,
      error: `amount exceeds maximum allowed precision of ${maxDigits} digits`,
      code: ERROR_CODES.EXCESSIVE_DIGITS,
    };
  }

  const formattedResult = toHumanUnits(rawBigInt, effectiveScale, { fixedScale: isFixedScale });
  if (!formattedResult.ok) {
    return formattedResult;
  }

  const trimmedResult = toHumanUnits(rawBigInt, effectiveScale, { fixedScale: false });
  const trimmedAmount = trimmedResult.ok ? trimmedResult.value : formattedResult.value;

  const rawCol = schema?.columns?.rawAmount ?? "raw_amount";
  const formattedCol = schema?.columns?.formattedAmount ?? "formatted_amount";
  const decimalsCol = schema?.columns?.decimals ?? "decimals";

  const row: DbStorageRow = {
    raw_amount: rawStr,
    formatted_amount: formattedResult.value,
    decimals: effectiveScale,
    rawAmount: rawStr,
    formattedAmount: formattedResult.value,
    trimmed_amount: trimmedAmount,
    [rawCol]: rawStr,
    [formattedCol]: formattedResult.value,
    [decimalsCol]: effectiveScale,
  };

  return {
    ok: true,
    value: row,
    columns: row,
    row,
  };
}

/**
 * Format raw integer amount explicitly for database storage.
 */
export function formatRawForDbStorage(
  rawAmount: string | number | bigint,
  decimals: number,
  schema?: DbPrecisionSchema
): DbFormatResult {
  return formatForDbStorage(rawAmount, decimals, { ...schema, inputType: "raw" });
}

/**
 * Format human decimal amount explicitly for database storage.
 */
export function formatHumanForDbStorage(
  humanAmount: string | number,
  decimals: number,
  schema?: DbPrecisionSchema
): DbFormatResult {
  return formatForDbStorage(humanAmount, decimals, { ...schema, inputType: "human" });
}

/**
 * Alias for formatForDbStorage.
 */
export const formatDbColumns = formatForDbStorage;

/**
 * Alias for formatForDbStorage matching the exact issue name.
 */
export const formatColumnsForDbStorage = formatForDbStorage;

/**
 * Factory to configure format columns for database storage with default schema rules.
 */
export function configureFormatColumns(defaultSchema?: DbPrecisionSchema) {
  return {
    schema: defaultSchema,
    format: (
      amount: string | number | bigint | ConversionResult | { ok: true; value: string },
      decimals?: number,
      overrideSchema?: DbPrecisionSchema
    ) =>
      formatForDbStorage(
        amount,
        decimals ?? defaultSchema?.scale ?? 7,
        { ...defaultSchema, ...overrideSchema }
      ),
    formatRaw: (
      rawAmount: string | number | bigint,
      decimals?: number,
      overrideSchema?: DbPrecisionSchema
    ) =>
      formatRawForDbStorage(
        rawAmount,
        decimals ?? defaultSchema?.scale ?? 7,
        { ...defaultSchema, ...overrideSchema }
      ),
    formatHuman: (
      humanAmount: string | number,
      decimals?: number,
      overrideSchema?: DbPrecisionSchema
    ) =>
      formatHumanForDbStorage(
        humanAmount,
        decimals ?? defaultSchema?.scale ?? 7,
        { ...defaultSchema, ...overrideSchema }
      ),
    validateSchema: (schema: DbPrecisionSchema) => validateDbPrecisionSchema(schema),
  };
}

/**
 * Escape an individual CSV field following RFC 4180 rules.
 * If the value contains commas, quotes, or newlines, it will be wrapped in
 * double quotes, with internal quotes doubled.
 */
export function escapeCsvField(value: unknown, delimiter = ","): string {
  if (value === null || value === undefined) {
    return "";
  }
  let str: string;
  if (typeof value === "bigint") {
    str = value.toString();
  } else if (typeof value === "string") {
    str = value;
  } else {
    str = String(value);
  }

  const needsQuotes =
    str.includes(delimiter) ||
    str.includes('"') ||
    str.includes("\n") ||
    str.includes("\r");

  if (needsQuotes) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Format an array of values into a single CSV row.
 */
export function formatRowToCsv(values: unknown[], delimiter = ","): string {
  return values.map((v) => escapeCsvField(v, delimiter)).join(delimiter);
}

/**
 * Validate a single token conversion record step-by-step.
 * Resolves both rawAmount and humanAmount ensuring numerical consistency
 * and adherence to digit limits.
 */
export function validateConversionRecord(
  record: TokenConversionRecord,
  index = 0
): { ok: true; value: ValidatedConversionRow } | { ok: false; error: string; code: DecimalsErrorCode } {
  if (!record || typeof record !== "object") {
    return {
      ok: false,
      error: `record at index ${index} must be an object`,
      code: ERROR_CODES.INVALID_ROW,
    };
  }

  const decimalsCheck = validateDecimals(record.decimals);
  if (!decimalsCheck.ok) {
    return decimalsCheck;
  }
  const decimals = record.decimals;

  const rawInput = record.rawAmount !== undefined ? record.rawAmount : record.raw_amount;
  const humanInput = record.humanAmount !== undefined ? record.humanAmount : record.human_amount;

  if (rawInput === undefined && humanInput === undefined) {
    return {
      ok: false,
      error: `record at index ${index} must provide either rawAmount or humanAmount`,
      code: ERROR_CODES.INVALID_ROW,
    };
  }

  let resolvedRaw: bigint;
  let resolvedHuman: string;

  if (rawInput !== undefined && humanInput !== undefined) {
    const rawCheck = validateRawAmount(rawInput, `records[${index}].rawAmount`);
    if (!rawCheck.ok) {
      return rawCheck;
    }
    const humanCheck = toRawUnits(humanInput, decimals);
    if (!humanCheck.ok) {
      return humanCheck;
    }

    if (rawCheck.value !== humanCheck.value) {
      return {
        ok: false,
        error: `record at index ${index} rawAmount (${rawCheck.value.toString()}) does not match humanAmount (${String(humanInput)}) for decimals ${decimals}`,
        code: ERROR_CODES.INVALID_AMOUNT,
      };
    }
    resolvedRaw = rawCheck.value;
    const humanConv = toHumanUnits(resolvedRaw, decimals);
    if (!humanConv.ok) {
      return humanConv;
    }
    resolvedHuman = humanConv.value;
  } else if (rawInput !== undefined) {
    const rawCheck = validateRawAmount(rawInput, `records[${index}].rawAmount`);
    if (!rawCheck.ok) {
      return rawCheck;
    }
    resolvedRaw = rawCheck.value;
    const humanConv = toHumanUnits(resolvedRaw, decimals);
    if (!humanConv.ok) {
      return humanConv;
    }
    resolvedHuman = humanConv.value;
  } else {
    // humanInput is defined
    const humanCheck = toRawUnits(humanInput as string | number, decimals);
    if (!humanCheck.ok) {
      return humanCheck;
    }
    resolvedRaw = humanCheck.value;
    const humanConv = toHumanUnits(resolvedRaw, decimals);
    if (!humanConv.ok) {
      return humanConv;
    }
    resolvedHuman = humanConv.value;
  }

  const symbol = typeof record.symbol === "string" ? record.symbol : undefined;
  const token = typeof record.token === "string" ? record.token : undefined;
  const label = typeof record.label === "string" ? record.label : undefined;

  const result: ValidatedConversionRow = {
    rawAmount: resolvedRaw,
    humanAmount: resolvedHuman,
    decimals,
  };
  if (symbol !== undefined) result.symbol = symbol;
  if (token !== undefined) result.token = token;
  if (label !== undefined) result.label = label;

  for (const [k, v] of Object.entries(record)) {
    if (
      k !== "rawAmount" &&
      k !== "raw_amount" &&
      k !== "humanAmount" &&
      k !== "human_amount" &&
      k !== "decimals" &&
      k !== "symbol" &&
      k !== "token" &&
      k !== "label"
    ) {
      result[k] = v;
    }
  }

  return { ok: true, value: result };
}

/**
 * Build a CSV formatting block from an array of token conversion records.
 * Validates each record against overflow and decimal limits, and constructs
 * properly escaped table output rows.
 */
export function buildCsvBlock(
  records: TokenConversionRecord[],
  options?: CsvExportOptions
): CsvFormattingOutcome {
  if (!Array.isArray(records)) {
    return {
      ok: false,
      error: "records must be an array",
      code: ERROR_CODES.INVALID_INPUT,
    };
  }

  if (records.length === 0 && options?.allowEmpty === false) {
    return {
      ok: false,
      error: "records array cannot be empty",
      code: ERROR_CODES.EMPTY_DATA,
    };
  }

  const delimiter = options?.delimiter ?? ",";
  const lineEnding = options?.lineEnding ?? "\n";
  const includeHeader = options?.includeHeader !== false;

  const validatedRows: ValidatedConversionRow[] = [];
  for (let i = 0; i < records.length; i++) {
    const check = validateConversionRecord(records[i], i);
    if (!check.ok) {
      return check;
    }
    validatedRows.push(check.value);
  }

  // Determine column list
  let columns: string[];
  if (options?.columns && options.columns.length > 0) {
    columns = [...options.columns];
  } else {
    const hasSymbol = validatedRows.some((r) => r.symbol !== undefined);
    const hasToken = validatedRows.some((r) => r.token !== undefined);
    const hasLabel = validatedRows.some((r) => r.label !== undefined);

    columns = [];
    if (hasSymbol) columns.push("symbol");
    if (hasToken && !hasSymbol) columns.push("token");
    if (hasLabel) columns.push("label");
    columns.push("rawAmount", "decimals", "humanAmount");
  }

  const headers =
    options?.headers && options.headers.length === columns.length
      ? options.headers
      : columns;

  const lines: string[] = [];

  if (includeHeader) {
    lines.push(formatRowToCsv(headers, delimiter));
  }

  for (const row of validatedRows) {
    const rowValues = columns.map((col) => {
      if (col === "rawAmount" || col === "raw_amount") {
        return row.rawAmount.toString();
      }
      if (col === "humanAmount" || col === "human_amount") {
        return row.humanAmount;
      }
      if (col === "decimals") {
        return row.decimals.toString();
      }
      if (col === "symbol") {
        return row.symbol ?? "";
      }
      if (col === "token") {
        return row.token ?? "";
      }
      if (col === "label") {
        return row.label ?? "";
      }
      return row[col] !== undefined ? row[col] : "";
    });
    lines.push(formatRowToCsv(rowValues, delimiter));
  }

  const value = lines.join(lineEnding) + (lines.length > 0 ? lineEnding : "");
  return {
    ok: true,
    value,
    rowCount: validatedRows.length,
    columns,
  };
}

/**
 * Format exporter aliases to buildCsvBlock.
 */
export const exportToCsv = buildCsvBlock;
export const formatToCsv = buildCsvBlock;
export const serializeToCsv = buildCsvBlock;
export const formatConversionTable = buildCsvBlock;

/**
 * Exporter specifically for converting raw amounts to human amounts and generating CSV output.
 */
export function exportRawToHumanCsv(
  entries: Array<{
    rawAmount: string | number | bigint;
    decimals: number;
    symbol?: string;
    token?: string;
    label?: string;
  }>,
  options?: CsvExportOptions
): CsvFormattingOutcome {
  return buildCsvBlock(entries, options);
}

/**
 * Exporter specifically for converting human amounts to raw amounts and generating CSV output.
 */
export function exportHumanToRawCsv(
  entries: Array<{
    humanAmount: string | number;
    decimals: number;
    symbol?: string;
    token?: string;
    label?: string;
  }>,
  options?: CsvExportOptions
): CsvFormattingOutcome {
  return buildCsvBlock(entries, options);
}

/**
 * Serialize conversion data or pre-built CSV block to a file on disk.
 * Creates parent directories if they do not exist.
 */
export function exportToCsvFile(
  filePath: string,
  data: TokenConversionRecord[] | string,
  options?: CsvExportOptions
): FileSerializationOutcome {
  if (!filePath || typeof filePath !== "string" || filePath.trim().length === 0) {
    return {
      ok: false,
      error: "filePath must be a non-empty string",
      code: ERROR_CODES.INVALID_INPUT,
    };
  }

  let csvContent: string;
  let rowCount: number;

  if (typeof data === "string") {
    csvContent = data;
    const trimmed = data.trim();
    if (trimmed.length === 0) {
      rowCount = 0;
    } else {
      const splitLines = trimmed.split(/\r?\n/);
      rowCount = options?.includeHeader !== false ? Math.max(0, splitLines.length - 1) : splitLines.length;
    }
  } else if (Array.isArray(data)) {
    const formatted = buildCsvBlock(data, options);
    if (!formatted.ok) {
      return formatted;
    }
    csvContent = formatted.value;
    rowCount = formatted.rowCount;
  } else {
    return {
      ok: false,
      error: "data must be an array of conversion records or a CSV string",
      code: ERROR_CODES.INVALID_INPUT,
    };
  }

  try {
    const dir = path.dirname(filePath);
    if (dir && dir !== "." && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const encoding = options?.encoding ?? "utf-8";
    fs.writeFileSync(filePath, csvContent, { encoding });
    const bytesWritten = Buffer.byteLength(csvContent, encoding);

    return {
      ok: true,
      filePath,
      bytesWritten,
      rowCount,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Failed to write CSV file: ${errorMsg}`,
      code: ERROR_CODES.FILE_WRITE_ERROR,
    };
  }
}

/**
 * File serialization helper aliases.
 */
export const serializeToCsvFile = exportToCsvFile;
export const serializeConversionRecordsToFile = exportToCsvFile;

/**
 * Helper to write raw CSV content string directly to a file on disk.
 */
export function writeCsvToFile(
  filePath: string,
  csvContent: string,
  encoding: BufferEncoding = "utf-8"
): FileSerializationOutcome {
  return exportToCsvFile(filePath, csvContent, { encoding });
}

/**
 * Parse a single CSV row line respecting quoted fields and escaped quotes.
 */
export function parseCsvLine(line: string, delimiter = ","): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        current += char;
        i++;
        continue;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
        continue;
      } else if (char === delimiter) {
        result.push(current);
        current = "";
        i++;
        continue;
      } else {
        current += char;
        i++;
        continue;
      }
    }
  }
  result.push(current);
  return result;
}

/**
 * Split CSV content into logical rows, preserving multi-line quoted fields.
 */
function splitCsvRows(csvContent: string): string[] {
  const rows: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < csvContent.length; i++) {
    const char = csvContent[i];
    if (char === '"') {
      if (inQuotes && i + 1 < csvContent.length && csvContent[i + 1] === '"') {
        current += '""';
        i++;
      } else {
        inQuotes = !inQuotes;
        current += '"';
      }
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && i + 1 < csvContent.length && csvContent[i + 1] === "\n") {
        i++;
      }
      if (current.trim().length > 0) {
        rows.push(current);
      }
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim().length > 0) {
    rows.push(current);
  }
  return rows;
}

/**
 * Parse a CSV formatting block back into validated conversion records.
 */
export function parseCsvBlock(
  csvContent: string,
  options?: { delimiter?: string }
): CsvParseOutcome {
  if (typeof csvContent !== "string") {
    return {
      ok: false,
      error: "csvContent must be a string",
      code: ERROR_CODES.INVALID_INPUT,
    };
  }

  const delimiter = options?.delimiter ?? ",";
  const rows = splitCsvRows(csvContent);
  if (rows.length === 0) {
    return { ok: true, records: [], rowCount: 0 };
  }

  const headerFields = parseCsvLine(rows[0], delimiter).map((h) => h.trim());
  const records: ValidatedConversionRow[] = [];

  for (let r = 1; r < rows.length; r++) {
    const fields = parseCsvLine(rows[r], delimiter);
    const rowObj: TokenConversionRecord = { decimals: 0 };

    for (let c = 0; c < headerFields.length; c++) {
      const header = headerFields[c];
      const val = fields[c] ?? "";

      if (header === "decimals") {
        rowObj.decimals = Number(val);
      } else if (header === "rawAmount" || header === "raw_amount") {
        if (val !== "") rowObj.rawAmount = val;
      } else if (header === "humanAmount" || header === "human_amount") {
        if (val !== "") rowObj.humanAmount = val;
      } else if (header === "symbol") {
        if (val !== "") rowObj.symbol = val;
      } else if (header === "token") {
        if (val !== "") rowObj.token = val;
      } else if (header === "label") {
        if (val !== "") rowObj.label = val;
      } else {
        rowObj[header] = val;
      }
    }

    const check = validateConversionRecord(rowObj, r - 1);
    if (!check.ok) {
      return check;
    }
    records.push(check.value);
  }

  return { ok: true, records, rowCount: records.length };
}

/**
 * Read and deserialize a CSV file from disk into conversion records.
 */
export function readCsvFromFile(
  filePath: string,
  options?: { encoding?: BufferEncoding; delimiter?: string }
): CsvParseOutcome {
  if (!filePath || typeof filePath !== "string") {
    return {
      ok: false,
      error: "filePath must be a non-empty string",
      code: ERROR_CODES.INVALID_INPUT,
    };
  }

  try {
    const encoding = options?.encoding ?? "utf-8";
    const content = fs.readFileSync(filePath, { encoding });
    return parseCsvBlock(content, { delimiter: options?.delimiter });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Failed to read CSV file: ${errorMsg}`,
      code: ERROR_CODES.FILE_READ_ERROR,
    };
  }
}

export const parseCsvFromFile = readCsvFromFile;

