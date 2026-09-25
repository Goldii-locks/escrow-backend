/**
 * Tax deduction estimator and estimated withholding tax generator with
 * overflow / digit-limit validation, path rate limiting, and database precision formatting.
 *
 * Rejects inputs whose digit count or intermediate calculation products
 * would risk unsafe numeric overflow during multiplication and scaling.
 */

/** Max decimal digits allowed for a single amount/variable (below Number.MAX_SAFE_INTEGER). */
export const MAX_SAFE_DIGITS = 15;

/** Max decimal digits allowed for an intermediate multiplication product before it is divided. */
export const MAX_INTERMEDIATE_DIGITS = 28;

/** Default tax rate basis points scale (10,000 bps = 100%, 500 bps = 5%). */
export const DEFAULT_TAX_SCALE = 10_000;

/** Max conversion/estimator calls allowed per rate-limit window before calls are rejected. */
export const RATE_LIMIT_MAX_CALLS = 1000;

/** Rate-limit window size, in milliseconds. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

let rateLimitWindowStart = Date.now();
let rateLimitCallCount = 0;
let customRateLimitMax: number | null = null;

export function resetTaxEstimatorRateLimitBuckets(): void {
  rateLimitWindowStart = Date.now();
  rateLimitCallCount = 0;
  customRateLimitMax = null;
}

export function setTaxEstimatorRateLimitMax(max: number | null): void {
  customRateLimitMax = max;
}

function resolveRateLimitMax(): number {
  if (customRateLimitMax !== null && customRateLimitMax > 0) {
    return customRateLimitMax;
  }
  const configured = Number(process.env.TAX_ESTIMATOR_RATE_MAX ?? RATE_LIMIT_MAX_CALLS);
  return Number.isFinite(configured) && configured > 0 ? configured : RATE_LIMIT_MAX_CALLS;
}

/**
 * Guard against excessive tax deduction estimator call volume within a rolling window.
 * Callers get 429-style rejection semantics when thresholds are exceeded.
 */
export function checkTaxEstimatorRateLimit():
  | { ok: true }
  | { ok: false; error: string; code: TaxEstimatorErrorCode; status: 429 } {
  const now = Date.now();
  if (now - rateLimitWindowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitWindowStart = now;
    rateLimitCallCount = 0;
  }

  rateLimitCallCount += 1;
  const maxCalls = resolveRateLimitMax();

  if (rateLimitCallCount > maxCalls) {
    return {
      ok: false,
      error: `tax_deduction_estimator rate limit exceeded: max ${maxCalls} calls per ${RATE_LIMIT_WINDOW_MS}ms`,
      code: ERROR_CODES.RATE_LIMITED,
      status: 429,
    };
  }

  return { ok: true };
}

export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "TAX_ESTIMATOR_EXCESSIVE_DIGITS",
  INVALID_AMOUNT: "TAX_ESTIMATOR_INVALID_AMOUNT",
  INVALID_TAX_RATE: "TAX_ESTIMATOR_INVALID_TAX_RATE",
  CALCULATION_OVERFLOW: "TAX_ESTIMATOR_OVERFLOW",
  TAX_EXCEEDS_AMOUNT: "TAX_ESTIMATOR_TAX_EXCEEDS_AMOUNT",
  INVALID_SCHEMA: "TAX_ESTIMATOR_INVALID_SCHEMA",
  RATE_LIMITED: "TAX_ESTIMATOR_RATE_LIMITED",
  INVALID_CSV_INPUT: "TAX_ESTIMATOR_INVALID_CSV_INPUT",
  // Compatibility aliases
  OVERFLOW_EXCESSIVE_DIGITS: "OVERFLOW_EXCESSIVE_DIGITS",
  OVERFLOW_INVALID_AMOUNT: "OVERFLOW_INVALID_AMOUNT",
  PRODUCT_OVERFLOW: "OVERFLOW_PRODUCT_EXCEEDED",
} as const;

export type TaxEstimatorErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ValidationResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: TaxEstimatorErrorCode; status?: number };

export type TaxDeductionOutcome =
  | {
      ok: true;
      grossAmount: bigint;
      taxRate: bigint;
      taxAmount: bigint;
      netAmount: bigint;
      remainder: bigint;
      taxScale: bigint;
    }
  | { ok: false; error: string; code: TaxEstimatorErrorCode; status?: number };

