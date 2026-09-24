/**
 * Interest yield estimator with overflow / digit-limit validation.
 * Rejects principals and rates whose digit count would risk unsafe numeric overflow.
 * Also exposes CSV formatting-block and file-serialization helpers so yield
 * estimates can be exported to disk as a table.
 */

import fs from "fs";
import path from "path";

/** Max decimal digits allowed for a principal or rate (below Number.MAX_SAFE_INTEGER). */
export const MAX_SAFE_DIGITS = 15;

export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "OVERFLOW_EXCESSIVE_DIGITS",
  INVALID_RATE: "OVERFLOW_INVALID_RATE",
  PRODUCT_OVERFLOW: "OVERFLOW_PRODUCT_EXCEEDED",
  FILE_WRITE_ERROR: "YIELD_FILE_WRITE_ERROR",
  FILE_READ_ERROR: "YIELD_FILE_READ_ERROR",
  INVALID_INPUT: "YIELD_INVALID_INPUT",
  INVALID_ROW: "YIELD_INVALID_ROW",
  EMPTY_DATA: "YIELD_EMPTY_DATA",
} as const;

export type OverflowErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ValidationResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: OverflowErrorCode };

function digitCount(normalized: string): number {
  const digits = normalized.replace(/^-/, "").replace(/^0+(?=\d)/, "");
  return digits.length === 0 ? 1 : digits.length;
}

