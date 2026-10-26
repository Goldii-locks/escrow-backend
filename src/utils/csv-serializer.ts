/**
 * Shared CSV helpers (#634).
 *
 * The single implementation of the RFC 4180 primitives used by every CSV
 * exporter in the codebase (escaping, row formatting, line/row parsing and
 * file IO), plus the fee deduction CSV exporters (#629) and the partial
 * payment allocator serializers.
 */

import fs from "fs";
import path from "path";
import type { PaymentAllocation, FormattedPaymentRow } from "./partial-payment-allocator.js";
import {
  ERROR_CODES as FEE_ERROR_CODES,
  validateFeeDeductionRecord,
  type FeeCalculatorErrorCode,
  type FeeDeductionRecord,
  type ValidatedFeeRow,
} from "./fee-deduction-calculator.js";

// ---------------------------------------------------------------------------
// RFC 4180 primitives
// ---------------------------------------------------------------------------

/**
 * Escape an individual CSV field following RFC 4180 rules.
 * If the value contains the delimiter, quotes, or line breaks, it is wrapped
 * in double quotes with internal quotes doubled. null/undefined become an
 * empty cell; bigints keep their exact decimal representation.
 */
export function escapeCsvField(value: unknown, delimiter = ","): string {
  if (value === null || value === undefined) {
    return "";
  }
  const str = typeof value === "string" ? value : String(value);

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
 * Format an array of values into a single escaped CSV row.
 */
export function formatRowToCsv(values: unknown[], delimiter = ","): string {
  return values.map((v) => escapeCsvField(v, delimiter)).join(delimiter);
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
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        current += char;
        i++;
      }
    } else if (char === '"') {
      inQuotes = true;
      i++;
    } else if (char === delimiter) {
      result.push(current);
      current = "";
      i++;
    } else {
      current += char;
      i++;
    }
  }
  result.push(current);
  return result;
}

/**
 * Split CSV content into logical rows, preserving multi-line quoted fields.
 * Blank rows are dropped.
 */