/**
 * Configuration options for database precision schema and column mapping.
 */
export interface DbPrecisionSchema {
  /** Column scale (decimal places). Defaults to 7 if not specified. */
  scale?: number;
  /** Maximum safe precision (total digits). Defaults to MAX_SAFE_DIGITS (15). */
  precision?: number;
  /**
   * Whether to format with fixed decimal scale by padding fractional digits
   * with trailing zeroes to match the column scale. Defaults to true.
   */
  fixedScale?: boolean;
  /** Input type: auto, raw, or human. Defaults to "auto". */
  inputType?: "auto" | "raw" | "human";
  /** Custom column names for database storage mapping. */
  columns?: {
    grossAmount?: string;
    taxAmount?: string;
    netAmount?: string;
    taxRate?: string;
    decimals?: string;
  };
}

/**
 * Attributes for a database row storing a calculated tax deduction with full precision.
 */
export interface DbStorageRow {
  gross_amount: string;
  tax_amount: string;
  net_amount: string;
  tax_rate: string;
  formatted_amount: string;
  raw_amount: string;
  scale: number;
  decimals: number;
  grossAmount: string;
  taxAmount: string;
  netAmount: string;
  taxRate: string;
  formattedAmount: string;
  rawAmount: string;
  trimmed_amount: string;
  [key: string]: string | number;
}

export type DbFormatResult =
  | {
      ok: true;
      value: DbStorageRow;
      columns: DbStorageRow;
      row: DbStorageRow;
    }
  | { ok: false; error: string; code: TaxEstimatorErrorCode; status?: number };

function digitCount(normalized: string): number {
  const digits = normalized.replace(/^-/, "").replace(/^0+(?=\d)/, "");
  return digits.length === 0 ? 1 : digits.length;
}

/**
 * Parse and validate an amount string/number/bigint against digit limits.
 */
