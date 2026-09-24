/**
 * Interest yield estimator with overflow / digit-limit validation.
 * Rejects principals and rates whose digit count would risk unsafe numeric overflow.
 * Rejects negative parameters, applies round-half-to-even remainder policies,
 * resolves unknown Stellar asset tickers to default configurations, and formats
 * calculated values to match database precision schemas.
 */

/** Max decimal digits allowed for a principal or rate (below Number.MAX_SAFE_INTEGER). */
export const MAX_SAFE_DIGITS = 15;

/** Max decimal digits allowed for an intermediate multiplication product before division. */
export const MAX_INTERMEDIATE_DIGITS = MAX_SAFE_DIGITS * 2;

/**
 * Practical upper bound for a yield scale / decimals value.
 * Mirrors the SEP-41 style 0-18 range used by token helpers so that
 * 10^scale factors stay safe to combine with MAX_SAFE_DIGITS.
 */
export const MAX_YIELD_DECIMALS = 18;

/** Default denominator for scaled yield calculations (10,000 bps = 100%). */
export const DEFAULT_YIELD_SCALE = 10_000;

/** Basis-points denominator used by half-even yield rounding. */
export const YIELD_SCALE_DENOMINATOR = 10_000n;

/** Rounding policy applied when a division leaves a remainder. */
export const ROUNDING_MODE = "half-even" as const;

export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "OVERFLOW_EXCESSIVE_DIGITS",
  INVALID_RATE: "OVERFLOW_INVALID_RATE",
  PRODUCT_OVERFLOW: "OVERFLOW_PRODUCT_EXCEEDED",
  INVALID_AMOUNT: "OVERFLOW_INVALID_AMOUNT",
  INVALID_DECIMALS: "OVERFLOW_INVALID_DECIMALS",
  INVALID_SCHEMA: "OVERFLOW_INVALID_SCHEMA",
  INVALID_SCALE: "OVERFLOW_INVALID_SCALE",
} as const;

export type OverflowErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ValidationResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: OverflowErrorCode };

export type InterestYieldHalfEvenOutcome =
  | { ok: true; yieldAmount: bigint; totalAmount: bigint }
  | { ok: false; error: string; code: OverflowErrorCode };

