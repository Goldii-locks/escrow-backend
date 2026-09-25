import fs from "fs";
import path from "path";

/**
 * Fee deduction calculator and fee share calculation checker with
 * overflow / digit-limit validation.
 *
 * Rejects inputs whose digit count or intermediate calculation products
 * would risk unsafe numeric overflow during multiplication and division.
 */

/** Max decimal digits allowed for a single amount/variable (below Number.MAX_SAFE_INTEGER). */
export const MAX_SAFE_DIGITS = 15;

/** Max decimal digits allowed for an intermediate multiplication product before it is divided. */
export const MAX_INTERMEDIATE_DIGITS = MAX_SAFE_DIGITS * 2;

/** Default basis points scale (10,000 bps = 100%, 100 bps = 1%). */
export const DEFAULT_FEE_SCALE = 10_000;

/** Scaling factor used to convert floating-point share weights into integer numerators. */
const SHARE_SCALE = 1_000_000;

export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "FEE_CALCULATOR_EXCESSIVE_DIGITS",
  INVALID_AMOUNT: "FEE_CALCULATOR_INVALID_AMOUNT",
  INVALID_FEE_RATE: "FEE_CALCULATOR_INVALID_FEE_RATE",
  INVALID_SHARES: "FEE_CALCULATOR_INVALID_SHARES",
  CALCULATION_OVERFLOW: "FEE_CALCULATOR_OVERFLOW",
  FEE_EXCEEDS_AMOUNT: "FEE_CALCULATOR_FEE_EXCEEDS_AMOUNT",
  INVALID_INPUT: "FEE_CALCULATOR_INVALID_INPUT",
  INVALID_ROW: "FEE_CALCULATOR_INVALID_ROW",
  EMPTY_DATA: "FEE_CALCULATOR_EMPTY_DATA",
  SERIALIZATION_ERROR: "FEE_CALCULATOR_SERIALIZATION_ERROR",
  FILE_WRITE_ERROR: "FEE_CALCULATOR_FILE_WRITE_ERROR",
  FILE_READ_ERROR: "FEE_CALCULATOR_FILE_READ_ERROR",
  // Compatibility aliases
  OVERFLOW_EXCESSIVE_DIGITS: "OVERFLOW_EXCESSIVE_DIGITS",
  OVERFLOW_INVALID_AMOUNT: "OVERFLOW_INVALID_AMOUNT",
  PRODUCT_OVERFLOW: "OVERFLOW_PRODUCT_EXCEEDED",
} as const;

export type FeeCalculatorErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ValidationResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: FeeCalculatorErrorCode };

export type FeeDeductionOutcome =
  | {
      ok: true;
      grossAmount: bigint;
      feeAmount: bigint;
      netAmount: bigint;
      remainder: bigint;
    }
  | { ok: false; error: string; code: FeeCalculatorErrorCode };

export type FeeShareOutcome =
  | {
      ok: true;
      feeShares: bigint[];
      remainder: bigint;
      totalFee: bigint;
    }
  | { ok: false; error: string; code: FeeCalculatorErrorCode };

export type FeeShareDeductionOutcome =
  | {
      ok: true;
      grossAmount: bigint;
      feeShares: bigint[];
      totalFee: bigint;
      netAmount: bigint;
      remainder: bigint;
    }
  | { ok: false; error: string; code: FeeCalculatorErrorCode };

export type FeeShareCheckOutcome =
  | {
      ok: true;
      grossAmount: bigint;
      totalFee: bigint;
      netAmount: bigint;
      isValid: boolean;
    }
  | { ok: false; error: string; code: FeeCalculatorErrorCode };

function digitCount(normalized: string): number {
  const digits = normalized.replace(/^-/, "").replace(/^0+(?=\d)/, "");
  return digits.length === 0 ? 1 : digits.length;
}

/**
 * Parse and validate an amount string/number/bigint against digit limits.
 */