function parseIntegerInput(
  input: string | number | bigint,
  label: string,
  invalidCode: OverflowErrorCode
): ValidationResult {
  let raw: string;

  if (typeof input === "bigint") {
    raw = input.toString();
  } else if (typeof input === "number") {
    if (!Number.isFinite(input) || !Number.isInteger(input)) {
      return {
        ok: false,
        error: `${label} must be a finite integer`,
        code: invalidCode,
      };
    }
    raw = String(input);
  } else {
    raw = input.trim();
    if (!/^-?\d+$/.test(raw)) {
      return {
        ok: false,
        error: `${label} must be an integer numeric value`,
        code: invalidCode,
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
 * Validate an interest rate (integer scaled factor) against digit limits.
 */
export function validateInterestRate(
  rate: string | number | bigint
): ValidationResult {
  return parseIntegerInput(rate, "rate", ERROR_CODES.INVALID_RATE);
}

/**
 * Estimate yield as principal * rate after validating both operands for overflow.
 * Rate is treated as an integer scaled factor (e.g. fixed-point APR).
 */
export function estimateInterestYield(
  principal: string | number | bigint,
  rate: string | number | bigint
): ValidationResult {
  const amount = parseIntegerInput(
    principal,
    "principal",
    ERROR_CODES.INVALID_RATE
  );
  if (!amount.ok) {
    return amount;
  }

  const factor = validateInterestRate(rate);
  if (!factor.ok) {
    return factor;
  }

  const product = amount.value * factor.value;
  if (digitCount(product.toString()) > MAX_SAFE_DIGITS) {
    return {
      ok: false,
      error: `yield estimate exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
      code: ERROR_CODES.PRODUCT_OVERFLOW,
    };
  }

  return { ok: true, value: product };
}

// ---------------------------------------------------------------------------
// CSV formatting-block & file serialization helpers
// ---------------------------------------------------------------------------

/** Options configuring CSV table formatting and file export. */
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

/** A single interest-yield estimate record: principal and integer-scaled rate. */
export interface InterestYieldRecord {
  principal?: string | number | bigint;
  rate?: string | number | bigint;
}

/** A validated interest-yield row with both operands and the computed yield. */
export interface ValidatedYieldRow {
  principal: bigint;
  rate: bigint;
  yield: bigint;
}

/** Outcome of CSV formatting. */
export type CsvFormattingOutcome =
  | { ok: true; value: string; rowCount: number; columns: string[] }
  | { ok: false; error: string; code: OverflowErrorCode };

/** Outcome of file serialization. */
export type FileSerializationOutcome =
  | { ok: true; filePath: string; bytesWritten: number; rowCount: number }
  | { ok: false; error: string; code: OverflowErrorCode };

/** Outcome of CSV deserialization / parsing. */
export type CsvParseOutcome =
  | { ok: true; records: ValidatedYieldRow[]; rowCount: number }
  | { ok: false; error: string; code: OverflowErrorCode };

function isNumericInput(value: unknown): value is string | number | bigint {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  );
}

/**
 * Coerce an already-validated operand back to a canonical bigint for table
 * output. Only called after `estimateInterestYield` has accepted the operand,
 * so the conversion is guaranteed to be safe.
 */
function coerceBigInt(input: string | number | bigint): bigint {
  if (typeof input === "bigint") {
    return input;
  }
  if (typeof input === "number") {
    return BigInt(input);
  }
  return BigInt(input.trim());
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

/** Format an array of values into a single CSV row. */
export function formatRowToCsv(values: unknown[], delimiter = ","): string {
  return values.map((v) => escapeCsvField(v, delimiter)).join(delimiter);
}

/**
 * Validate a single interest-yield record and compute its yield. The yield is
 * always recomputed from the record's principal and rate, so a mismatched
 * caller-supplied value can never slip through.
 */
export function validateYieldRecord(
  record: InterestYieldRecord,
  index = 0
):
  | { ok: true; value: ValidatedYieldRow }
  | { ok: false; error: string; code: OverflowErrorCode } {
  if (!record || typeof record !== "object") {
    return {
      ok: false,
      error: `record at index ${index} must be an object`,
      code: ERROR_CODES.INVALID_ROW,
    };
  }

  const { principal, rate } = record;
  if (principal === undefined || rate === undefined) {
    return {
      ok: false,
      error: `record at index ${index} must provide principal and rate`,
      code: ERROR_CODES.INVALID_ROW,
    };
  }

  if (!isNumericInput(principal) || !isNumericInput(rate)) {
    return {
      ok: false,
      error: `record at index ${index} principal and rate must be string, number, or bigint`,
      code: ERROR_CODES.INVALID_ROW,
    };
  }

  const result = estimateInterestYield(principal, rate);
  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    value: {
      principal: coerceBigInt(principal),
      rate: coerceBigInt(rate),
      yield: result.value,
    },
  };
}

/**
 * Build a CSV formatting block from an array of interest-yield records.
 * Validates each record against overflow / digit limits and produces a
 * properly escaped table with `principal,rate,yield` columns by default.
 */
export function buildCsvBlock(
  records: InterestYieldRecord[],
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

  const validatedRows: ValidatedYieldRow[] = [];
  for (let i = 0; i < records.length; i++) {
    const check = validateYieldRecord(records[i], i);
    if (!check.ok) {
      return check;
    }
    validatedRows.push(check.value);
  }

  let columns: string[];
  if (options?.columns && options.columns.length > 0) {
    columns = [...options.columns];
  } else {
    columns = ["principal", "rate", "yield"];
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
      if (col === "principal") {
        return row.principal.toString();
      }
      if (col === "rate") {
        return row.rate.toString();
      }
      if (col === "yield") {
        return row.yield.toString();
      }
      return "";
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

/** Format exporter aliases to buildCsvBlock. */
export const exportToCsv = buildCsvBlock;
export const formatToCsv = buildCsvBlock;
export const serializeToCsv = buildCsvBlock;
export const formatYieldTable = buildCsvBlock;

/**
 * Serialize interest-yield records or a pre-built CSV string to a file on disk.
 * Creates parent directories if they do not exist.
 */
export function exportToCsvFile(
  filePath: string,
  data: InterestYieldRecord[] | string,
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
      rowCount =
        options?.includeHeader !== false
          ? Math.max(0, splitLines.length - 1)
          : splitLines.length;
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
      error: "data must be an array of interest-yield records or a CSV string",
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

/** File serialization helper aliases. */
export const serializeToCsvFile = exportToCsvFile;
export const serializeYieldRecordsToFile = exportToCsvFile;

/** Helper to write raw CSV content string directly to a file on disk. */
export function writeCsvToFile(
  filePath: string,
  csvContent: string,
  encoding: BufferEncoding = "utf-8"
): FileSerializationOutcome {
  return exportToCsvFile(filePath, csvContent, { encoding });
}

/** Parse a single CSV row line respecting quoted fields and escaped quotes. */
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

/** Split CSV content into logical rows, preserving multi-line quoted fields. */
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
 * Parse a CSV formatting block back into validated interest-yield records.
 * The `yield` column (if present) is ignored: it is recomputed from principal
 * and rate during validation, so a stale or mismatched cell cannot corrupt the
 * parsed result.
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
  const records: ValidatedYieldRow[] = [];

  for (let r = 1; r < rows.length; r++) {
    const fields = parseCsvLine(rows[r], delimiter);
    const rowObj: InterestYieldRecord = {};

    for (let c = 0; c < headerFields.length; c++) {
      const header = headerFields[c];
      const val = fields[c] ?? "";
      if (header === "principal") {
        if (val !== "") rowObj.principal = val;
      } else if (header === "rate") {
        if (val !== "") rowObj.rate = val;
      }
      // "yield" and any other column are intentionally ignored.
    }

    const check = validateYieldRecord(rowObj, r - 1);
    if (!check.ok) {
      return check;
    }
    records.push(check.value);
  }

  return { ok: true, records, rowCount: records.length };
}

/** Read and deserialize a CSV file from disk into interest-yield records. */
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
