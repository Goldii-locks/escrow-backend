/**
 * CSV Serialization Helpers for Partial Payment Allocator
 *
 * This module provides functions to serialize payment allocations and formatted
 * payment rows into CSV format for file export, logging, and data interchange.
 *
 * Features:
 * - Escape special CSV characters (commas, quotes, newlines)
 * - Support for multiple output formats (minimal, detailed, full)
 * - Include headers, footers, and summaries
 * - Handle large datasets with streaming-friendly output
 * - Validate CSV output structure
 */

import type { PaymentAllocation, FormattedPaymentRow } from "./partial-payment-allocator.js";

// Error codes for serialization operations
const CSV_SERIALIZATION_ERRORS = {
  INVALID_ALLOCATION: "CSV_INVALID_ALLOCATION",
  EMPTY_ROWS: "CSV_EMPTY_ROWS",
  ESCAPE_FAILURE: "CSV_ESCAPE_FAILURE",
  INVALID_FORMAT: "CSV_INVALID_FORMAT",
  ENCODING_ERROR: "CSV_ENCODING_ERROR",
};

/**
 * Escape a CSV field value to handle special characters.
 * If the field contains comma, quote, or newline, wrap in quotes and escape internal quotes.
 *
 * @param value - The value to escape
 * @returns Escaped value safe for CSV output
 *
 * @example
 * ```typescript
 * escapeCSVField("hello, world") // => '"hello, world"'
 * escapeCSVField('say "hi"')     // => '"say ""hi"""'
 * ```
 */
export function escapeCSVField(value: string | number | bigint): string {
  const strValue = String(value);
  
  // Check if escaping is needed
  if (strValue.includes(",") || strValue.includes('"') || strValue.includes("\n")) {
    // Escape internal quotes by doubling them
    const escaped = strValue.replace(/"/g, '""');
    return `"${escaped}"`;
  }
  
  return strValue;
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

    // Check if first line looks like headers (contains non-numeric, non-address values)
    const firstLine = lines[0];
    const hasHeaders = firstLine.toLowerCase().includes("_") || firstLine.includes("index");

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
