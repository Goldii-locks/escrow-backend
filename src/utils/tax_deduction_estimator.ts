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