export type YieldRoundedOutcome = InterestYieldHalfEvenOutcome;

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
    if (input < 0n) {
      return {
        ok: false,
        error: `${label} cannot be negative`,
        code: invalidCode,
      };
    }
    raw = input.toString();
  } else if (typeof input === "number") {
    if (!Number.isFinite(input) || !Number.isInteger(input)) {
      return {
        ok: false,
        error: `${label} must be a finite integer`,
        code: invalidCode,
      };
    }
    if (input < 0 || Object.is(input, -0)) {
      return {
        ok: false,
        error: `${label} cannot be negative`,
        code: invalidCode,
      };
    }
    raw = String(input);
  } else {
    raw = input.trim();
    if (raw.startsWith("-")) {
      return {
        ok: false,
        error: `${label} cannot be negative`,
        code: invalidCode,
      };
    }
    if (!/^\d+$/.test(raw)) {
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

  const value = BigInt(raw);
  if (value < 0n) {
    return {
      ok: false,
      error: `${label} cannot be negative`,
      code: invalidCode,
    };
  }

  return { ok: true, value };
}

/**
 * Validate an interest rate (integer scaled factor) against digit limits.
 * Rejects negative rates as yields cannot be computed from negative factors.
 */
export function validateInterestRate(
  rate: string | number | bigint
): ValidationResult {
  return parseIntegerInput(rate, "rate", ERROR_CODES.INVALID_RATE);
}

/**
 * Validate a principal amount against digit limits.
 * Rejects negative principals as balances cannot be negative.
 */
export function validatePrincipal(
  principal: string | number | bigint,
  label = "principal"
): ValidationResult {
  return parseIntegerInput(principal, label, ERROR_CODES.INVALID_AMOUNT);
}

/**
 * Estimate yield as principal * rate after validating both operands for overflow.
 * Rate is treated as an integer scaled factor (e.g. fixed-point APR).
 * Rejects negative principals and rates.
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

  if (amount.value < 0n) {
    return {
      ok: false,
      error: "principal cannot be negative",
      code: ERROR_CODES.INVALID_RATE,
    };
  }

  if (factor.value < 0n) {
    return {
      ok: false,
      error: "rate cannot be negative",
      code: ERROR_CODES.INVALID_RATE,
    };
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
// Decimal rounding policies (#458): round-half-to-even (banker's rounding)
// ---------------------------------------------------------------------------
//
// Truncating a scaled division (`principal * rate / scale`) leaks the
// fractional remainder in one direction. The helpers below fold the fraction
// into the rounded yield with banker's rounding so repeated application of
// the same rate does not bias totals consistently up or down, and
// `yieldAmount` never drops/leaks remainder values silently.

/**
 * Validate a scale / denominator used for scaled yield math.
 * Must be a positive integer within digit limits.
 */
export function validateYieldScale(
  scale: string | number | bigint,
  label = "scale"
): ValidationResult {
  const checked = parseIntegerInput(scale, label, ERROR_CODES.INVALID_SCALE);
  if (!checked.ok) {
    return checked;
  }
  if (checked.value <= 0n) {
    return {
      ok: false,
      error: `${label} must be a positive integer`,
      code: ERROR_CODES.INVALID_SCALE,
    };
  }
  return checked;
}

/**
 * Validate a yield rate expressed in basis points (0-10000, i.e. 0%-100%).
 */
export function validateYieldRateBps(rateBps: number): ValidationResult {
  if (
    typeof rateBps !== "number" ||
    !Number.isFinite(rateBps) ||
    !Number.isInteger(rateBps)
  ) {
    return {
      ok: false,
      error: "rateBps must be a finite integer",
      code: ERROR_CODES.INVALID_RATE,
    };
  }

  if (rateBps < 0 || rateBps > 10_000) {
    return {
      ok: false,
      error: "rateBps must be between 0 and 10000",
      code: ERROR_CODES.INVALID_RATE,
    };
  }

  return { ok: true, value: BigInt(rateBps) };
}

function roundHalfEvenQuotient(
  numerator: bigint,
  denominator: bigint
): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;

  let rounded = quotient;
  const twiceRemainder = remainder * 2n;
  if (twiceRemainder > denominator) {
    rounded += 1n;
  } else if (
    twiceRemainder === denominator &&
    quotient % 2n !== 0n
  ) {
    rounded += 1n;
  }
  return rounded;
}

/**
 * Estimate a scaled yield as round-half-to-even(principal * rate / scale).
 * Returns the rounded yield value; the remainder is folded into the result
 * instead of being truncated or leaked.
 */
export function estimateInterestYieldRounded(
  principal: string | number | bigint,
  rate: string | number | bigint,
  scale: string | number | bigint = DEFAULT_YIELD_SCALE
): ValidationResult {
  const amount = parseIntegerInput(
    principal,
    "principal",
    ERROR_CODES.INVALID_RATE
  );
  if (!amount.ok) {
    return amount;
  }

  const factor = parseIntegerInput(rate, "rate", ERROR_CODES.INVALID_RATE);
  if (!factor.ok) {
    return factor;
  }

  const scaleCheck = validateYieldScale(scale);
  if (!scaleCheck.ok) {
    return scaleCheck;
  }

  const numerator = amount.value * factor.value;
  if (digitCount(numerator.toString()) > MAX_INTERMEDIATE_DIGITS) {
    return {
      ok: false,
      error: "yield calculation would overflow during multiplication",
      code: ERROR_CODES.PRODUCT_OVERFLOW,
    };
  }

  const rounded = roundHalfEvenQuotient(numerator, scaleCheck.value);

  if (digitCount(rounded.toString()) > MAX_SAFE_DIGITS) {
    return {
      ok: false,
      error: `yield estimate exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
      code: ERROR_CODES.PRODUCT_OVERFLOW,
    };
  }

  return { ok: true, value: rounded };
}

/**
 * Deduct-style half-even yield: compute yield = round-half-to-even
 * (principal * rateBps / 10000) and total = principal + yield so
 * `yieldAmount` and `totalAmount` always reconstruct exactly with no
 * dropped or leaked remainder.
 */
export function estimateInterestYieldHalfEven(
  principal: string | number | bigint,
  rateBps: number
): InterestYieldHalfEvenOutcome {
  const amount = parseIntegerInput(
    principal,
    "principal",
    ERROR_CODES.INVALID_RATE
  );
  if (!amount.ok) {
    return amount;
  }

  const rate = validateYieldRateBps(rateBps);
  if (!rate.ok) {
    return rate;
  }

  const numerator = amount.value * rate.value;
  if (digitCount(numerator.toString()) > MAX_INTERMEDIATE_DIGITS) {
    return {
      ok: false,
      error: "yield calculation would overflow during multiplication",
      code: ERROR_CODES.PRODUCT_OVERFLOW,
    };
  }

  const yieldAmount = roundHalfEvenQuotient(
    numerator,
    YIELD_SCALE_DENOMINATOR
  );

  if (digitCount(yieldAmount.toString()) > MAX_SAFE_DIGITS) {
    return {
      ok: false,
      error: `yield estimate exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
      code: ERROR_CODES.PRODUCT_OVERFLOW,
    };
  }

  const totalAmount = amount.value + yieldAmount;

  return { ok: true, yieldAmount, totalAmount };
}