export function validateTaxAmount(
  input: string | number | bigint,
  label = "grossAmount"
): ValidationResult {
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
 * Validate a tax rate against digit limits.
 */
export function validateTaxRate(
  input: string | number | bigint,
  label = "taxRate"
): ValidationResult {
  let raw: string;

  if (typeof input === "bigint") {
    if (input < 0n) {
      return {
        ok: false,
        error: `${label} cannot be negative`,
        code: ERROR_CODES.INVALID_TAX_RATE,
      };
    }
    raw = input.toString();
  } else if (typeof input === "number") {
    if (!Number.isFinite(input) || !Number.isInteger(input)) {
      return {
        ok: false,
        error: `${label} must be a finite integer`,
        code: ERROR_CODES.INVALID_TAX_RATE,
      };
    }
    if (input < 0 || Object.is(input, -0)) {
      return {
        ok: false,
        error: `${label} cannot be negative`,
        code: ERROR_CODES.INVALID_TAX_RATE,
      };
    }
    raw = String(input);
  } else {
    raw = input.trim();
    if (raw.startsWith("-")) {
      return {
        ok: false,
        error: `${label} cannot be negative`,
        code: ERROR_CODES.INVALID_TAX_RATE,
      };
    }
    if (!/^\d+$/.test(raw)) {
      return {
        ok: false,
        error: `${label} must be an integer numeric value`,
        code: ERROR_CODES.INVALID_TAX_RATE,
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
 * Validate database precision schema parameters.
 */
export function validateDbPrecisionSchema(
  schema: DbPrecisionSchema
): { ok: true } | { ok: false; error: string; code: TaxEstimatorErrorCode } {
  if (schema.scale !== undefined) {
    if (
      typeof schema.scale !== "number" ||
      !Number.isFinite(schema.scale) ||
      !Number.isInteger(schema.scale) ||
      schema.scale < 0 ||
      schema.scale > 18
    ) {
      return {
        ok: false,
        error: "schema scale must be an integer between 0 and 18",
        code: ERROR_CODES.INVALID_SCHEMA,
      };
    }
  }

  if (schema.precision !== undefined) {
    if (
      typeof schema.precision !== "number" ||
      !Number.isFinite(schema.precision) ||
      !Number.isInteger(schema.precision) ||
      schema.precision < 1 ||
      schema.precision > MAX_SAFE_DIGITS
    ) {
      return {
        ok: false,
        error: `schema precision must be an integer between 1 and ${MAX_SAFE_DIGITS}`,
        code: ERROR_CODES.INVALID_SCHEMA,
      };
    }
  }

  return { ok: true };
}

/**
 * Calculate estimated withholding tax deduction for a given gross amount and tax rate.
 * Rejects calls when rate limit is exceeded or inputs overflow limits.
 */
export function calculateTaxDeduction(
  grossAmount: string | number | bigint,
  taxRate: string | number | bigint,
  taxScale: string | number | bigint = DEFAULT_TAX_SCALE
): TaxDeductionOutcome {
  const rateLimitCheck = checkTaxEstimatorRateLimit();
  if (!rateLimitCheck.ok) {
    return rateLimitCheck;
  }

  const grossRes = validateTaxAmount(grossAmount, "grossAmount");
  if (!grossRes.ok) {
    return grossRes;
  }

  const rateRes = validateTaxRate(taxRate, "taxRate");
  if (!rateRes.ok) {
    return rateRes;
  }

  const scaleRes = validateTaxRate(taxScale, "taxScale");
  if (!scaleRes.ok) {
    return scaleRes;
  }

  if (scaleRes.value === 0n) {
    return {
      ok: false,
      error: "taxScale cannot be zero",
      code: ERROR_CODES.INVALID_TAX_RATE,
    };
  }

  const product = grossRes.value * rateRes.value;
  if (digitCount(product.toString()) > MAX_INTERMEDIATE_DIGITS) {
    return {
      ok: false,
      error: `intermediate calculation product exceeds maximum of ${MAX_INTERMEDIATE_DIGITS} digits`,
      code: ERROR_CODES.CALCULATION_OVERFLOW,
    };
  }

  if (rateRes.value > scaleRes.value) {
    return {
      ok: false,
      error: "taxRate cannot exceed taxScale",
      code: ERROR_CODES.TAX_EXCEEDS_AMOUNT,
    };
  }

  const taxAmount = product / scaleRes.value;
  const remainder = product % scaleRes.value;
  const netAmount = grossRes.value - taxAmount;

  if (taxAmount > grossRes.value) {
    return {
      ok: false,
      error: "calculated tax amount exceeds gross amount",
      code: ERROR_CODES.TAX_EXCEEDS_AMOUNT,
    };
  }

  return {
    ok: true,
    grossAmount: grossRes.value,
    taxRate: rateRes.value,
    taxAmount,
    netAmount,
    remainder,
    taxScale: scaleRes.value,
  };
}

/** Alias for calculateTaxDeduction. */
export const estimateTaxDeduction = calculateTaxDeduction;

/**
 * Format string numeric amount into fixed scale representation preserving full precision.
 */
function formatFixedScaleString(rawStr: string, scale: number, fixedScale: boolean): string {
  if (scale === 0) {
    return rawStr;
  }
  const padded = rawStr.padStart(scale + 1, "0");
  const intPart = padded.slice(0, padded.length - scale);
  let fracPart = padded.slice(padded.length - scale);

  if (!fixedScale) {
    fracPart = fracPart.replace(/0+$/, "");
    return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  }
  return `${intPart}.${fracPart}`;
}

/**
 * Format calculated tax deduction values to match database precision schemas.
 * Asserts written row attributes preserve full precision without floating-point loss.
 */
export function formatForDbStorage(
  amount: string | number | bigint | TaxDeductionOutcome,
  taxRate: string | number | bigint = 0,
  scale = 7,
  schema?: DbPrecisionSchema
): DbFormatResult {
  const schemaCheck = schema ? validateDbPrecisionSchema(schema) : { ok: true as const };
  if (!schemaCheck.ok) {
    return schemaCheck;
  }

  const effectiveScale = schema?.scale !== undefined ? schema.scale : scale;
  const fixedScale = schema?.fixedScale ?? true;

  let outcome: TaxDeductionOutcome;

  if (typeof amount === "object" && amount !== null && "ok" in amount) {
    if (!amount.ok) {
      return amount;
    }
    outcome = amount;
  } else {
    outcome = calculateTaxDeduction(amount, taxRate);
    if (!outcome.ok) {
      return outcome;
    }
  }

  const grossStr = outcome.grossAmount.toString();
  const taxStr = outcome.taxAmount.toString();
  const netStr = outcome.netAmount.toString();
  const rateStr = outcome.taxRate.toString();

  const formattedGross = formatFixedScaleString(grossStr, effectiveScale, fixedScale);
  const formattedTax = formatFixedScaleString(taxStr, effectiveScale, fixedScale);
  const formattedNet = formatFixedScaleString(netStr, effectiveScale, fixedScale);
  const trimmedGross = formatFixedScaleString(grossStr, effectiveScale, false);

  const defaultRow: DbStorageRow = {
    gross_amount: formattedGross,
    tax_amount: formattedTax,
    net_amount: formattedNet,
    tax_rate: rateStr,
    formatted_amount: formattedTax,
    raw_amount: taxStr,
    scale: effectiveScale,
    decimals: effectiveScale,
    grossAmount: formattedGross,
    taxAmount: formattedTax,
    netAmount: formattedNet,
    taxRate: rateStr,
    formattedAmount: formattedTax,
    rawAmount: taxStr,
    trimmed_amount: trimmedGross,
  };

  if (schema?.columns) {
    if (schema.columns.grossAmount) {
      defaultRow[schema.columns.grossAmount] = formattedGross;
    }
    if (schema.columns.taxAmount) {
      defaultRow[schema.columns.taxAmount] = formattedTax;
    }
    if (schema.columns.netAmount) {
      defaultRow[schema.columns.netAmount] = formattedNet;
    }
    if (schema.columns.taxRate) {
      defaultRow[schema.columns.taxRate] = rateStr;
    }
    if (schema.columns.decimals) {
      defaultRow[schema.columns.decimals] = effectiveScale;
    }
  }

  return {
    ok: true,
    value: defaultRow,
    columns: defaultRow,
    row: defaultRow,
  };
}

/** Alias for formatForDbStorage. */
export const formatColumnsForDbStorage = formatForDbStorage;
export const formatDbColumns = formatForDbStorage;

export function formatRawForDbStorage(
  rawAmount: string | number | bigint,
  taxRate: string | number | bigint,
  scale = 7,
  schema?: DbPrecisionSchema
): DbFormatResult {
  return formatForDbStorage(rawAmount, taxRate, scale, { ...schema, inputType: "raw" });
}

export function formatHumanForDbStorage(
  humanAmount: string | number,
  taxRate: string | number | bigint,
  scale = 7,
  schema?: DbPrecisionSchema
): DbFormatResult {
  return formatForDbStorage(humanAmount, taxRate, scale, { ...schema, inputType: "human" });
}

export function configureFormatColumns(defaultSchema?: DbPrecisionSchema) {
  return {
    schema: defaultSchema,
    format: (
      amount: string | number | bigint | TaxDeductionOutcome,
      taxRate?: string | number | bigint,
      scale?: number,
      overrideSchema?: DbPrecisionSchema
    ) =>
      formatForDbStorage(
        amount,
        taxRate ?? 0,
        scale ?? defaultSchema?.scale ?? 7,
        { ...defaultSchema, ...overrideSchema }
      ),
    validateSchema: (schema: DbPrecisionSchema) => validateDbPrecisionSchema(schema),
  };
}

/**
 * A single estimator input to be rendered as one CSV table row.
 */
export interface TaxDeductionCsvRecord {
  grossAmount: string | number | bigint;
  taxRate: string | number | bigint;
  taxScale?: string | number | bigint;
  label?: string;
}

/** Columns the tax deduction CSV exporter can emit. */
export const TAX_CSV_COLUMNS = [
  "label",
  "grossAmount",
  "taxRate",
  "taxAmount",
  "netAmount",
  "remainder",
] as const;

export type TaxCsvColumn = (typeof TAX_CSV_COLUMNS)[number];

/**
 * Options configuring tax deduction CSV block formatting.
 */
export interface TaxCsvExportOptions {
  /** Single-character field delimiter. Defaults to ','. */
  delimiter?: string;
  /** Line ending string. Defaults to '\n'. */
  lineEnding?: "\n" | "\r\n";
  /** Whether to emit the header row. Defaults to true. */
  includeHeader?: boolean;
  /** Column keys to export, in order. Defaults to all columns (label only when present). */
  columns?: TaxCsvColumn[];
  /** Custom header labels; must match the column count when provided. */
  headers?: string[];
  /** Decimal scale applied to amount columns (0 = raw integer units). Defaults to 0. */
  scale?: number;
  /** Whether an empty records array is allowed. Defaults to true. */
  allowEmpty?: boolean;
}

export type TaxCsvOutcome =
  | { ok: true; value: string; rowCount: number; columns: TaxCsvColumn[] }
  | { ok: false; error: string; code: TaxEstimatorErrorCode; status?: number };

/**
 * Escape a single CSV field following RFC 4180: fields containing the
 * delimiter, quotes, or line breaks are quoted, with inner quotes doubled.
 */
export function escapeTaxCsvField(value: unknown, delimiter = ","): string {
  if (value === null || value === undefined) {
    return "";
  }
  const str = typeof value === "string" ? value : String(value);
  if (
    str.includes(delimiter) ||
    str.includes('"') ||
    str.includes("\n") ||
    str.includes("\r")
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Format an array of values into a single escaped CSV row.
 */
export function formatTaxCsvRow(values: unknown[], delimiter = ","): string {
  return values.map((v) => escapeTaxCsvField(v, delimiter)).join(delimiter);
}

function csvError(error: string): TaxCsvOutcome {
  return { ok: false, error, code: ERROR_CODES.INVALID_CSV_INPUT };
}

/**
 * Build a CSV formatting block from tax deduction inputs. Each record is run
 * through calculateTaxDeduction, so all digit, overflow, and rate-limit rules
 * apply; the first failing record aborts the export with its error.
 */
export function buildTaxDeductionCsvBlock(
  records: TaxDeductionCsvRecord[],
  options: TaxCsvExportOptions = {}
): TaxCsvOutcome {
  if (!Array.isArray(records)) {
    return csvError("records must be an array");
  }
  if (records.length === 0 && options.allowEmpty === false) {
    return csvError("records array cannot be empty");
  }

  const delimiter = options.delimiter ?? ",";
  if (delimiter.length !== 1 || /["\r\n]/.test(delimiter)) {
    return csvError("delimiter must be a single character other than a quote or line break");
  }
  const lineEnding = options.lineEnding ?? "\n";
  if (lineEnding !== "\n" && lineEnding !== "\r\n") {
    return csvError("lineEnding must be '\\n' or '\\r\\n'");
  }

  const scale = options.scale ?? 0;
  const schemaCheck = validateDbPrecisionSchema({ scale });
  if (!schemaCheck.ok) {
    return schemaCheck;
  }

  let columns: TaxCsvColumn[];
  if (options.columns && options.columns.length > 0) {
    const unknown = options.columns.find((c) => !TAX_CSV_COLUMNS.includes(c));
    if (unknown !== undefined) {
      return csvError(`unknown column: ${String(unknown)}`);
    }
    columns = [...options.columns];
  } else {
    const hasLabel = records.some((r) => r?.label !== undefined);
    columns = TAX_CSV_COLUMNS.filter((c) => c !== "label" || hasLabel);
  }

  if (options.headers && options.headers.length !== columns.length) {
    return csvError(
      `headers length (${options.headers.length}) must match columns length (${columns.length})`
    );
  }

  const amount = (v: bigint) => formatFixedScaleString(v.toString(), scale, true);
  const lines: string[] = [];
  if (options.includeHeader !== false) {
    lines.push(formatTaxCsvRow(options.headers ?? columns, delimiter));
  }

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (typeof record !== "object" || record === null) {
      return csvError(`record at index ${i} must be an object`);
    }
    const outcome = calculateTaxDeduction(
      record.grossAmount,
      record.taxRate,
      record.taxScale ?? DEFAULT_TAX_SCALE
    );
    if (!outcome.ok) {
      return { ...outcome, error: `record at index ${i}: ${outcome.error}` };
    }

    const cells: Record<TaxCsvColumn, string> = {
      label: record.label ?? "",
      grossAmount: amount(outcome.grossAmount),
      taxRate: outcome.taxRate.toString(),
      taxAmount: amount(outcome.taxAmount),
      netAmount: amount(outcome.netAmount),
      remainder: outcome.remainder.toString(),
    };
    lines.push(formatTaxCsvRow(columns.map((c) => cells[c]), delimiter));
  }

  return {
    ok: true,
    value: lines.length > 0 ? lines.join(lineEnding) + lineEnding : "",
    rowCount: records.length,
    columns,
  };
}

/** Alias for buildTaxDeductionCsvBlock. */
export const exportTaxDeductionsToCsv = buildTaxDeductionCsvBlock;
