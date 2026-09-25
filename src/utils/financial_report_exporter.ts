/**
 * Financial report spreadsheet writer / exporter with overflow / digit-limit
 * validation, negative parameter rejection, and structured spreadsheet/CSV generation.
 *
 * Rejects negative amounts and invalid parameters supplied to the exporter.
 */

import {
  digitCount,
  parseIntegerInput,
  MAX_SAFE_DIGITS,
} from "./digit-limit-validator.js";

export { MAX_SAFE_DIGITS };

export enum FinancialReportExporterError {
  NEGATIVE_PARAMETER = "NEGATIVE_PARAMETER",
  INVALID_PARAMETER = "INVALID_PARAMETER",
  OVERFLOW_EXCESSIVE_DIGITS = "OVERFLOW_EXCESSIVE_DIGITS",
  EMPTY_DATA = "EMPTY_DATA",
  INVALID_ROW = "INVALID_ROW",
}

export const ERROR_CODES = {
  NEGATIVE_PARAMETER: "NEGATIVE_PARAMETER",
  INVALID_PARAMETER: "INVALID_PARAMETER",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  EXCESSIVE_DIGITS: "OVERFLOW_EXCESSIVE_DIGITS",
  OVERFLOW_EXCESSIVE_DIGITS: "OVERFLOW_EXCESSIVE_DIGITS",
  EMPTY_DATA: "EMPTY_DATA",
  INVALID_ROW: "INVALID_ROW",
} as const;

export type FinancialReportErrorCode =
  | (typeof ERROR_CODES)[keyof typeof ERROR_CODES]
  | FinancialReportExporterError;

export class FinancialReportExporterErrorException extends Error {
  public readonly code: FinancialReportErrorCode;

  constructor(code: FinancialReportErrorCode, message: string) {
    super(message);
    this.name = "FinancialReportExporterErrorException";
    this.code = code;
  }
}

export type ValidationResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: FinancialReportErrorCode };

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
        code: ERROR_CODES.NEGATIVE_PARAMETER,
      };
    }
    const raw = value.toString();
    if (digitCount(raw) > MAX_SAFE_DIGITS) {
      return {
        ok: false,
        error: `Parameter "${name}" exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
        code: ERROR_CODES.EXCESSIVE_DIGITS,
      };
    }
    return { ok: true, value };
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || Number.isNaN(value)) {
      return {
        ok: false,
        error: `Parameter "${name}" must be a valid finite number`,
        code: ERROR_CODES.INVALID_PARAMETER,
      };
    }
    if (value < 0 || Object.is(value, -0)) {
      return {
        ok: false,
        error: `Parameter "${name}" must not be negative`,
        code: ERROR_CODES.NEGATIVE_PARAMETER,
      };
    }
    if (!Number.isInteger(value)) {
      // Human decimal representation: check digit count
      const raw = String(value).replace(".", "");
      if (digitCount(raw) > MAX_SAFE_DIGITS) {
        return {
          ok: false,
          error: `Parameter "${name}" exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
          code: ERROR_CODES.EXCESSIVE_DIGITS,
        };
      }
      return { ok: true, value: BigInt(Math.round(value)) };
    }
    const raw = String(value);
    if (digitCount(raw) > MAX_SAFE_DIGITS) {
      return {
        ok: false,
        error: `Parameter "${name}" exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
        code: ERROR_CODES.EXCESSIVE_DIGITS,
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
        code: ERROR_CODES.NEGATIVE_PARAMETER,
      };
    }
    return parseIntegerInput(
      trimmed,
      name,
      ERROR_CODES.INVALID_PARAMETER,
      ERROR_CODES.EXCESSIVE_DIGITS
    );
  }

  return {
    ok: false,
    error: `Parameter "${name}" must be a string, number, or bigint`,
    code: ERROR_CODES.INVALID_PARAMETER,
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
      ERROR_CODES.INVALID_PARAMETER,
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
        ERROR_CODES.INVALID_PARAMETER,
        'Parameter "entries" must be an array'
      );
    }
    for (let i = 0; i < params.entries.length; i++) {
      const entry = params.entries[i];
      if (!entry || typeof entry !== "object") {
        throw new FinancialReportExporterErrorException(
          ERROR_CODES.INVALID_ROW,
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
): { ok: true; data: string; rowCount: number } | { ok: false; error: string; code: FinancialReportErrorCode } {
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