/** Alias for estimateInterestYieldRounded. */
export const estimateYieldWithRounding = estimateInterestYieldRounded;
/** Alias for estimateInterestYieldRounded. */
export const estimateInterestYieldWithScale = estimateInterestYieldRounded;
/** Alias for estimateInterestYieldHalfEven. */
export const calculateInterestYieldHalfEven = estimateInterestYieldHalfEven;
/** Alias for estimateInterestYieldHalfEven. */
export const calculateYieldHalfEven = estimateInterestYieldHalfEven;
/** Alias for estimateInterestYieldHalfEven. */
export const estimateYieldHalfEven = estimateInterestYieldHalfEven;

// ---------------------------------------------------------------------------
// Unknown asset ticker fallbacks (#460)
// ---------------------------------------------------------------------------

/**
 * Per-asset yield configuration looked up by Stellar token ticker.
 */
export interface InterestAssetConfig {
  /** Integer scaled rate factor applied to the principal. */
  rate: string | number | bigint;
  /** Token decimals / display scale for the asset. */
  decimals?: number;
  /** Optional human-readable label. */
  label?: string;
  /** Optional DB column scale override. */
  scale?: number;
}

/** Fallback ticker key used when no ticker is supplied. */
export const DEFAULT_ASSET_TICKER = "DEFAULT";

/**
 * Default format configuration applied when parsing missing or unfamiliar
 * tickers. Unknown keys never throw; they resolve to this object.
 */
export const DEFAULT_ASSET_CONFIG: InterestAssetConfig = {
  rate: "100",
  decimals: 7,
  label: "Default yield configuration",
};

/** Alias matching the "default format configuration" issue wording. */
export const DEFAULT_FORMAT_CONFIG: InterestAssetConfig = DEFAULT_ASSET_CONFIG;

/** Alias for the default asset configuration. */
export const DEFAULT_YIELD_CONFIG: InterestAssetConfig = DEFAULT_ASSET_CONFIG;

/**
 * Known Stellar asset ticker configurations.
 * Keys are matched case-insensitively after trimming.
 */
export const ASSET_CONFIGS: Record<string, InterestAssetConfig> = {
  XLM: { rate: "500", decimals: 7, label: "Stellar Lumens" },
  USDC: { rate: "300", decimals: 6, label: "USD Coin" },
  BTC: { rate: "200", decimals: 8, label: "Bitcoin" },
};

/** Alias for ASSET_CONFIGS. */
export const INTEREST_ASSET_CONFIGS: Record<string, InterestAssetConfig> =
  ASSET_CONFIGS;

/**
 * Resolve a Stellar asset ticker to its yield configuration.
 * Returns the default format configuration when the ticker is missing,
 * empty, or unfamiliar instead of throwing or returning an error.
 */
export function resolveAssetConfig(
  ticker?: string | null
): InterestAssetConfig {
  if (ticker === undefined || ticker === null) {
    return DEFAULT_ASSET_CONFIG;
  }
  if (typeof ticker !== "string") {
    return DEFAULT_ASSET_CONFIG;
  }
  const key = ticker.trim().toUpperCase();
  if (key.length === 0) {
    return DEFAULT_ASSET_CONFIG;
  }
  return ASSET_CONFIGS[key] ?? DEFAULT_ASSET_CONFIG;
}