export function splitCsvRows(csvContent: string): string[] {
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
 * Count the data rows in a pre-built CSV string (one row per line),
 * excluding the header line unless `includeHeader` is false.
 */
export function countCsvDataRows(csvContent: string, includeHeader = true): number {
  const trimmed = csvContent.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  const lines = trimmed.split(/\r?\n/);
  return includeHeader ? Math.max(0, lines.length - 1) : lines.length;
}

/**
 * Write CSV content to disk, creating parent directories as needed.
 * Returns the number of bytes written; throws on IO failure.
 */
export function writeCsvFile(
  filePath: string,
  csvContent: string,
  encoding: BufferEncoding = "utf-8"
): number {
  const dir = path.dirname(filePath);
  if (dir && dir !== "." && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, csvContent, { encoding });
  return Buffer.byteLength(csvContent, encoding);
}

/**
 * Read CSV content from disk. Throws on IO failure.
 */
export function readCsvFile(
  filePath: string,
  encoding: BufferEncoding = "utf-8"
): string {
  return fs.readFileSync(filePath, { encoding });
}

// ---------------------------------------------------------------------------
// Fee deduction CSV exporters (#435, moved from the fee calculator in #629)
// ---------------------------------------------------------------------------
//
// Build CSV formatting blocks (tables) from fee deduction records. Each record
// is validated step-by-step through validateFeeDeductionRecord() so overflow /
// digit-limit violations fail fast before any table output is produced.

/**
 * Options configuring CSV table export and file serialization.
 */
export interface FeeCsvExportOptions {
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
export type FeeCsvFormattingOutcome =
  | {
      ok: true;
      value: string;
      rowCount: number;
      columns: string[];
    }
  | {
      ok: false;
      error: string;
      code: FeeCalculatorErrorCode;
    };

/**
 * Outcome of file serialization.
 */
export type FeeCsvFileOutcome =
  | {
      ok: true;
      filePath: string;
      bytesWritten: number;
      rowCount: number;
    }
  | {
      ok: false;
      error: string;
      code: FeeCalculatorErrorCode;
    };

/**
 * Outcome of CSV deserialization / parsing.
 */
export type FeeCsvParseOutcome =
  | {
      ok: true;
      records: ValidatedFeeRow[];
      rowCount: number;
    }
  | {
      ok: false;
      error: string;
      code: FeeCalculatorErrorCode;
    };

/**
 * Build a CSV formatting block from an array of fee deduction records.
 * Validates each record against overflow and digit limits, and constructs
 * properly escaped table output rows.
 */
export function buildFeeCsvBlock(
  records: FeeDeductionRecord[],
  options?: FeeCsvExportOptions
): FeeCsvFormattingOutcome {
  if (!Array.isArray(records)) {
    return {
      ok: false,
      error: "records must be an array",
      code: FEE_ERROR_CODES.INVALID_INPUT,
    };
  }

  if (records.length === 0 && options?.allowEmpty === false) {
    return {
      ok: false,
      error: "records array cannot be empty",
      code: FEE_ERROR_CODES.EMPTY_DATA,
    };
  }

  const delimiter = options?.delimiter ?? ",";
  const lineEnding = options?.lineEnding ?? "\n";
  const includeHeader = options?.includeHeader !== false;

  const validatedRows: ValidatedFeeRow[] = [];
  for (let i = 0; i < records.length; i++) {
    const check = validateFeeDeductionRecord(records[i], i);
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
    const hasLabel = validatedRows.some((r) => r.label !== undefined);
    columns = [];
    if (hasLabel) columns.push("label");
    columns.push(
      "grossAmount",
      "feeRate",
      "scale",
      "feeAmount",
      "netAmount",
      "remainder"
    );
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
      if (col === "label") {
        return row.label ?? "";
      }
      if (col === "grossAmount") {
        return row.grossAmount.toString();
      }
      if (col === "feeRate") {
        return row.feeRate.toString();
      }
      if (col === "scale") {
        return row.scale.toString();
      }
      if (col === "feeAmount") {
        return row.feeAmount.toString();
      }
      if (col === "netAmount") {
        return row.netAmount.toString();
      }
      if (col === "remainder") {
        return row.remainder.toString();
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
 * Format exporter aliases to buildFeeCsvBlock.
 */
export const formatFeeTable = buildFeeCsvBlock;
export const formatDeductionTable = buildFeeCsvBlock;

/**
 * Exporter specifically for fee deduction entries, generating CSV output.
 */
export function exportDeductionToCsv(
  entries: FeeDeductionRecord[],
  options?: FeeCsvExportOptions
): FeeCsvFormattingOutcome {
  return buildFeeCsvBlock(entries, options);
}

/**
 * Exporter specifically for fee share style entries (gross + rate pairs).
 */
export function exportFeeToCsv(
  entries: FeeDeductionRecord[],
  options?: FeeCsvExportOptions
): FeeCsvFormattingOutcome {
  return buildFeeCsvBlock(entries, options);
}

/**
 * Serialize fee deduction data or pre-built CSV block to a file on disk.
 * Creates parent directories if they do not exist.
 */
export function exportFeeCsvFile(
  filePath: string,
  data: FeeDeductionRecord[] | string,
  options?: FeeCsvExportOptions
): FeeCsvFileOutcome {
  if (!filePath || typeof filePath !== "string" || filePath.trim().length === 0) {
    return {
      ok: false,
      error: "filePath must be a non-empty string",
      code: FEE_ERROR_CODES.INVALID_INPUT,
    };
  }

  let csvContent: string;
  let rowCount: number;

  if (typeof data === "string") {
    csvContent = data;
    rowCount = countCsvDataRows(data, options?.includeHeader !== false);
  } else if (Array.isArray(data)) {
    const formatted = buildFeeCsvBlock(data, options);
    if (!formatted.ok) {
      return formatted;
    }
    csvContent = formatted.value;
    rowCount = formatted.rowCount;
  } else {
    return {
      ok: false,
      error: "data must be an array of fee deduction records or a CSV string",
      code: FEE_ERROR_CODES.INVALID_INPUT,
    };
  }

  try {
    const bytesWritten = writeCsvFile(filePath, csvContent, options?.encoding ?? "utf-8");

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
      code: FEE_ERROR_CODES.FILE_WRITE_ERROR,
    };
  }
}

/**
 * File serialization helper alias.
 */
export const serializeFeeRecordsToFile = exportFeeCsvFile;

/**
 * Helper to write raw CSV content string directly to a file on disk.
 */
export function writeFeeCsvToFile(
  filePath: string,
  csvContent: string,
  encoding: BufferEncoding = "utf-8"
): FeeCsvFileOutcome {
  return exportFeeCsvFile(filePath, csvContent, { encoding });
}

/**
 * Parse a CSV formatting block back into validated fee deduction records.
 */
export function parseFeeCsvBlock(
  csvContent: string,
  options?: { delimiter?: string }
): FeeCsvParseOutcome {
  if (typeof csvContent !== "string") {
    return {
      ok: false,
      error: "csvContent must be a string",
      code: FEE_ERROR_CODES.INVALID_INPUT,
    };
  }

  const delimiter = options?.delimiter ?? ",";
  const rows = splitCsvRows(csvContent);
  if (rows.length === 0) {
    return { ok: true, records: [], rowCount: 0 };
  }

  const headerFields = parseCsvLine(rows[0], delimiter).map((h) => h.trim());
  const records: ValidatedFeeRow[] = [];

  for (let r = 1; r < rows.length; r++) {
    const fields = parseCsvLine(rows[r], delimiter);
    const rowObj: FeeDeductionRecord = {
      grossAmount: "0",
      feeRate: "0",
    };

    for (let c = 0; c < headerFields.length; c++) {
      const header = headerFields[c];
      const val = fields[c] ?? "";

      if (header === "grossAmount") {
        if (val !== "") rowObj.grossAmount = val;
      } else if (header === "feeRate") {
        if (val !== "") rowObj.feeRate = val;
      } else if (header === "scale") {
        if (val !== "") rowObj.scale = val;
      } else if (header === "label") {
        if (val !== "") rowObj.label = val;
      } else if (
        header === "feeAmount" ||
        header === "netAmount" ||
        header === "remainder"
      ) {
        continue;
      } else {
        rowObj[header] = val;
      }
    }

    const check = validateFeeDeductionRecord(rowObj, r - 1);
    if (!check.ok) {
      return check;
    }
    records.push(check.value);
  }

  return { ok: true, records, rowCount: records.length };
}

/**
 * Read and deserialize a CSV file from disk into fee deduction records.
 */
export function readFeeCsvFromFile(
  filePath: string,
  options?: { encoding?: BufferEncoding; delimiter?: string }
): FeeCsvParseOutcome {
  if (!filePath || typeof filePath !== "string") {
    return {
      ok: false,
      error: "filePath must be a non-empty string",
      code: FEE_ERROR_CODES.INVALID_INPUT,
    };
  }

  try {
    const content = readCsvFile(filePath, options?.encoding ?? "utf-8");
    return parseFeeCsvBlock(content, { delimiter: options?.delimiter });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Failed to read CSV file: ${errorMsg}`,
      code: FEE_ERROR_CODES.FILE_READ_ERROR,
    };
  }
}

// ---------------------------------------------------------------------------
// Partial payment allocator serializers
// ---------------------------------------------------------------------------

// Error codes for serialization operations
const CSV_SERIALIZATION_ERRORS = {
  INVALID_ALLOCATION: "CSV_INVALID_ALLOCATION",
  EMPTY_ROWS: "CSV_EMPTY_ROWS",
  ESCAPE_FAILURE: "CSV_ESCAPE_FAILURE",
  INVALID_FORMAT: "CSV_INVALID_FORMAT",
  ENCODING_ERROR: "CSV_ENCODING_ERROR",
};

/**
 * Escape a CSV field value (comma-delimited).
 *
 * @deprecated Use `escapeCsvField`; kept as an alias for existing callers.
 */
export function escapeCSVField(value: string | number | bigint): string {
  // Formula-injection guard (#633): only strings can carry a leading
  // =, +, -, @, tab or CR. Numbers and bigints (including negatives) are
  // left unchanged.
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(value)) {
    value = `'${value}`;
  }
  return escapeCsvField(value);
}

/**
 * Format a date/timestamp for CSV output.
 * Converts milliseconds since epoch to ISO 8601 format.
 *
 * @param timestamp - Milliseconds since epoch
 * @returns ISO 8601 formatted date string
 *
 * @example
 * ```typescript
 * formatCSVTimestamp(1695000000000) // => "2023-09-18T00:40:00.000Z"
 * ```
 */
export function formatCSVTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

/**
 * Serialize formatted payment rows to CSV format.
 *
 * Output format (with headers):
 * ```
 * milestone_index,total_amount,amount,recipient,processed_at,precision_preserved
 * 0,1000000,500000,address1,2023-09-18T00:40:00.000Z,true
 * 0,1000000,500000,address2,2023-09-18T00:40:00.000Z,true
 * ```
 *
 * @param rows - Array of FormattedPaymentRow to serialize
 * @param includeHeaders - Whether to include CSV headers (default: true)
 * @param includeTimestamps - Whether to format timestamps to ISO 8601 (default: true)
 * @returns CSV string representation of rows
 *
 * @throws Error if rows array is empty
 *
 * @example
 * ```typescript
 * const rows: FormattedPaymentRow[] = [...];
 * const csv = serializeFormattedRowsToCSV(rows);
 * fs.writeFileSync('payments.csv', csv);
 * ```
 */
export function serializeFormattedRowsToCSV(
  rows: FormattedPaymentRow[],
  includeHeaders: boolean = true,
  includeTimestamps: boolean = true
): string {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(CSV_SERIALIZATION_ERRORS.EMPTY_ROWS);
  }

  const lines: string[] = [];

  // Add headers if requested
  if (includeHeaders) {
    const headers = [
      "milestone_index",
      "total_amount",
      "amount",
      "recipient",
      "processed_at",
      "precision_preserved",
      "original_value_bigint",
    ];
    lines.push(headers.map(escapeCSVField).join(","));
  }

  // Add data rows
  for (const row of rows) {
    const processedAt = includeTimestamps
      ? formatCSVTimestamp(row.processed_at)
      : row.processed_at;

    const fields = [
      escapeCSVField(row.milestone_index),
      escapeCSVField(row.total_amount),
      escapeCSVField(row.amount),
      escapeCSVField(row.recipient),
      escapeCSVField(processedAt),
      escapeCSVField(String(row.precision_preserved)),
      escapeCSVField(row.original_value_bigint),
    ];

    lines.push(fields.join(","));
  }

  return lines.join("\n");
}

/**
 * Serialize a payment allocation to CSV format.
 *
 * Output format (with headers and summary):
 * ```
 * milestone_index,recipient,amount,formatted_amount
 * 0,address1,500000,500000
 * 0,address2,500000,500000
 * 
 * ===SUMMARY===
 * Milestone Index,Total Amount,Recipients Count,Created At
 * 0,1000000,2,2023-09-18T00:40:00.000Z
 * ```
 *
 * @param allocation - PaymentAllocation to serialize
 * @param includeSummary - Whether to include allocation summary (default: true)
 * @param includeHeaders - Whether to include CSV headers (default: true)
 * @returns CSV string representation of allocation
 *
 * @throws Error if allocation is invalid
 *
 * @example
 * ```typescript
 * const allocation = allocatePayment(...);
 * if (allocation.success) {
 *   const csv = serializeAllocationToCSV(allocation.allocation);
 * }
 * ```
 */
export function serializeAllocationToCSV(
  allocation: PaymentAllocation,
  includeSummary: boolean = true,
  includeHeaders: boolean = true
): string {
  if (!allocation || !Array.isArray(allocation.allocations) || allocation.allocations.length === 0) {
    throw new Error(CSV_SERIALIZATION_ERRORS.INVALID_ALLOCATION);
  }

  const lines: string[] = [];

  // Add headers if requested
  if (includeHeaders) {
    const headers = ["milestone_index", "recipient", "amount", "formatted_amount"];
    lines.push(headers.map(escapeCSVField).join(","));
  }

  // Add allocation rows
  for (const alloc of allocation.allocations) {
    const fields = [
      escapeCSVField(allocation.milestoneIndex),
      escapeCSVField(alloc.recipient),
      escapeCSVField(alloc.amount),
      escapeCSVField(alloc.formattedAmount),
    ];
    lines.push(fields.join(","));
  }

  // Add summary if requested
  if (includeSummary) {
    lines.push(""); // Blank line for readability
    lines.push("===SUMMARY===");
    lines.push(
      [
        escapeCSVField("Milestone Index"),
        escapeCSVField("Total Amount"),
        escapeCSVField("Recipients Count"),
        escapeCSVField("Created At"),
      ].join(",")
    );

    const createdAt = formatCSVTimestamp(allocation.metadata.createdAt);
    lines.push(
      [
        escapeCSVField(allocation.milestoneIndex),
        escapeCSVField(String(allocation.totalAmount)),
        escapeCSVField(allocation.allocations.length),
        escapeCSVField(createdAt),
      ].join(",")
    );
  }

  return lines.join("\n");
}

/**
 * Serialize multiple payment allocations to a combined CSV.
 *
 * Output format:
 * ```
 * allocation_id,milestone_index,recipient,amount,formatted_amount,created_at
 * alloc_001,0,address1,500000,500000,2023-09-18T00:40:00.000Z
 * alloc_001,0,address2,500000,500000,2023-09-18T00:40:00.000Z
 * alloc_002,1,address1,300000,300000,2023-09-18T00:41:00.000Z
 * ...
 * ```
 *
 * @param allocations - Array of allocations with optional IDs
 * @param includeHeaders - Whether to include CSV headers (default: true)
 * @returns CSV string representation of all allocations
 *
 * @throws Error if allocations array is empty
 *
 * @example
 * ```typescript
 * const allocations = [alloc1, alloc2, alloc3];
 * const csv = serializeAllocationsToCSV(allocations);
 * fs.writeFileSync('all_allocations.csv', csv);
 * ```
 */
export function serializeAllocationsToCSV(
  allocations: Array<PaymentAllocation & { id?: string }>,
  includeHeaders: boolean = true
): string {
  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw new Error(CSV_SERIALIZATION_ERRORS.EMPTY_ROWS);
  }

  const lines: string[] = [];

  // Add headers if requested
  if (includeHeaders) {
    const headers = [
      "allocation_id",
      "milestone_index",
      "recipient",
      "amount",
      "formatted_amount",
      "created_at",
    ];
    lines.push(headers.map(escapeCSVField).join(","));
  }

  // Add rows from all allocations
  for (let idx = 0; idx < allocations.length; idx++) {
    const allocation = allocations[idx];
    const allocationId = allocation.id || `alloc_${String(idx).padStart(3, "0")}`;
    const createdAt = formatCSVTimestamp(allocation.metadata.createdAt);

    for (const alloc of allocation.allocations) {
      const fields = [
        escapeCSVField(allocationId),
        escapeCSVField(allocation.milestoneIndex),
        escapeCSVField(alloc.recipient),
        escapeCSVField(alloc.amount),
        escapeCSVField(alloc.formattedAmount),
        escapeCSVField(createdAt),
      ];
      lines.push(fields.join(","));
    }
  }

  return lines.join("\n");
}

/**
 * Create a summary report CSV of payment allocations.
 *
 * Output format:
 * ```
 * allocation_id,milestone_index,recipient_count,total_amount,status,created_at
 * alloc_001,0,2,1000000,pending,2023-09-18T00:40:00.000Z
 * alloc_002,1,3,500000,processed,2023-09-18T00:41:00.000Z
 * ```
 *
 * @param allocations - Array of allocations with optional IDs
 * @param includeHeaders - Whether to include CSV headers (default: true)
 * @returns CSV string representation of allocation summaries
 *
 * @throws Error if allocations array is empty
 *
 * @example
 * ```typescript
 * const summary = createAllocationSummaryCSV([alloc1, alloc2]);
 * fs.writeFileSync('allocation_summary.csv', summary);
 * ```
 */
export function createAllocationSummaryCSV(
  allocations: Array<PaymentAllocation & { id?: string }>,
  includeHeaders: boolean = true
): string {
  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw new Error(CSV_SERIALIZATION_ERRORS.EMPTY_ROWS);
  }

  const lines: string[] = [];

  // Add headers if requested
  if (includeHeaders) {
    const headers = [
      "allocation_id",
      "milestone_index",
      "recipient_count",
      "total_amount",
      "status",
      "created_at",
    ];
    lines.push(headers.map(escapeCSVField).join(","));
  }

  // Add summary rows
  for (let idx = 0; idx < allocations.length; idx++) {
    const allocation = allocations[idx];
    const allocationId = allocation.id || `alloc_${String(idx).padStart(3, "0")}`;
    const createdAt = formatCSVTimestamp(allocation.metadata.createdAt);

    const fields = [
      escapeCSVField(allocationId),
      escapeCSVField(allocation.milestoneIndex),
      escapeCSVField(allocation.allocations.length),
      escapeCSVField(String(allocation.totalAmount)),
      escapeCSVField(allocation.metadata.status),
      escapeCSVField(createdAt),
    ];
    lines.push(fields.join(","));
  }

  return lines.join("\n");
}

/**
 * Validate CSV output structure by parsing and verifying row counts.
 *
 * @param csvContent - CSV string to validate
 * @param expectedRowCount - Expected number of data rows (excluding headers)
 * @returns Object with validation result and details
 *
 * @example
 * ```typescript
 * const csv = serializeFormattedRowsToCSV(rows);
 * const validation = validateCSVOutput(csv, rows.length);
 * if (!validation.valid) {
 *   console.error('CSV validation failed:', validation.error);
 * }
 * ```
 */
export function validateCSVOutput(
  csvContent: string,
  expectedRowCount?: number
): {
  valid: boolean;
  rowCount: number;
  error?: string;
  hasHeaders: boolean;
} {
  try {
    const lines = csvContent.split("\n").filter((line) => line.trim().length > 0);

    if (lines.length === 0) {
      return {
        valid: false,
        rowCount: 0,
        error: "CSV is empty",
        hasHeaders: false,
      };
    }

    // The first line is a header row when none of its cells is numeric:
    // every data row carries at least one amount, header rows carry none.
    const firstLine = lines[0];
    const firstCells = firstLine.split(",").map((cell) => cell.trim());
    const hasHeaders = firstCells.every(
      (cell) => cell.length > 0 && !/^-?\d+(\.\d+)?$/.test(cell)
    );

    const dataRowCount = hasHeaders ? lines.length - 1 : lines.length;

    if (expectedRowCount !== undefined && dataRowCount !== expectedRowCount) {
      return {
        valid: false,
        rowCount: dataRowCount,
        error: `Expected ${expectedRowCount} rows but found ${dataRowCount}`,
        hasHeaders,
      };
    }

    return {
      valid: true,
      rowCount: dataRowCount,
      hasHeaders,
    };
  } catch (error) {
    return {
      valid: false,
      rowCount: 0,
      error: error instanceof Error ? error.message : "Validation error",
      hasHeaders: false,
    };
  }
}

/**
 * Parse CSV content back into rows for verification/import.
 * Does NOT fully handle RFC 4180, but handles common cases with escaped fields.
 *
 * @param csvContent - CSV string to parse
 * @param skipHeaders - Whether to skip the first line (default: true)
 * @returns Array of row arrays
 *
 * @example
 * ```typescript
 * const csv = serializeFormattedRowsToCSV(rows);
 * const parsed = parseCSVContent(csv, true);
 * for (const row of parsed) {
 *   console.log(row); // ['0', '1000000', '500000', 'address1', ...]
 * }
 * ```
 */
export function parseCSVContent(
  csvContent: string,
  skipHeaders: boolean = true
): string[][] {
  const lines = csvContent.split("\n").filter((line) => line.trim().length > 0);
  const startIndex = skipHeaders && lines.length > 0 ? 1 : 0;
  const result: string[][] = [];

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];

    // Handle CSV parsing with quoted fields
    const row: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      const nextChar = line[j + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          // Escaped quote
          current += '"';
          j++; // Skip next quote
        } else {
          // Toggle quote state
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        // End of field
        row.push(current);
        current = "";
      } else {
        current += char;
      }
    }

    // Add final field
    if (current || line.endsWith(",")) {
      row.push(current);
    }

    result.push(row);
  }

  return result;
}