export function validateAmount(
  input: string | number | bigint,
  label = "amount"
): ValidationResult {
  let raw: string;

  if (typeof input === "bigint") {
    raw = input.toString();
  } else if (typeof input === "number") {
    if (!Number.isFinite(input) || !Number.isInteger(input)) {
      return {
        ok: false,
        error: `${label} must be a finite integer`,
        code: ERROR_CODES.INVALID_AMOUNT,
      };
    }
    raw = String(input);
  } else {
    raw = input.trim();
    if (!/^-?\d+$/.test(raw)) {
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
 * Validate a fee amount input against digit limits.
 */
export function validateFeeAmount(
  input: string | number | bigint,
  label = "feeAmount"
): ValidationResult {
  return validateAmount(input, label);
}

/**
 * Validate a fee rate (e.g. basis points or scaled percent) against digit limits.
 */
export function validateFeeRate(
  input: string | number | bigint,
  label = "feeRate"
): ValidationResult {
  let raw: string;

  if (typeof input === "bigint") {
    raw = input.toString();
  } else if (typeof input === "number") {
    if (!Number.isFinite(input) || !Number.isInteger(input)) {
      return {
        ok: false,
        error: `${label} must be a finite integer`,
        code: ERROR_CODES.INVALID_FEE_RATE,
      };
    }
    raw = String(input);
  } else {
    raw = input.trim();
    if (!/^-?\d+$/.test(raw)) {
      return {
        ok: false,
        error: `${label} must be an integer numeric value`,
        code: ERROR_CODES.INVALID_FEE_RATE,
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

  const val = BigInt(raw);
  if (val < 0n) {
    return {
      ok: false,
      error: `${label} must be non-negative`,
      code: ERROR_CODES.INVALID_FEE_RATE,
    };
  }

  return { ok: true, value: val };
}

/**
 * Validate the shares array used to weight fee distributions. Every share
 * must be a positive, finite number.
 */
export function validateFeeShares(
  shares: number[]
): { ok: true } | { ok: false; error: string; code: FeeCalculatorErrorCode } {
  if (!Array.isArray(shares) || shares.length === 0) {
    return {
      ok: false,
      error: "shares must be a non-empty array",
      code: ERROR_CODES.INVALID_SHARES,
    };
  }

  for (let i = 0; i < shares.length; i++) {
    const share = shares[i];
    if (
      typeof share !== "number" ||
      !Number.isFinite(share) ||
      share <= 0
    ) {
      return {
        ok: false,
        error: `shares[${i}] must be a positive finite number`,
        code: ERROR_CODES.INVALID_SHARES,
      };
    }
  }

  return { ok: true };
}

/**
 * Calculate fee deduction from gross amount using a fee rate and scaling basis.
 * Blocks intermediate multiplications that would exceed MAX_INTERMEDIATE_DIGITS.
 */
export function calculateFeeDeduction(
  grossAmount: string | number | bigint,
  feeRate: string | number | bigint,
  scale: string | number | bigint = DEFAULT_FEE_SCALE
): FeeDeductionOutcome {
  const grossCheck = validateAmount(grossAmount, "grossAmount");
  if (!grossCheck.ok) {
    return grossCheck;
  }

  const rateCheck = validateFeeRate(feeRate, "feeRate");
  if (!rateCheck.ok) {
    return rateCheck;
  }

  const scaleCheck = validateAmount(scale, "scale");
  if (!scaleCheck.ok) {
    return scaleCheck;
  }
  if (scaleCheck.value <= 0n) {
    return {
      ok: false,
      error: "scale must be a positive integer",
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  const gross = grossCheck.value;
  const rate = rateCheck.value;
  const sc = scaleCheck.value;

  if (gross < 0n) {
    return {
      ok: false,
      error: "grossAmount must be non-negative",
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  const product = gross * rate;
  if (digitCount(product.toString()) > MAX_INTERMEDIATE_DIGITS) {
    return {
      ok: false,
      error: "fee calculation would overflow during multiplication",
      code: ERROR_CODES.CALCULATION_OVERFLOW,
    };
  }

  const feeAmount = product / sc;
  if (feeAmount > gross) {
    return {
      ok: false,
      error: "fee exceeds gross amount",
      code: ERROR_CODES.FEE_EXCEEDS_AMOUNT,
    };
  }

  const netAmount = gross - feeAmount;
  const remainder = product % sc;

  return {
    ok: true,
    grossAmount: gross,
    feeAmount,
    netAmount,
    remainder,
  };
}

/**
 * Split a total fee amount across multiple fee shares (weights),
 * using scaled integer arithmetic with overflow validation and remainder tracking.
 */
export function calculateFeeShares(
  totalFee: string | number | bigint,
  shares: number[]
): FeeShareOutcome {
  const totalCheck = validateAmount(totalFee, "totalFee");
  if (!totalCheck.ok) {
    return totalCheck;
  }

  const sharesCheck = validateFeeShares(shares);
  if (!sharesCheck.ok) {
    return sharesCheck;
  }

  const total = totalCheck.value;
  if (total < 0n) {
    return {
      ok: false,
      error: "totalFee must be non-negative",
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  const scaledNumerators = shares.map((s) => BigInt(Math.round(s * SHARE_SCALE)));
  const scaledDenominator = scaledNumerators.reduce((acc, n) => acc + n, 0n);

  if (scaledDenominator <= 0n) {
    return {
      ok: false,
      error: "shares must sum to a positive value",
      code: ERROR_CODES.INVALID_SHARES,
    };
  }

  const feeShares: bigint[] = [];
  let allocatedSum = 0n;

  for (let i = 0; i < scaledNumerators.length; i++) {
    const numerator = scaledNumerators[i];
    const product = total * numerator;

    if (digitCount(product.toString()) > MAX_INTERMEDIATE_DIGITS) {
      return {
        ok: false,
        error: `fee share calculation for shares[${i}] would overflow during multiplication`,
        code: ERROR_CODES.CALCULATION_OVERFLOW,
      };
    }

    const shareAmount = product / scaledDenominator;
    feeShares.push(shareAmount);
    allocatedSum += shareAmount;
  }

  const remainder = total - allocatedSum;

  return {
    ok: true,
    feeShares,
    remainder,
    totalFee: total,
  };
}

/**
 * Calculate individual fee shares and deduce them from gross amount,
 * checking that total deducted fees do not overflow or exceed gross amount.
 */
export function calculateFeeShareDeductions(
  grossAmount: string | number | bigint,
  shares: number[]
): FeeShareDeductionOutcome {
  const grossCheck = validateAmount(grossAmount, "grossAmount");
  if (!grossCheck.ok) {
    return grossCheck;
  }

  const sharesCheck = validateFeeShares(shares);
  if (!sharesCheck.ok) {
    return sharesCheck;
  }

  const gross = grossCheck.value;
  if (gross < 0n) {
    return {
      ok: false,
      error: "grossAmount must be non-negative",
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  const scaledNumerators = shares.map((s) => BigInt(Math.round(s * SHARE_SCALE)));
  const scaledDenominator = scaledNumerators.reduce((acc, n) => acc + n, 0n);

  if (scaledDenominator <= 0n) {
    return {
      ok: false,
      error: "shares must sum to a positive value",
      code: ERROR_CODES.INVALID_SHARES,
    };
  }

  const feeShares: bigint[] = [];
  let totalFee = 0n;

  for (let i = 0; i < scaledNumerators.length; i++) {
    const numerator = scaledNumerators[i];
    const product = gross * numerator;

    if (digitCount(product.toString()) > MAX_INTERMEDIATE_DIGITS) {
      return {
        ok: false,
        error: `fee share deduction for shares[${i}] would overflow during multiplication`,
        code: ERROR_CODES.CALCULATION_OVERFLOW,
      };
    }

    const shareAmount = product / scaledDenominator;
    feeShares.push(shareAmount);
    totalFee += shareAmount;
  }

  if (totalFee > gross) {
    return {
      ok: false,
      error: "total fee deductions exceed gross amount",
      code: ERROR_CODES.FEE_EXCEEDS_AMOUNT,
    };
  }

  const remainder = 0n;
  const netAmount = gross - totalFee;

  return {
    ok: true,
    grossAmount: gross,
    feeShares,
    totalFee,
    netAmount,
    remainder,
  };
}

/**
 * Fee share calculation checker:
 * Validates individual fee shares, checks running sum for overflow against
 * MAX_SAFE_DIGITS, ensures total fee does not exceed gross amount,
 * and verifies expected total fee if provided.
 */
export function checkFeeShareCalculation(
  grossAmount: string | number | bigint,
  feeShares: Array<string | number | bigint>,
  expectedTotalFee?: string | number | bigint
): FeeShareCheckOutcome {
  const grossCheck = validateAmount(grossAmount, "grossAmount");
  if (!grossCheck.ok) {
    return grossCheck;
  }

  let totalFee = 0n;

  for (let i = 0; i < feeShares.length; i++) {
    const shareCheck = validateAmount(feeShares[i], `feeShares[${i}]`);
    if (!shareCheck.ok) {
      return shareCheck;
    }

    const next = totalFee + shareCheck.value;
    if (digitCount(next.toString()) > MAX_SAFE_DIGITS) {
      return {
        ok: false,
        error: `total fee sum exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
        code: ERROR_CODES.CALCULATION_OVERFLOW,
      };
    }
    totalFee = next;
  }

  const gross = grossCheck.value;
  if (totalFee > gross) {
    return {
      ok: false,
      error: "total fee shares exceed gross amount",
      code: ERROR_CODES.FEE_EXCEEDS_AMOUNT,
    };
  }

  let isValid = true;
  if (expectedTotalFee !== undefined) {
    const expectedCheck = validateAmount(expectedTotalFee, "expectedTotalFee");
    if (!expectedCheck.ok) {
      return expectedCheck;
    }
    isValid = totalFee === expectedCheck.value;
  }

  const netAmount = gross - totalFee;

  return {
    ok: true,
    grossAmount: gross,
    totalFee,
    netAmount,
    isValid,
  };
}

// ---------------------------------------------------------------------------
// Round-half-to-even fee deduction (#430)
// ---------------------------------------------------------------------------
//
// calculateFeeDeduction() above truncates the fractional part and hands the
// caller the leftover in `remainder`, which suits callers that distribute the
// dust themselves. The variant below instead folds the fraction into the fee
// using banker's rounding, so `feeAmount + netAmount` always reconstructs the
// base amount exactly and repeated application of the same rate does not bias
// the total consistently up or down.

/** Basis-points denominator (10000 bps = 100%). */
const BPS_DENOMINATOR = 10_000n;

export type FeeDeductionHalfEvenOutcome =
  | { ok: true; feeAmount: bigint; netAmount: bigint }
  | { ok: false; error: string; code: FeeCalculatorErrorCode };

/**
 * Parse and validate a non-negative base amount against digit limits.
 */
export function validateBaseAmount(
  input: string | number | bigint,
  label = "baseAmount"
): ValidationResult {
  let raw: string;

  if (typeof input === "bigint") {
    raw = input.toString();
  } else if (typeof input === "number") {
    if (!Number.isFinite(input) || !Number.isInteger(input)) {
      return {
        ok: false,
        error: `${label} must be a finite integer`,
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
    if (!/^\d+$/.test(raw)) {
      return {
        ok: false,
        error: `${label} must be a non-negative integer numeric value`,
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

  const value = BigInt(raw);
  if (value < 0n) {
    return {
      ok: false,
      error: `${label} must be a non-negative integer`,
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  return { ok: true, value };
}

/**
 * Validate a fee rate expressed in basis points (0-10000, i.e. 0%-100%).
 */
export function validateFeeRateBps(feeRateBps: number): ValidationResult {
  if (
    typeof feeRateBps !== "number" ||
    !Number.isFinite(feeRateBps) ||
    !Number.isInteger(feeRateBps)
  ) {
    return {
      ok: false,
      error: "feeRateBps must be a finite integer",
      code: ERROR_CODES.INVALID_FEE_RATE,
    };
  }

  if (feeRateBps < 0 || feeRateBps > 10_000) {
    return {
      ok: false,
      error: "feeRateBps must be between 0 and 10000",
      code: ERROR_CODES.INVALID_FEE_RATE,
    };
  }

  return { ok: true, value: BigInt(feeRateBps) };
}

/**
 * Deduct a fee (in basis points) from a base amount, rounding the fractional
 * remainder to the nearest even value instead of always truncating or always
 * rounding up. This avoids a one-directional rounding bias when the same
 * rate is applied repeatedly across many transactions, while feeAmount and
 * netAmount always sum back to baseAmount exactly.
 */
export function calculateFeeDeductionHalfEven(
  baseAmount: string | number | bigint,
  feeRateBps: number
): FeeDeductionHalfEvenOutcome {
  const base = validateBaseAmount(baseAmount);
  if (!base.ok) {
    return base;
  }

  const rate = validateFeeRateBps(feeRateBps);
  if (!rate.ok) {
    return rate;
  }

  const numerator = base.value * rate.value;
  const quotient = numerator / BPS_DENOMINATOR;
  const remainder = numerator % BPS_DENOMINATOR;

  let feeAmount = quotient;
  const twiceRemainder = remainder * 2n;
  if (twiceRemainder > BPS_DENOMINATOR) {
    feeAmount += 1n;
  } else if (twiceRemainder === BPS_DENOMINATOR && quotient % 2n !== 0n) {
    feeAmount += 1n;
  }

  const netAmount = base.value - feeAmount;

  return { ok: true, feeAmount, netAmount };
}

// ---------------------------------------------------------------------------
// CSV format exporters / file serialization (#435)
// ---------------------------------------------------------------------------
//
// File serialization helpers that build CSV formatting blocks (tables) from
// fee deduction records. Each record is validated step-by-step through
// calculateFeeDeduction() so overflow / digit-limit violations fail fast
// before any table output is produced.

/**
 * Input record representing a fee deduction entry for serialization / export.
 */
export interface FeeDeductionRecord {
  label?: string;
  grossAmount: string | number | bigint;
  feeRate: string | number | bigint;
  scale?: string | number | bigint;
  [key: string]: unknown;
}

/**
 * Resolved and validated fee deduction row used in serialization.
 */
export interface ValidatedFeeRow {
  label?: string;
  grossAmount: bigint;
  feeRate: bigint;
  scale: bigint;
  feeAmount: bigint;
  netAmount: bigint;
  remainder: bigint;
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
      code: FeeCalculatorErrorCode;
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
      code: FeeCalculatorErrorCode;
    };

/**
 * Outcome of CSV deserialization / parsing.
 */
export type CsvParseOutcome =
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
 * Validate a single fee deduction record step-by-step.
 * Resolves grossAmount / feeRate / scale through calculateFeeDeduction()
 * ensuring numerical consistency and adherence to digit limits.
 */
export function validateFeeDeductionRecord(
  record: FeeDeductionRecord,
  index = 0
):
  | { ok: true; value: ValidatedFeeRow }
  | { ok: false; error: string; code: FeeCalculatorErrorCode } {
  if (!record || typeof record !== "object") {
    return {
      ok: false,
      error: `record at index ${index} must be an object`,
      code: ERROR_CODES.INVALID_ROW,
    };
  }

  if (record.grossAmount === undefined) {
    return {
      ok: false,
      error: `record at index ${index} must provide grossAmount`,
      code: ERROR_CODES.INVALID_ROW,
    };
  }

  if (record.feeRate === undefined) {
    return {
      ok: false,
      error: `record at index ${index} must provide feeRate`,
      code: ERROR_CODES.INVALID_ROW,
    };
  }

  const scaleInput = record.scale !== undefined ? record.scale : DEFAULT_FEE_SCALE;
  const computed = calculateFeeDeduction(
    record.grossAmount as string | number | bigint,
    record.feeRate as string | number | bigint,
    scaleInput as string | number | bigint
  );
  if (!computed.ok) {
    return computed;
  }

  const grossCheck = validateAmount(
    record.grossAmount as string | number | bigint,
    `records[${index}].grossAmount`
  );
  if (!grossCheck.ok) {
    return grossCheck;
  }
  const rateCheck = validateFeeRate(
    record.feeRate as string | number | bigint,
    `records[${index}].feeRate`
  );
  if (!rateCheck.ok) {
    return rateCheck;
  }
  const scaleCheck = validateAmount(
    scaleInput as string | number | bigint,
    `records[${index}].scale`
  );
  if (!scaleCheck.ok) {
    return scaleCheck;
  }

  const result: ValidatedFeeRow = {
    grossAmount: computed.grossAmount,
    feeRate: rateCheck.value,
    scale: scaleCheck.value,
    feeAmount: computed.feeAmount,
    netAmount: computed.netAmount,
    remainder: computed.remainder,
  };

  if (typeof record.label === "string") {
    result.label = record.label;
  }

  for (const [k, v] of Object.entries(record)) {
    if (
      k !== "grossAmount" &&
      k !== "feeRate" &&
      k !== "scale" &&
      k !== "label"
    ) {
      result[k] = v;
    }
  }

  return { ok: true, value: result };
}

/**
 * Build a CSV formatting block from an array of fee deduction records.
 * Validates each record against overflow and digit limits, and constructs
 * properly escaped table output rows.
 */
export function buildCsvBlock(
  records: FeeDeductionRecord[],
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
 * Format exporter aliases to buildCsvBlock.
 */
export const exportToCsv = buildCsvBlock;
export const formatToCsv = buildCsvBlock;
export const serializeToCsv = buildCsvBlock;
export const formatFeeTable = buildCsvBlock;
export const formatDeductionTable = buildCsvBlock;

/**
 * Exporter specifically for fee deduction entries, generating CSV output.
 */
export function exportDeductionToCsv(
  entries: FeeDeductionRecord[],
  options?: CsvExportOptions
): CsvFormattingOutcome {
  return buildCsvBlock(entries, options);
}

/**
 * Exporter specifically for fee share style entries (gross + rate pairs).
 */
export function exportFeeToCsv(
  entries: FeeDeductionRecord[],
  options?: CsvExportOptions
): CsvFormattingOutcome {
  return buildCsvBlock(entries, options);
}

/**
 * Serialize fee deduction data or pre-built CSV block to a file on disk.
 * Creates parent directories if they do not exist.
 */
export function exportToCsvFile(
  filePath: string,
  data: FeeDeductionRecord[] | string,
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
      error: "data must be an array of fee deduction records or a CSV string",
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
export const serializeFeeRecordsToFile = exportToCsvFile;

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
 * Parse a CSV formatting block back into validated fee deduction records.
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