/** Alias for resolveAssetConfig. */
export const getAssetConfig = resolveAssetConfig;
/** Alias for resolveAssetConfig. */
export const resolveTickerConfig = resolveAssetConfig;
/** Alias for resolveAssetConfig. */
export const getInterestAssetConfig = resolveAssetConfig;
/** Alias for resolveAssetConfig. */
export const resolveYieldConfig = resolveAssetConfig;

/**
 * Estimate yield using the rate configured for a Stellar asset ticker.
 * Unknown or missing tickers fall back to the default configuration.
 * An explicit override rate takes precedence over the resolved config.
 */
export function estimateInterestYieldForTicker(
  principal: string | number | bigint,
  ticker?: string | null,
  override?: Partial<InterestAssetConfig>
): ValidationResult {
  const config = resolveAssetConfig(ticker);
  const rate = override?.rate !== undefined ? override.rate : config.rate;
  return estimateInterestYield(principal, rate);
}

/** Alias for estimateInterestYieldForTicker. */
export const estimateYieldForTicker = estimateInterestYieldForTicker;
/** Alias for estimateInterestYieldForTicker. */
export const estimateYieldByTicker = estimateInterestYieldForTicker;
/** Alias for estimateInterestYieldForTicker. */
export const estimateInterestYieldByTicker = estimateInterestYieldForTicker;

// ---------------------------------------------------------------------------
// Format columns for DB storage (#461)
// ---------------------------------------------------------------------------

/**
 * Configuration options for database precision schema and column mapping.
 */
