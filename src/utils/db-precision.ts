/**
 * Database precision formatting helpers (#635).
 *
 * The single implementation of the fixed-scale formatters used when writing
 * amounts to DECIMAL/TEXT columns, the generic `formatForDbStorage` family
 * (amount + decimals → storage row), and the integer-string round-trip
 * helpers. Module-specific wrappers (refund, report, ledger, conversion
 * rate, tax) delegate here.
 */

import { digitCount, MAX_AMOUNT } from "./digit-limit-validator.js";
import {
  ERROR_CODES,
  validateDecimals,
  validateRawAmount,
  toRawUnits,
  toHumanUnits,
  type ConversionResult,
  type DecimalsErrorCode,
} from "./token_decimals_converter.js";

// ---------------------------------------------------------------------------
// Fixed-scale value formatting
// ---------------------------------------------------------------------------

/**
 * Render a scaled bigint `value` as a decimal string with exactly `decimals`
 * fractional digits (e.g. 25_000_000n at 7 decimals -> "2.5000000").
 * `decimals = 0` renders a plain integer. With `fixedScale: false` trailing
 * fractional zeroes (and a bare point) are trimmed.
 *
 * `label` names the caller in thrown errors.
 */
export function formatDecimalForDb(
  value: bigint,
  decimals: number,
  options: { fixedScale?: boolean; label?: string } = {}
): string {
  const label = options.label ?? "formatDecimalForDb";
  if (typeof value !== "bigint") {
    throw new TypeError(`${label}: value must be a bigint`);
  }
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(
      `${label}: decimals must be a non-negative integer, got ${decimals}`
    );
  }
  if (decimals === 0) {
    return value.toString();
  }

  const isNegative = value < 0n;
  const abs = isNegative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const integerPart = abs / scale;
  let fracStr = (abs % scale).toString().padStart(decimals, "0");
  if (options.fixedScale === false) {
    fracStr = fracStr.replace(/0+$/, "");
  }
  const formatted =
    fracStr.length > 0 ? `${integerPart.toString()}.${fracStr}` : integerPart.toString();
  return isNegative ? `-${formatted}` : formatted;
}

/**
 * Parse a fixed-precision DB value (exactly `decimals` fractional digits)
 * back into its raw integer representation. Throws a SyntaxError when the
 * string does not match the expected precision.
 */
export function parseDecimalDbValue(
  formatted: string,
  decimals: number,
  label = "parseDecimalDbValue"
): bigint {
  const pattern =
    decimals === 0 ? /^-?\d+$/ : new RegExp(`^-?\\d+\\.\\d{${decimals}}$`);
  if (!pattern.test(formatted)) {
    throw new SyntaxError(
      `${label}: "${formatted}" does not match ${decimals}-decimal precision`
    );
  }
  return BigInt(formatted.replace(".", ""));
}

/** Refund columns: fixed-scale formatting (see `formatDecimalForDb`). */
export function formatRefundValueForDb(value: bigint, decimals: number): string {
  return formatDecimalForDb(value, decimals, { label: "formatRefundValueForDb" });
}

/** Parse a fixed-precision refund DB value back into its raw integer. */
export function parseRefundDbValue(formatted: string, decimals: number): bigint {
  return parseDecimalDbValue(formatted, decimals, "parseRefundDbValue");
}

/**
 * Format a BigInt amount as a database-safe integer string.
 * Preserves full precision without scientific notation.
 */
export function formatAmountForDatabase(amount: bigint): string {
  return amount.toString();
}

/**
 * Parse a database formatted integer amount back to BigInt.
 * Ensures no precision loss during round-trip.
 */
export function parseAmountFromDatabase(formatted: string): bigint {
  try {
    return BigInt(formatted);
  } catch {
    throw new Error(`Invalid database amount format: ${formatted}`);
  }
}

// ---------------------------------------------------------------------------
// Storage rows for token amounts (amount + decimals)
// ---------------------------------------------------------------------------

/**
 * Configuration options for database precision schema and column mapping.
 */
export interface DbPrecisionSchema {
  /** Column scale (decimal places). Defaults to token decimals if not specified. */
  scale?: number;
  /** Maximum precision (total digits). Defaults to the i128 amount width. */
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
    if (schema.precision > MAX_AMOUNT.toString().length) {
      return {
        ok: false,
        error: `schema precision cannot exceed ${MAX_AMOUNT.toString().length} digits`,
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
 * Format token amounts to match database
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

  const maxDigits = schema?.precision ?? MAX_AMOUNT.toString().length;
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
