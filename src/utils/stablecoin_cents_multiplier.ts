/**
 * Stablecoin cents multiplier with overflow / digit-limit validation and configurable rounding policies.
 * Integer precision conversion helper converting between dollar decimal
 * amounts and integer cents (multiplier 100), rejecting inputs whose
 * digit count would risk unsafe numeric overflow.
 * Also provides stablecoin cents multiplication and integer division with
 * configurable rounding policies (default: round-to-nearest-even / banker's rounding).
 */

/** Max decimal digits allowed for a single cents amount (below Number.MAX_SAFE_INTEGER). */
export const MAX_SAFE_DIGITS = 15;

/** Multiplier converting dollars to cents (2 decimal places). */
export const CENTS_PER_UNIT = 100;

/** Number of decimal places for stablecoin cents precision. */
export const CENTS_DECIMALS = 2;

export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "CENTS_EXCESSIVE_DIGITS",
  INVALID_AMOUNT: "CENTS_INVALID_AMOUNT",
  CONVERSION_OVERFLOW: "CENTS_CONVERSION_OVERFLOW",
  SUM_MISMATCH: "CENTS_SUM_MISMATCH",
  INVALID_MULTIPLIER: "OVERFLOW_INVALID_MULTIPLIER",
  PRODUCT_OVERFLOW: "OVERFLOW_PRODUCT_EXCEEDED",
  INVALID_DIVISOR: "OVERFLOW_INVALID_DIVISOR",
  DIVISION_BY_ZERO: "OVERFLOW_DIVISION_BY_ZERO",
  INVALID_ROUNDING_MODE: "INVALID_ROUNDING_MODE",
} as const;

export type CentsErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
export type OverflowErrorCode = CentsErrorCode;

export type RoundingPolicy =
  | "half-even"
  | "round-to-nearest-even"
  | "half-up"
  | "truncate"
  | "ceil";

export interface ApplyMultiplierOptions {
  divisor?: string | number | bigint;
  roundingMode?: RoundingPolicy;
}

export type ConversionResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: CentsErrorCode };

export type DollarsResult =
  | { ok: true; value: string }
  | { ok: false; error: string; code: CentsErrorCode };

export type ValidationResult = ConversionResult;

function digitCount(normalized: string): number {
  const digits = normalized.replace(/^-/, "").replace(/^0+(?=\d)/, "");
  return digits.length === 0 ? 1 : digits.length;
}