/**
 * Generate a CSV report with statistics about payment allocations.
 *
 * @param allocations - Array of allocations to analyze
 * @returns CSV string with statistical summary
 *
 * @example
 * ```typescript
 * const report = generateAllocationStatisticsCSV([alloc1, alloc2, alloc3]);
 * console.log(report);
 * // Metric,Value
 * // Total Allocations,3
 * // Total Recipients,8
 * // Total Amount Allocated,2500000
 * ```
 */
export function generateAllocationStatisticsCSV(
  allocations: PaymentAllocation[]
): string {
  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw new Error(CSV_SERIALIZATION_ERRORS.EMPTY_ROWS);
  }

  let totalRecipients = 0;
  let totalAmount = 0n;

  for (const allocation of allocations) {
    totalRecipients += allocation.allocations.length;
    totalAmount += allocation.totalAmount;
  }

  const lines = [
    "Metric,Value",
    `Total Allocations,${allocations.length}`,
    `Total Recipients,${totalRecipients}`,
    `Total Amount Allocated,${String(totalAmount)}`,
    `Average Recipients per Allocation,${(totalRecipients / allocations.length).toFixed(2)}`,
    `Average Amount per Allocation,${String(totalAmount / BigInt(allocations.length))}`,
  ];

  return lines.join("\n");
}

export const CSVSERIALIZER_ERRORS = CSV_SERIALIZATION_ERRORS;