export interface DbPrecisionSchema {
  /** Column scale (decimal places). Defaults to the decimals argument. */
  scale?: number;
  /** Maximum safe precision (total digits). Defaults to MAX_SAFE_DIGITS (15). */
  precision?: number;
  /**
   * Whether to format with fixed decimal scale by padding fractional digits
   * with trailing zeroes to match the column scale.
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
 * Attributes for a database row storing a yield amount with full precision.
 */
export interface DbStorageRow {
  /** Raw integer amount string (exact integer, no precision loss). */
  raw_amount: string;
  /** Decimal amount string formatted to match database precision schema. */
  formatted_amount: string;
  /** Yield decimals (scale). */
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
  | { ok: false; error: string; code: OverflowErrorCode };

/**
 * Validate a yield decimals / scale value against the safe range.
 */
export function validateYieldDecimals(
  decimals: number
): { ok: true } | { ok: false; error: string; code: OverflowErrorCode } {
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

  if (decimals < 0 || decimals > MAX_YIELD_DECIMALS) {
    return {
      ok: false,
      error: `decimals must be between 0 and ${MAX_YIELD_DECIMALS}`,
      code: ERROR_CODES.INVALID_DECIMALS,
    };
  }

  return { ok: true };
}

function validateDbAmount(
  input: string | number | bigint,
  label = "amount"
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

function toRawUnitsFromHuman(
  humanAmount: string | number,
  decimals: number
): ValidationResult {
  if (typeof humanAmount === "number" && !Number.isFinite(humanAmount)) {
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
      code: ERROR_CODES.PRODUCT_OVERFLOW,
    };
  }

  return { ok: true, value: BigInt(combined) };
}

function toHumanUnitsFromRaw(
  rawAmount: bigint,
  decimals: number,
  fixedScale: boolean
): string {
  const digits = rawAmount.toString();

  if (decimals === 0) {
    return digits;
  }

  const padded = digits.padStart(decimals + 1, "0");
  const wholePart = padded.slice(0, padded.length - decimals);
  const fractionalPart = padded.slice(padded.length - decimals);
  const trimmedFractional = fixedScale
    ? fractionalPart
    : fractionalPart.replace(/0+$/, "");

  return trimmedFractional.length > 0
    ? `${wholePart}.${trimmedFractional}`
    : wholePart;
}

/**
 * Format a raw yield amount to a decimal string matching a database
 * precision schema's fixed scale.
 */
export function formatToDbPrecision(
  rawAmount: string | number | bigint,
  decimals: number,
  options?: { fixedScale?: boolean; precision?: number }
):
  | { ok: true; value: string }
  | { ok: false; error: string; code: OverflowErrorCode } {
  const decimalsCheck = validateYieldDecimals(decimals);
  if (!decimalsCheck.ok) {
    return decimalsCheck;
  }

  const rawCheck = validateDbAmount(rawAmount, "rawAmount");
  if (!rawCheck.ok) {
    return rawCheck;
  }

  return {
    ok: true,
    value: toHumanUnitsFromRaw(
      rawCheck.value,
      decimals,
      options?.fixedScale ?? true
    ),
  };
}

/**
 * Validate a database precision schema configuration.
 */
export function validateDbPrecisionSchema(
  schema: DbPrecisionSchema
): { ok: true } | { ok: false; error: string; code: OverflowErrorCode } {
  if (schema.scale !== undefined) {
    const scaleCheck = validateYieldDecimals(schema.scale);
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
 * Format values calculated by interest_yield_estimator to match database
 * precision schemas, producing row attributes that preserve full precision.
 *
 * @param amount - Raw integer yield (bigint, integer string/number) or human
 * decimal amount (string/number with decimal point), or a prior ok result.
 * @param decimals - Yield decimals scale (0 to 18).
 * @param schema - Optional database precision schema options.
 */
export function formatForDbStorage(
  amount:
    | string
    | number
    | bigint
    | ValidationResult
    | { ok: true; value: string },
  decimals: number,
  schema?: DbPrecisionSchema
): DbFormatResult {
  const decimalsCheck = validateYieldDecimals(decimals);
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
      const rawResult = toRawUnitsFromHuman(
        unwrapped.toString(),
        effectiveScale
      );
      if (!rawResult.ok) {
        return rawResult;
      }
      rawBigInt = rawResult.value;
      rawStr = rawBigInt.toString();
    } else {
      const rawCheck = validateDbAmount(unwrapped, "amount");
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
      const rawResult = toRawUnitsFromHuman(unwrapped, effectiveScale);
      if (!rawResult.ok) {
        return rawResult;
      }
      rawBigInt = rawResult.value;
      rawStr = rawBigInt.toString();
    } else {
      const rawCheck = validateDbAmount(unwrapped, "amount");
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
      const rawResult = toRawUnitsFromHuman(trimmed, effectiveScale);
      if (!rawResult.ok) {
        return rawResult;
      }
      rawBigInt = rawResult.value;
      rawStr = rawBigInt.toString();
    } else {
      const rawCheck = validateDbAmount(trimmed, "amount");
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

  const formatted = toHumanUnitsFromRaw(rawBigInt, effectiveScale, isFixedScale);
  const trimmedAmount = toHumanUnitsFromRaw(rawBigInt, effectiveScale, false);

  const rawCol = schema?.columns?.rawAmount ?? "raw_amount";
  const formattedCol = schema?.columns?.formattedAmount ?? "formatted_amount";
  const decimalsCol = schema?.columns?.decimals ?? "decimals";

  const row: DbStorageRow = {
    raw_amount: rawStr,
    formatted_amount: formatted,
    decimals: effectiveScale,
    rawAmount: rawStr,
    formattedAmount: formatted,
    trimmed_amount: trimmedAmount,
    [rawCol]: rawStr,
    [formattedCol]: formatted,
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
 * Format raw integer yield explicitly for database storage.
 */
export function formatRawForDbStorage(
  rawAmount: string | number | bigint,
  decimals: number,
  schema?: DbPrecisionSchema
): DbFormatResult {
  return formatForDbStorage(rawAmount, decimals, {
    ...schema,
    inputType: "raw",
  });
}

/**
 * Format human decimal yield explicitly for database storage.
 */
export function formatHumanForDbStorage(
  humanAmount: string | number,
  decimals: number,
  schema?: DbPrecisionSchema
): DbFormatResult {
  return formatForDbStorage(humanAmount, decimals, {
    ...schema,
    inputType: "human",
  });
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
      amount:
        | string
        | number
        | bigint
        | ValidationResult
        | { ok: true; value: string },
      decimals?: number,
      overrideSchema?: DbPrecisionSchema
    ) =>
      formatForDbStorage(amount, decimals ?? defaultSchema?.scale ?? 7, {
        ...defaultSchema,
        ...overrideSchema,
      }),
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
    validateSchema: (s: DbPrecisionSchema) => validateDbPrecisionSchema(s),
  };
}