function parseIntegerInput(
  input: string | number | bigint,
  label: string,
  invalidCode: CentsErrorCode
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
    if (typeof input !== "string") {
      return {
        ok: false,
        error: `${label} must be a string, number, or bigint`,
        code: invalidCode,
      };
    }
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
 * Validate a multiplier against digit limits.
 */
export function validateMultiplier(
  multiplier: string | number | bigint
): ValidationResult {
  return parseIntegerInput(multiplier, "multiplier", ERROR_CODES.INVALID_MULTIPLIER);
}

/** Alias for validateMultiplier */
export const validateCentsMultiplier = validateMultiplier;

/**
 * Validate a stablecoin cents amount against digit limits.
 */
export function validateStablecoinCents(
  amount: string | number | bigint
): ValidationResult {
  return parseIntegerInput(amount, "amount", ERROR_CODES.INVALID_AMOUNT);
}

/**
 * Validate a divisor against digit limits and non-zero requirement.
 */
export function validateDivisor(
  divisor: string | number | bigint
): ValidationResult {
  const parsed = parseIntegerInput(divisor, "divisor", ERROR_CODES.INVALID_DIVISOR);
  if (!parsed.ok) {
    return parsed;
  }
  if (parsed.value === 0n) {
    return {
      ok: false,
      error: "divisor cannot be zero",
      code: ERROR_CODES.DIVISION_BY_ZERO,
    };
  }
  return parsed;
}

/**
 * Parse and validate a cents amount string/number/bigint against digit limits.
 * Rejects negative amounts as stablecoin balances cannot be negative.
 */
export function validateCentsAmount(
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
 * Convert a dollar decimal amount (e.g. "12.99") into integer cents
 * by scaling with the cents multiplier (100).
 */
export function dollarsToCents(humanAmount: string | number): ConversionResult {
  if (typeof humanAmount === "number" && !Number.isFinite(humanAmount)) {
    return {
      ok: false,
      error: "amount must be a finite number",
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

  if (fractionalPart.length > CENTS_DECIMALS) {
    return {
      ok: false,
      error: `amount has more fractional digits than cents precision (${CENTS_DECIMALS}) allows`,
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  const paddedFractional = fractionalPart.padEnd(CENTS_DECIMALS, "0");
  const combined = `${wholePart}${paddedFractional}`.replace(/^0+(?=\d)/, "");

  if (digitCount(combined) > MAX_SAFE_DIGITS) {
    return {
      ok: false,
      error: `converted amount would exceed maximum of ${MAX_SAFE_DIGITS} digits`,
      code: ERROR_CODES.CONVERSION_OVERFLOW,
    };
  }

  return { ok: true, value: BigInt(combined) };
}

/**
 * Convert integer cents back into a dollar decimal string.
 */
export function centsToDollars(
  cents: string | number | bigint
): DollarsResult {
  const rawCheck = validateCentsAmount(cents, "cents");
  if (!rawCheck.ok) {
    return rawCheck;
  }

  const digits = rawCheck.value.toString().padStart(CENTS_DECIMALS + 1, "0");
  const wholePart = digits.slice(0, digits.length - CENTS_DECIMALS);
  const fractionalPart = digits.slice(digits.length - CENTS_DECIMALS);
  const trimmedFractional = fractionalPart.replace(/0+$/, "");

  const value =
    trimmedFractional.length > 0
      ? `${wholePart}.${trimmedFractional}`
      : wholePart;

  return { ok: true, value };
}

/**
 * Confirm that a set of split cents amounts sums exactly to the given base
 * cents amount, rejecting allocations that over- or under-allocate the total.
 */
export function validateSplitSum(
  parts: Array<string | number | bigint>,
  baseAmount: string | number | bigint
): ConversionResult {
  let total = 0n;

  for (let i = 0; i < parts.length; i++) {
    const checked = validateCentsAmount(parts[i], `parts[${i}]`);
    if (!checked.ok) {
      return checked;
    }
    total += checked.value;
  }

  const baseCheck = validateCentsAmount(baseAmount, "baseAmount");
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
 * Perform deterministic integer division and apply rounding policy on the remainder.
 * Banker's rounding (round-to-nearest-even) breaks exact half ties to the nearest even integer.
 */
function roundIntegerDivision(
  numerator: bigint,
  divisor: bigint,
  mode: RoundingPolicy
): bigint {
  let N = numerator;
  let D = divisor;

  if (D < 0n) {
    N = -N;
    D = -D;
  }

  const q = N / D;
  const r = N % D;

  if (r === 0n) {
    return q;
  }

  const sign = N >= 0n ? 1n : -1n;
  const absR = r >= 0n ? r : -r;
  const twiceR = 2n * absR;

  if (mode === "truncate") {
    return q;
  }

  if (mode === "ceil") {
    return N > 0n ? q + 1n : q;
  }

  if (mode === "half-up") {
    if (twiceR >= D) {
      return q + sign;
    }
    return q;
  }

  // mode is "half-even" or "round-to-nearest-even" (default)
  // Tie-breaking rule for Banker's Rounding / Round-to-Nearest-Even:
  // - If twice the remainder is strictly less than divisor: round towards 0 (keep q).
  // - If twice the remainder is strictly greater than divisor: round away from 0 (q + sign).
  // - If twice the remainder equals divisor (exact half):
  //     - If q is even (q % 2n === 0n): keep q.
  //     - If q is odd (q % 2n !== 0n): round to nearest even (q + sign).
  if (twiceR < D) {
    return q;
  } else if (twiceR > D) {
    return q + sign;
  } else {
    // Exact halfway tie
    if (q % 2n === 0n) {
      return q;
    } else {
      return q + sign;
    }
  }
}

/**
 * Multiply stablecoin cents amount by multiplier and optional divisor after validating operands.
 * Applies rounding policy (default: round-to-nearest-even) when division remainders occur.
 */
export function applyStablecoinCentsMultiplier(
  amount: string | number | bigint,
  multiplier: string | number | bigint,
  divisorOrOptions?: string | number | bigint | ApplyMultiplierOptions,
  roundingModeParam?: RoundingPolicy
): ValidationResult {
  const centsResult = validateStablecoinCents(amount);
  if (!centsResult.ok) {
    return centsResult;
  }

  const multiplierResult = validateMultiplier(multiplier);
  if (!multiplierResult.ok) {
    return multiplierResult;
  }

  let divisorInput: string | number | bigint = 1n;
  let mode: RoundingPolicy = roundingModeParam ?? "half-even";

  if (divisorOrOptions !== undefined && divisorOrOptions !== null) {
    if (
      typeof divisorOrOptions === "object" &&
      typeof divisorOrOptions !== "bigint"
    ) {
      if (divisorOrOptions.divisor !== undefined) {
        divisorInput = divisorOrOptions.divisor;
      }
      if (divisorOrOptions.roundingMode !== undefined) {
        mode = divisorOrOptions.roundingMode;
      }
    } else {
      divisorInput = divisorOrOptions;
    }
  }

  const validModes: RoundingPolicy[] = [
    "half-even",
    "round-to-nearest-even",
    "half-up",
    "truncate",
    "ceil",
  ];
  if (!validModes.includes(mode)) {
    return {
      ok: false,
      error: `Invalid rounding mode: ${String(mode)}`,
      code: ERROR_CODES.INVALID_ROUNDING_MODE,
    };
  }

  const divisorResult = validateDivisor(divisorInput);
  if (!divisorResult.ok) {
    return divisorResult;
  }

  const product = centsResult.value * multiplierResult.value;
  if (digitCount(product.toString()) > MAX_SAFE_DIGITS) {
    return {
      ok: false,
      error: `multiplied cents value exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
      code: ERROR_CODES.PRODUCT_OVERFLOW,
    };
  }

  const finalValue = roundIntegerDivision(product, divisorResult.value, mode);
  if (digitCount(finalValue.toString()) > MAX_SAFE_DIGITS) {
    return {
      ok: false,
      error: `multiplied cents value exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
      code: ERROR_CODES.PRODUCT_OVERFLOW,
    };
  }

  return { ok: true, value: finalValue };
}

/** Aliases for backward compatibility */
export const applyCentsMultiplier = applyStablecoinCentsMultiplier;
export const multiplyStablecoinCents = applyStablecoinCentsMultiplier;

// ---------------------------------------------------------------------------
// Per-ticker precision configuration (#479)
// ---------------------------------------------------------------------------

export interface StablecoinConfig {
  /** Number of decimal places used by the asset. */
  decimals: number;
  /** Multiplier applied to convert whole units into integer cents. */
  centsMultiplier: number;
}

/**
 * Default configuration applied when a ticker key is missing or unknown.
 * Mirrors the most common stablecoin layout (2 decimals / 100 cents).
 */
export const DEFAULT_STABLECOIN_CONFIG: StablecoinConfig = {
  decimals: CENTS_DECIMALS,
  centsMultiplier: CENTS_PER_UNIT,
};

/**
 * Known Stellar stablecoin ticker keys mapped to their precision config.
 * Keys are upper-case; lookups are case-insensitive.
 */
export const STABLECOIN_CONFIGS: Record<string, StablecoinConfig> = {
  USDC: { decimals: 2, centsMultiplier: 100 },
  USDT: { decimals: 2, centsMultiplier: 100 },
  USD: { decimals: 2, centsMultiplier: 100 },
  DAI: { decimals: 2, centsMultiplier: 100 },
  EURC: { decimals: 2, centsMultiplier: 100 },
};

function normalizeTicker(ticker?: string | null): string {
  return typeof ticker === "string" ? ticker.trim().toUpperCase() : "";
}

/**
 * Resolve the precision configuration for a ticker key. Unknown, empty or
 * missing tickers return DEFAULT_STABLECOIN_CONFIG instead of failing.
 */
export function getStablecoinConfig(ticker?: string | null): StablecoinConfig {
  const key = normalizeTicker(ticker);
  if (!key || !Object.prototype.hasOwnProperty.call(STABLECOIN_CONFIGS, key)) {
    return DEFAULT_STABLECOIN_CONFIG;
  }
  return STABLECOIN_CONFIGS[key];
}

/**
 * Cents multiplier for a ticker key, falling back to the default
 * configuration when the ticker is missing or unknown.
 */
export function stablecoin_cents_multiplier(ticker?: string | null): number {
  return getStablecoinConfig(ticker).centsMultiplier;
}

/**
 * Convert a human-readable amount into integer base units using the precision
 * resolved for `ticker`. Uses exact decimal-string arithmetic and applies the
 * same rules as `dollarsToCents`: negative amounts, non-numeric input,
 * sub-unit precision beyond the asset's decimals and digit overflow are
 * rejected with typed errors.
 */
export function toCents(
  amount: string | number,
  ticker?: string | null
): ConversionResult {
  const { decimals } = getStablecoinConfig(ticker);

  if (typeof amount === "number" && !Number.isFinite(amount)) {
    return {
      ok: false,
      error: "amount must be a finite number",
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  const raw = String(amount).trim();
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
      error: `amount has more fractional digits than the asset precision (${decimals}) allows`,
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  const combined = `${wholePart}${fractionalPart.padEnd(decimals, "0")}`.replace(
    /^0+(?=\d)/,
    ""
  );
  if (digitCount(combined) > MAX_SAFE_DIGITS) {
    return {
      ok: false,
      error: `converted amount would exceed maximum of ${MAX_SAFE_DIGITS} digits`,
      code: ERROR_CODES.CONVERSION_OVERFLOW,
    };
  }

  return { ok: true, value: BigInt(combined) };
}
