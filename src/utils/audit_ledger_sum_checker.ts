/**
 * Ledger transaction sum checker with overflow / digit-limit validation
 * and consistent decimal rounding policies.
 * Rejects inputs whose digit count would risk unsafe numeric overflow.
 */

import {
  digitCount,
  parseIntegerInput,
  MAX_SAFE_DIGITS,
} from "./digit-limit-validator.js";

export { MAX_SAFE_DIGITS };

export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "OVERFLOW_EXCESSIVE_DIGITS",
  INVALID_AMOUNT: "OVERFLOW_INVALID_AMOUNT",
  SUM_OVERFLOW: "OVERFLOW_SUM_EXCEEDED",
  ROUNDING_INVALID_INPUT: "ROUNDING_INVALID_INPUT",
  ROUNDING_SCALE_INVALID: "ROUNDING_SCALE_INVALID",
  FORMAT_INVALID_DECIMALS: "FORMAT_INVALID_DECIMALS",
  FORMAT_PRECISION_LOSS: "FORMAT_PRECISION_LOSS",
  SUM_MISMATCH: "OVERFLOW_SUM_MISMATCH",
  RATE_LIMITED: "AUDIT_RATE_LIMITED",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
} as const;

export type OverflowErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ValidationResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: OverflowErrorCode; status?: number };

// ---------------------------------------------------------------------------
// Rate Limiting (#499)
// ---------------------------------------------------------------------------

/** Max audit_ledger_sum_checker calls allowed per rate-limit window before calls are rejected. */
export const RATE_LIMIT_MAX_CALLS = 1000;

/** Rate-limit window size, in milliseconds. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

let rateLimitWindowStart = Date.now();
let rateLimitCallCount = 0;
let customRateLimitMax: number | null = null;
const clientBuckets = new Map<string, { count: number; resetAt: number }>();

export function resetAuditRateLimitBuckets(): void {
  rateLimitWindowStart = Date.now();
  rateLimitCallCount = 0;
  customRateLimitMax = null;
  clientBuckets.clear();
}

export function setAuditRateLimitMax(max: number | null): void {
  customRateLimitMax = max;
}

function resolveRateLimitMax(): number {
  if (customRateLimitMax !== null && customRateLimitMax > 0) {
    return customRateLimitMax;
  }
  const configured = Number(
    process.env.AUDIT_LEDGER_RATE_MAX ??
      process.env.AUDIT_RATE_MAX ??
      RATE_LIMIT_MAX_CALLS
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : RATE_LIMIT_MAX_CALLS;
}

function resolveRateLimitWindowMs(): number {
  const configured = Number(
    process.env.AUDIT_LEDGER_RATE_WINDOW_MS ??
      process.env.AUDIT_RATE_WINDOW_MS ??
      RATE_LIMIT_WINDOW_MS
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : RATE_LIMIT_WINDOW_MS;
}

export type AuditRateLimitResult =
  | { ok: true; allowed: true; remaining: number; resetAt: number }
  | {
      ok: false;
      allowed: false;
      error: string;
      code: OverflowErrorCode;
      status: 429;
      remaining: 0;
      resetAt: number;
    };

/**
 * Guard against excessive audit_ledger_sum_checker call volume within a rolling window.
 * Supports per-client IP/key buckets as well as global invocation checks with 429 warning semantics.
 */
export function checkAuditLedgerRateLimit(
  clientKey?: string
): AuditRateLimitResult {
  const now = Date.now();
  const maxCalls = resolveRateLimitMax();
  const windowMs = resolveRateLimitWindowMs();

  if (clientKey) {
    let bucket = clientBuckets.get(clientKey);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      clientBuckets.set(clientKey, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, maxCalls - bucket.count);

    if (bucket.count > maxCalls) {
      return {
        ok: false,
        allowed: false,
        error: `audit_ledger_sum_checker rate limit exceeded: max ${maxCalls} requests per ${windowMs}ms`,
        code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
        status: 429,
        remaining: 0,
        resetAt: bucket.resetAt,
      };
    }

    return {
      ok: true,
      allowed: true,
      remaining,
      resetAt: bucket.resetAt,
    };
  }

  if (now - rateLimitWindowStart >= windowMs) {
    rateLimitWindowStart = now;
    rateLimitCallCount = 0;
  }

  rateLimitCallCount += 1;
  const resetAt = rateLimitWindowStart + windowMs;
  const remaining = Math.max(0, maxCalls - rateLimitCallCount);

  if (rateLimitCallCount > maxCalls) {
    return {
      ok: false,
      allowed: false,
      error: `audit_ledger_sum_checker rate limit exceeded: max ${maxCalls} calls per ${windowMs}ms`,
      code: ERROR_CODES.RATE_LIMITED,
      status: 429,
      remaining: 0,
      resetAt,
    };
  }

  return {
    ok: true,
    allowed: true,
    remaining,
    resetAt,
  };
}

// ---------------------------------------------------------------------------
// Unknown Asset Ticker Fallbacks (#497)
// ---------------------------------------------------------------------------

/**
 * Well-known Stellar asset tickers with their decimal precision and metadata.
 */
export interface KnownAssetConfig {
  /** Ticker symbol (e.g. "XLM", "USDC") */
  ticker: string;
  /** Decimal places (Stellar tokens standard is 7). */
  decimals: number;
  /** Human-readable asset name */
  label: string;
}

export const KNOWN_ASSETS: Record<string, KnownAssetConfig> = {
  XLM: { ticker: "XLM", decimals: 7, label: "Stellar Lumens" },
  USDC: { ticker: "USDC", decimals: 7, label: "USD Coin (Stellar)" },
  USDT: { ticker: "USDT", decimals: 7, label: "Tether (Stellar)" },
  BTC: { ticker: "BTC", decimals: 7, label: "Bitcoin (Stellar)" },
  ETH: { ticker: "ETH", decimals: 7, label: "Ether (Stellar)" },
};

export type TickerResolution =
  | { known: true; ticker: string; config: KnownAssetConfig }
  | { known: false; ticker: string; config: KnownAssetConfig; fallback: true };

/** Default fallback configuration used for unknown Stellar asset tickers. */
export const DEFAULT_ASSET_FALLBACK: KnownAssetConfig = {
  ticker: "UNKNOWN",
  decimals: 7,
  label: "Unknown Stellar Token",
};

export interface AssetFormatConfig {
  ticker: string;
  decimals: number;
}

export const DEFAULT_ASSET_FORMAT_CONFIG: AssetFormatConfig = {
  ticker: "UNKNOWN",
  decimals: 7,
};

/**
 * Resolve an asset ticker string to its configuration, returning a typed
 * fallback for any ticker not found in the registry.
 */
export function resolveAssetTicker(rawTicker?: string | null): TickerResolution {
  if (!rawTicker || typeof rawTicker !== "string") {
    return {
      known: false,
      ticker: "UNKNOWN",
      config: DEFAULT_ASSET_FALLBACK,
      fallback: true,
    };
  }

  const ticker = rawTicker.trim().toUpperCase();
  const config = KNOWN_ASSETS[ticker];

  if (config !== undefined) {
    return { known: true, ticker, config };
  }

  const rawTrimmed = rawTicker.trim();
  return {
    known: false,
    ticker: rawTrimmed,
    config: { ...DEFAULT_ASSET_FALLBACK, ticker: rawTrimmed },
    fallback: true,
  };
}

/**
 * Resolve the format configuration for a Stellar asset ticker, applying default
 * fallback configuration when the ticker is missing or unknown.
 */
export function getAssetFormatConfig(
  ticker?: string | null
): AssetFormatConfig {
  const resolution = resolveAssetTicker(ticker);
  return {
    ticker: resolution.config.ticker,
    decimals: resolution.config.decimals,
  };
}

/**
 * Parse and validate a ledger amount string/number against digit limits.
 * Rejects negative amounts (#496) as ledger balance checks require non-negative values.
 */
export function validateLedgerAmount(
  input: string | number | bigint,
  label = "amount"
): ValidationResult {
  if (typeof input === "bigint") {
    if (input < 0n) {
      return {
        ok: false,
        error: `${label} cannot be negative`,
        code: ERROR_CODES.INVALID_AMOUNT,
      };
    }
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
  } else if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("-")) {
      return {
        ok: false,
        error: `${label} cannot be negative`,
        code: ERROR_CODES.INVALID_AMOUNT,
      };
    }
  }

  const parsed = parseIntegerInput(
    input,
    label,
    ERROR_CODES.INVALID_AMOUNT,
    ERROR_CODES.EXCESSIVE_DIGITS
  );

  if (!parsed.ok) {
    return parsed;
  }

  if (parsed.value < 0n) {
    return {
      ok: false,
      error: `${label} cannot be negative`,
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  return parsed;
}

/**
 * Sum ledger entry amounts after validating each against overflow digit limits
 * and rejecting negative amounts (#496). Applies rate limiting check (#499).
 */
export function sumLedgerAmounts(
  amounts: Array<string | number | bigint>,
  options?: { ticker?: string; clientKey?: string }
): ValidationResult {
  const rateLimit = checkAuditLedgerRateLimit(options?.clientKey);
  if (!rateLimit.ok) {
    return rateLimit;
  }

  if (options?.ticker !== undefined) {
    // Resolve asset ticker to verify format configuration / fallback
    resolveAssetTicker(options.ticker);
  }

  let total = 0n;

  for (let i = 0; i < amounts.length; i++) {
    const checked = validateLedgerAmount(amounts[i], `amounts[${i}]`);
    if (!checked.ok) {
      return checked;
    }

    const next = total + checked.value;
    if (digitCount(next.toString()) > MAX_SAFE_DIGITS) {
      return {
        ok: false,
        error: `ledger sum exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
        code: ERROR_CODES.SUM_OVERFLOW,
      };
    }
    total = next;
  }

  return { ok: true, value: total };
}

// ---------------------------------------------------------------------------
// Split-sum assertions (issue #501)
// ---------------------------------------------------------------------------

export type SplitSumResult =
  | { ok: true; total: bigint; isMatch: boolean }
  | { ok: false; error: string; code: OverflowErrorCode };

/**
 * Assert that a set of split amounts adds up to an expected base amount.
 *
 * Every split and the base are validated against the digit limit before any
 * arithmetic, so the function never operates on unsafe integers. The running
 * total is guarded against digit-limit overflow on each addition.
 *
 * When `strict` is true (the default) a total that does not equal the base
 * is returned as `{ ok: true, isMatch: false }` so the caller can decide how
 * to handle the mismatch; pass `strict: "reject"` to receive a hard
 * `SUM_MISMATCH` failure instead.
 */
export function assertLedgerSplitSum(
  splits: Array<string | number | bigint>,
  expectedBase: string | number | bigint,
  strict: "mismatch" | "reject" = "mismatch"
): SplitSumResult {
  if (!Array.isArray(splits) || splits.length === 0) {
    return {
      ok: false,
      error: "splits must be a non-empty array",
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  const baseCheck = validateLedgerAmount(expectedBase, "expectedBase");
  if (!baseCheck.ok) {
    return baseCheck;
  }

  let total = 0n;
  for (let i = 0; i < splits.length; i++) {
    const splitCheck = validateLedgerAmount(splits[i], `splits[${i}]`);
    if (!splitCheck.ok) {
      return splitCheck;
    }
    const next = total + splitCheck.value;
    if (digitCount(next.toString()) > MAX_SAFE_DIGITS) {
      return {
        ok: false,
        error: `split total exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
        code: ERROR_CODES.SUM_OVERFLOW,
      };
    }
    total = next;
  }

  if (total !== baseCheck.value) {
    if (strict === "reject") {
      return {
        ok: false,
        error: `split total (${total}) does not match base amount (${baseCheck.value})`,
        code: ERROR_CODES.SUM_MISMATCH,
      };
    }
    return { ok: true, total, isMatch: false };
  }

  return { ok: true, total, isMatch: true };
}

// ---------------------------------------------------------------------------
// TASK 4 – Decimal rounding policies
// ---------------------------------------------------------------------------

export type RoundingErrorCode =
  | typeof ERROR_CODES.ROUNDING_INVALID_INPUT
  | typeof ERROR_CODES.ROUNDING_SCALE_INVALID
  | typeof ERROR_CODES.EXCESSIVE_DIGITS
  | typeof ERROR_CODES.INVALID_AMOUNT;

export type RoundingResult =
  | { ok: true; value: bigint; remainder: bigint }
  | { ok: false; error: string; code: RoundingErrorCode };

/**
 * Round a numerator/denominator division to the nearest even integer
 * (banker's rounding / round-half-to-even).
 *
 * Both `numerator` and `denominator` must be non-negative bigints; a positive
 * `denominator` is enforced. The `remainder` in the success result is the
 * fractional part *before* rounding expressed as a bigint so the caller can
 * reconstruct the exact value:
 *   numerator === value * denominator + pre_round_remainder
 *
 * This is consistent with the round-half-to-even used in
 * `fee_deduction_calculator.calculateFeeDeductionHalfEven`.
 */
export function roundHalfEven(
  numerator: bigint,
  denominator: bigint
): RoundingResult {
  if (typeof numerator !== "bigint" || typeof denominator !== "bigint") {
    return {
      ok: false,
      error: "numerator and denominator must be bigint values",
      code: ERROR_CODES.ROUNDING_INVALID_INPUT,
    };
  }

  if (numerator < 0n) {
    return {
      ok: false,
      error: "numerator must be non-negative",
      code: ERROR_CODES.ROUNDING_INVALID_INPUT,
    };
  }

  if (denominator <= 0n) {
    return {
      ok: false,
      error: "denominator must be a positive bigint",
      code: ERROR_CODES.ROUNDING_SCALE_INVALID,
    };
  }

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;

  let rounded = quotient;
  const twiceRemainder = remainder * 2n;

  if (twiceRemainder > denominator) {
    // Fractional part > 0.5 → round up
    rounded += 1n;
  } else if (twiceRemainder === denominator && quotient % 2n !== 0n) {
    // Fractional part exactly 0.5 and quotient is odd → round up to even
    rounded += 1n;
  }
  // Otherwise: fractional part < 0.5, or exactly 0.5 with an even quotient → truncate

  return { ok: true, value: rounded, remainder };
}

/**
 * Divide a ledger amount by a positive integer divisor using round-half-to-even
 * so repeated division does not accumulate a one-directional rounding bias.
 *
 * The `parts` array in the success result contains `divisor` bigint values
 * that sum exactly to `amount` — any rounding dust is added to the first
 * element (index 0) so the invariant `parts.reduce((a, b) => a + b) === amount`
 * always holds. No remainder is ever lost.
 */
export function divideWithRounding(
  amount: string | number | bigint,
  divisor: number
): { ok: true; parts: bigint[] } | { ok: false; error: string; code: RoundingErrorCode } {
  const amountCheck = validateLedgerAmount(amount, "amount");
  if (!amountCheck.ok) {
    return amountCheck as { ok: false; error: string; code: RoundingErrorCode };
  }

  if (
    typeof divisor !== "number" ||
    !Number.isFinite(divisor) ||
    !Number.isInteger(divisor) ||
    divisor <= 0
  ) {
    return {
      ok: false,
      error: "divisor must be a positive integer",
      code: ERROR_CODES.ROUNDING_SCALE_INVALID,
    };
  }

  const total = amountCheck.value;
  const denom = BigInt(divisor);

  const base = roundHalfEven(total, denom);
  if (!base.ok) {
    return base as { ok: false; error: string; code: RoundingErrorCode };
  }

  // Each of the `divisor` parts uses the rounded base share.
  // The actual per-part value when using integer division (truncation) is:
  const truncated = total / denom;
  const dustCount = total - truncated * denom; // number of parts that need +1

  const parts: bigint[] = [];
  for (let i = 0; i < divisor; i++) {
    // Distribute the dust to the leading parts.
    parts.push(i < dustCount ? truncated + 1n : truncated);
  }

  return { ok: true, parts };
}

/**
 * Apply round-half-to-even to a ledger amount scaled by a rational factor
 * expressed as `numerator / denominator` (both positive integers).
 *
 * This is the entry-point for applying fee rates or allocation percentages to
 * ledger amounts in a bias-free way. The function validates both operands and
 * the scale before performing any arithmetic.
 */
export function applyRoundedScale(
  amount: string | number | bigint,
  scaleNumerator: string | number | bigint,
  scaleDenominator: string | number | bigint
): RoundingResult {
  const amountCheck = validateLedgerAmount(amount, "amount");
  if (!amountCheck.ok) {
    return amountCheck as RoundingResult;
  }

  const numCheck = validateLedgerAmount(scaleNumerator, "scaleNumerator");
  if (!numCheck.ok) {
    return numCheck as RoundingResult;
  }

  const denomCheck = validateLedgerAmount(scaleDenominator, "scaleDenominator");
  if (!denomCheck.ok) {
    return denomCheck as RoundingResult;
  }

  if (denomCheck.value <= 0n) {
    return {
      ok: false,
      error: "scaleDenominator must be a positive integer",
      code: ERROR_CODES.ROUNDING_SCALE_INVALID,
    };
  }

  const product = amountCheck.value * numCheck.value;

  return roundHalfEven(product, denomCheck.value);
}

// ---------------------------------------------------------------------------
// TASK 5 – Parameter warning codes and error-response shapes
// ---------------------------------------------------------------------------

/**
 * Detailed per-parameter warning codes.
 *
 * `ERROR_CODES` above describes *why a calculation failed*; these codes
 * describe *which parameter was at fault*, so a caller (or an API error
 * handler) can point at the offending argument instead of a generic overflow
 * message. They are additive: every existing `ERROR_CODES` value keeps its
 * meaning.
 */
export const PARAMETER_WARNING_CODES = {
  AMOUNT_MISSING: "PARAM_AMOUNT_MISSING",
  AMOUNT_NOT_INTEGER: "PARAM_AMOUNT_NOT_INTEGER",
  AMOUNT_NEGATIVE: "PARAM_AMOUNT_NEGATIVE",
  AMOUNT_EXCESSIVE_DIGITS: "PARAM_AMOUNT_EXCESSIVE_DIGITS",
  AMOUNTS_NOT_ARRAY: "PARAM_AMOUNTS_NOT_ARRAY",
  AMOUNTS_EMPTY: "PARAM_AMOUNTS_EMPTY",
  ENTRY_INVALID: "PARAM_ENTRY_INVALID",
  LABEL_MISSING: "PARAM_LABEL_MISSING",
  DIVISOR_NOT_INTEGER: "PARAM_DIVISOR_NOT_INTEGER",
  DIVISOR_OUT_OF_RANGE: "PARAM_DIVISOR_OUT_OF_RANGE",
  SCALE_DENOMINATOR_ZERO: "PARAM_SCALE_DENOMINATOR_ZERO",
  SCALE_NUMERATOR_INVALID: "PARAM_SCALE_NUMERATOR_INVALID",
  TYPE_INVALID: "PARAM_TYPE_INVALID",
} as const;

export type ParameterWarningCode =
  (typeof PARAMETER_WARNING_CODES)[keyof typeof PARAMETER_WARNING_CODES];

/** A single parameter problem, reported without aborting a whole batch. */
export type ParameterWarning = {
  code: ParameterWarningCode;
  /** The parameter that caused the problem, e.g. "amounts[2]". */
  parameter: string;
  message: string;
  /** Position in a list input, when the parameter came from one. */
  index: number | null;
  /** The existing calculation code this maps back to, when there is one. */
  calculationCode: OverflowErrorCode | RoundingErrorCode | null;
};

/** The published definition of a warning code: what it means and how to reply. */
export type ParameterErrorDefinition = {
  code: ParameterWarningCode;
  parameter: string;
  httpStatus: number;
  summary: string;
};

/**
 * The error definition list. Every `PARAMETER_WARNING_CODES` entry has exactly
 * one definition, and the response body built by `toErrorResponse()` is
 * asserted against these definitions.
 */
export const PARAMETER_ERROR_DEFINITIONS: readonly ParameterErrorDefinition[] = [
  {
    code: PARAMETER_WARNING_CODES.AMOUNT_MISSING,
    parameter: "amount",
    httpStatus: 400,
    summary: "No amount was supplied for an entry that requires one.",
  },
  {
    code: PARAMETER_WARNING_CODES.AMOUNT_NOT_INTEGER,
    parameter: "amount",
    httpStatus: 400,
    summary: "The amount is not an integer numeric value.",
  },
  {
    code: PARAMETER_WARNING_CODES.AMOUNT_NEGATIVE,
    parameter: "amount",
    httpStatus: 400,
    summary: "The amount is negative, which this check does not accept.",
  },
  {
    code: PARAMETER_WARNING_CODES.AMOUNT_EXCESSIVE_DIGITS,
    parameter: "amount",
    httpStatus: 422,
    summary: `The amount exceeds the safe limit of ${MAX_SAFE_DIGITS} digits.`,
  },
  {
    code: PARAMETER_WARNING_CODES.AMOUNTS_NOT_ARRAY,
    parameter: "amounts",
    httpStatus: 400,
    summary: "The ledger amounts were not supplied as an array.",
  },
  {
    code: PARAMETER_WARNING_CODES.AMOUNTS_EMPTY,
    parameter: "amounts",
    httpStatus: 400,
    summary: "The ledger amounts array is empty.",
  },
  {
    code: PARAMETER_WARNING_CODES.ENTRY_INVALID,
    parameter: "amounts[i]",
    httpStatus: 422,
    summary: "One ledger entry failed validation; the index identifies which.",
  },
  {
    code: PARAMETER_WARNING_CODES.LABEL_MISSING,
    parameter: "label",
    httpStatus: 400,
    summary: "The entry label is empty, so failures cannot be attributed.",
  },
  {
    code: PARAMETER_WARNING_CODES.DIVISOR_NOT_INTEGER,
    parameter: "divisor",
    httpStatus: 400,
    summary: "The divisor is not a finite integer.",
  },
  {
    code: PARAMETER_WARNING_CODES.DIVISOR_OUT_OF_RANGE,
    parameter: "divisor",
    httpStatus: 422,
    summary: "The divisor is zero or negative.",
  },
  {
    code: PARAMETER_WARNING_CODES.SCALE_DENOMINATOR_ZERO,
    parameter: "scaleDenominator",
    httpStatus: 422,
    summary: "The scale denominator is zero, so the factor is undefined.",
  },
  {
    code: PARAMETER_WARNING_CODES.SCALE_NUMERATOR_INVALID,
    parameter: "scaleNumerator",
    httpStatus: 400,
    summary: "The scale numerator is not a valid integer amount.",
  },
  {
    code: PARAMETER_WARNING_CODES.TYPE_INVALID,
    parameter: "input",
    httpStatus: 400,
    summary: "An input was of an unsupported type for this calculation.",
  },
];

const DEFINITIONS_BY_CODE = new Map<ParameterWarningCode, ParameterErrorDefinition>(
  PARAMETER_ERROR_DEFINITIONS.map((definition) => [definition.code, definition])
);

/** The published definition for a warning code, if it is a known code. */
export function describeParameterWarning(
  code: ParameterWarningCode
): ParameterErrorDefinition | undefined {
  return DEFINITIONS_BY_CODE.get(code);
}

/** Every warning code has exactly one definition. */
export function listUncoveredParameterCodes(): ParameterWarningCode[] {
  return (Object.values(PARAMETER_WARNING_CODES) as ParameterWarningCode[]).filter(
    (code) => !DEFINITIONS_BY_CODE.has(code)
  );
}

function warn(
  code: ParameterWarningCode,
  parameter: string,
  message: string,
  index: number | null = null,
  calculationCode: OverflowErrorCode | RoundingErrorCode | null = null
): ParameterWarning {
  return { code, parameter, message, index, calculationCode };
}

/**
 * Whether `input` is an amount that `validateLedgerAmount` rejects for being
 * negative (#496), so the warning can name the sign rather than a generic
 * invalid entry.
 */
function isNegativeAmountInput(input: unknown): boolean {
  if (typeof input === "bigint") return input < 0n;
  if (typeof input === "number") {
    return Number.isInteger(input) && (input < 0 || Object.is(input, -0));
  }
  if (typeof input === "string") return input.trim().startsWith("-");
  return false;
}

/**
 * Inspect the parameters of a ledger-sum / rounding call and report every
 * problem individually instead of stopping at the first one, so a caller can
 * see all of the arguments it got wrong in a single pass.
 */
export function collectParameterWarnings(input: {
  amounts?: unknown;
  amount?: unknown;
  label?: unknown;
  divisor?: unknown;
  scaleNumerator?: unknown;
  scaleDenominator?: unknown;
}): ParameterWarning[] {
  const warnings: ParameterWarning[] = [];

  if ("label" in input && (typeof input.label !== "string" || input.label.trim() === "")) {
    warnings.push(
      warn(PARAMETER_WARNING_CODES.LABEL_MISSING, "label", "label must be a non-empty string")
    );
  }

  if ("amounts" in input) {
    const { amounts } = input;
    if (!Array.isArray(amounts)) {
      warnings.push(
        warn(PARAMETER_WARNING_CODES.AMOUNTS_NOT_ARRAY, "amounts", "amounts must be an array")
      );
    } else if (amounts.length === 0) {
      warnings.push(
        warn(PARAMETER_WARNING_CODES.AMOUNTS_EMPTY, "amounts", "amounts must not be empty")
      );
    } else {
      amounts.forEach((entry, index) => {
        if (entry === undefined || entry === null || entry === "") {
          warnings.push(
            warn(
              PARAMETER_WARNING_CODES.AMOUNT_MISSING,
              `amounts[${index}]`,
              "no amount supplied",
              index,
              ERROR_CODES.INVALID_AMOUNT
            )
          );
          return;
        }

        const checked = validateLedgerAmount(entry as string | number | bigint, `amounts[${index}]`);
        if (checked.ok) return;

        if (isNegativeAmountInput(entry)) {
          warnings.push(
            warn(
              PARAMETER_WARNING_CODES.AMOUNT_NEGATIVE,
              `amounts[${index}]`,
              "amounts[i] must not be negative",
              index,
              ERROR_CODES.INVALID_AMOUNT
            )
          );
          return;
        }

        const isDigits = checked.code === ERROR_CODES.EXCESSIVE_DIGITS;
        warnings.push(
          warn(
            isDigits ? PARAMETER_WARNING_CODES.AMOUNT_EXCESSIVE_DIGITS : PARAMETER_WARNING_CODES.ENTRY_INVALID,
            `amounts[${index}]`,
            checked.error,
            index,
            checked.code
          )
        );
      });
    }
  }

  if ("amount" in input) {
    const { amount } = input;
    if (amount === undefined || amount === null || amount === "") {
      warnings.push(warn(PARAMETER_WARNING_CODES.AMOUNT_MISSING, "amount", "amount is required"));
    } else {
      const checked = validateLedgerAmount(amount as string | number | bigint, "amount");
      if (!checked.ok && isNegativeAmountInput(amount)) {
        warnings.push(
          warn(
            PARAMETER_WARNING_CODES.AMOUNT_NEGATIVE,
            "amount",
            "amount must not be negative",
            null,
            ERROR_CODES.INVALID_AMOUNT
          )
        );
      } else if (!checked.ok) {
        const isDigits = checked.code === ERROR_CODES.EXCESSIVE_DIGITS;
        warnings.push(
          warn(
            isDigits ? PARAMETER_WARNING_CODES.AMOUNT_EXCESSIVE_DIGITS : PARAMETER_WARNING_CODES.AMOUNT_NOT_INTEGER,
            "amount",
            checked.error,
            null,
            checked.code
          )
        );
      }
    }
  }

  if ("divisor" in input) {
    const { divisor } = input;
    if (typeof divisor !== "number" || !Number.isFinite(divisor) || !Number.isInteger(divisor)) {
      warnings.push(
        warn(
          PARAMETER_WARNING_CODES.DIVISOR_NOT_INTEGER,
          "divisor",
          "divisor must be a finite integer",
          null,
          ERROR_CODES.ROUNDING_SCALE_INVALID
        )
      );
    } else if (divisor <= 0) {
      warnings.push(
        warn(
          PARAMETER_WARNING_CODES.DIVISOR_OUT_OF_RANGE,
          "divisor",
          "divisor must be greater than zero",
          null,
          ERROR_CODES.ROUNDING_SCALE_INVALID
        )
      );
    }
  }

  if ("scaleDenominator" in input) {
    const checked = validateLedgerAmount(
      input.scaleDenominator as string | number | bigint,
      "scaleDenominator"
    );
    if (checked.ok && checked.value === 0n) {
      warnings.push(
        warn(
          PARAMETER_WARNING_CODES.SCALE_DENOMINATOR_ZERO,
          "scaleDenominator",
          "scaleDenominator must not be zero",
          null,
          ERROR_CODES.ROUNDING_SCALE_INVALID
        )
      );
    } else if (!checked.ok) {
      warnings.push(
        warn(
          PARAMETER_WARNING_CODES.TYPE_INVALID,
          "scaleDenominator",
          checked.error,
          null,
          checked.code
        )
      );
    }
  }

  if ("scaleNumerator" in input) {
    const checked = validateLedgerAmount(
      input.scaleNumerator as string | number | bigint,
      "scaleNumerator"
    );
    if (!checked.ok) {
      warnings.push(
        warn(
          PARAMETER_WARNING_CODES.SCALE_NUMERATOR_INVALID,
          "scaleNumerator",
          checked.error,
          null,
          checked.code
        )
      );
    }
  }

  return warnings;
}

/** The JSON body an API handler returns for a parameter warning. */
export type ParameterErrorResponse = {
  success: false;
  error: {
    code: ParameterWarningCode;
    parameter: string;
    message: string;
    httpStatus: number;
    summary: string;
  };
};

/**
 * Build the response body for a warning. The shape is driven by
 * `PARAMETER_ERROR_DEFINITIONS`, so a new code cannot produce an accidental
 * body shape.
 */
export function toErrorResponse(warning: ParameterWarning, detail?: string): ParameterErrorResponse {
  const definition = describeParameterWarning(warning.code);
  if (!definition) {
    throw new Error(`no error definition registered for parameter code "${warning.code}"`);
  }

  return {
    success: false,
    error: {
      code: definition.code,
      parameter: warning.parameter || definition.parameter,
      message: detail ?? warning.message,
      httpStatus: definition.httpStatus,
      summary: definition.summary,
    },
  };
}

/** The exact key set every parameter error body must carry. */
export const PARAMETER_ERROR_BODY_KEYS = [
  "code",
  "parameter",
  "message",
  "httpStatus",
  "summary",
] as const;

/**
 * Assert a response body matches the definition list: known code, the
 * documented parameter and status, a non-empty message, and no extra keys.
 */
export function matchesErrorDefinition(body: unknown, expectedCode?: ParameterWarningCode): boolean {
  if (typeof body !== "object" || body === null) return false;

  const response = body as Partial<ParameterErrorResponse>;
  if (response.success !== false) return false;
  if (typeof response.error !== "object" || response.error === null) return false;

  const error = response.error as unknown as Record<string, unknown>;
  const definition = describeParameterWarning(error.code as ParameterWarningCode);
  if (!definition) return false;
  if (expectedCode !== undefined && definition.code !== expectedCode) return false;

  if (typeof error.message !== "string" || error.message.trim() === "") return false;
  if (error.httpStatus !== definition.httpStatus) return false;
  if (error.summary !== definition.summary) return false;
  if (typeof error.parameter !== "string" || error.parameter.trim() === "") return false;

  const keys = Object.keys(error).sort();
  const expected = [...PARAMETER_ERROR_BODY_KEYS].sort();
  return keys.length === expected.length && keys.every((key, i) => key === expected[i]);
}

// ---------------------------------------------------------------------------
// TASK 6 – DB-column precision formatting (issue #498)
// ---------------------------------------------------------------------------

/**
 * Database precision schema types for ledger columns.
 * Mirrors `DbPrecisionFormat` in `partial-payment-allocator.ts` so ledger rows
 * use the same storage vocabulary as the rest of the codebase.
 */
export type LedgerDbColumnFormat = "BIGINT" | "DECIMAL" | "TEXT";

export interface LedgerDbColumnSchema {
  field: string;
  format: LedgerDbColumnFormat;
  maxDigits?: number;
  nullable?: boolean;
}

/**
 * Standard database precision schemas for ledger row fields.
 * Amounts are stored as TEXT (exact bigint rendering, no float round-trip);
 * counts/ordinals use BIGINT.
 */
export const STANDARD_LEDGER_DB_SCHEMAS: Record<string, LedgerDbColumnSchema> = {
  amount: {
    field: "amount",
    format: "TEXT",
    maxDigits: MAX_SAFE_DIGITS,
    nullable: false,
  },
  total: {
    field: "total",
    format: "TEXT",
    maxDigits: MAX_SAFE_DIGITS,
    nullable: false,
  },
  entry_index: {
    field: "entry_index",
    format: "BIGINT",
    nullable: false,
  },
};

export interface FormattedLedgerRow {
  amount: string;
  total: string;
  entry_index: number;
  precision_preserved: boolean;
  original_amount_bigint: string;
  original_total_bigint: string;
}

export type LedgerFormatResult =
  | { ok: true; row: FormattedLedgerRow }
  | { ok: false; error: string; code: RoundingErrorCode | typeof ERROR_CODES.FORMAT_INVALID_DECIMALS | typeof ERROR_CODES.FORMAT_PRECISION_LOSS };

/**
 * Format a bigint ledger `value` as a decimal string with exactly `decimals`
 * fractional digits, suitable for a DECIMAL/TEXT column that downstream
 * queries expect at fixed precision.
 *
 * `value` is the already-scaled integer representation; `decimals` restores
 * the point (e.g. 7 decimals maps 10_000_000n to "1.0000000"). With
 * `decimals = 0` the value renders as a plain integer string.
 */
export function formatLedgerValueForDb(value: bigint, decimals = 0): string {
  if (typeof value !== "bigint") {
    throw new TypeError("formatLedgerValueForDb: value must be a bigint");
  }
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(
      `formatLedgerValueForDb: decimals must be a non-negative integer, got ${decimals}`
    );
  }

  if (decimals === 0) {
    return value.toString();
  }

  const isNegative = value < 0n;
  const abs = isNegative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const integerPart = abs / scale;
  const fractionalPart = abs % scale;
  const fracStr = fractionalPart.toString().padStart(decimals, "0");
  const formatted = `${integerPart.toString()}.${fracStr}`;
  return isNegative ? `-${formatted}` : formatted;
}

/**
 * Validate that a formatted ledger value round-trips to the original bigint
 * (for `decimals = 0`) or to the correctly scaled representation, so a write
 * never silently loses precision.
 */
export function validateLedgerFormatPrecision(
  original: bigint,
  formatted: string,
  decimals = 0
): { ok: boolean; precisionLoss: boolean } {
  try {
    if (decimals === 0) {
      const parsed = BigInt(formatted);
      return { ok: true, precisionLoss: parsed !== original };
    }
    const expected = formatLedgerValueForDb(original, decimals);
    return { ok: true, precisionLoss: formatted !== expected };
  } catch {
    return { ok: false, precisionLoss: true };
  }
}

/**
 * Format one ledger entry (amount + running total) for database storage.
 * Both columns render through `formatLedgerValueForDb` and are checked for
 * precision loss before the row is returned, so callers never write a row
 * whose attributes drift from full precision.
 */
export function formatLedgerRowForDb(
  amount: string | number | bigint,
  total: string | number | bigint,
  entryIndex: number,
  decimals = 0
): LedgerFormatResult {
  if (
    typeof entryIndex !== "number" ||
    !Number.isInteger(entryIndex) ||
    entryIndex < 0
  ) {
    return {
      ok: false,
      error: "entryIndex must be a non-negative integer",
      code: ERROR_CODES.FORMAT_INVALID_DECIMALS,
    };
  }
  if (!Number.isInteger(decimals) || decimals < 0) {
    return {
      ok: false,
      error: `decimals must be a non-negative integer, got ${decimals}`,
      code: ERROR_CODES.FORMAT_INVALID_DECIMALS,
    };
  }

  const amountCheck = validateLedgerAmount(amount, "amount");
  if (!amountCheck.ok) {
    return amountCheck as LedgerFormatResult;
  }
  const totalCheck = validateLedgerAmount(total, "total");
  if (!totalCheck.ok) {
    return totalCheck as LedgerFormatResult;
  }

  const formattedAmount = formatLedgerValueForDb(amountCheck.value, decimals);
  const formattedTotal = formatLedgerValueForDb(totalCheck.value, decimals);

  const amountPrecision = validateLedgerFormatPrecision(
    amountCheck.value,
    formattedAmount,
    decimals
  );
  const totalPrecision = validateLedgerFormatPrecision(
    totalCheck.value,
    formattedTotal,
    decimals
  );
  if (!amountPrecision.ok || amountPrecision.precisionLoss || !totalPrecision.ok || totalPrecision.precisionLoss) {
    return {
      ok: false,
      error: "precision loss detected while formatting ledger row for DB storage",
      code: ERROR_CODES.FORMAT_PRECISION_LOSS,
    };
  }

  return {
    ok: true,
    row: {
      amount: formattedAmount,
      total: formattedTotal,
      entry_index: entryIndex,
      precision_preserved: true,
      original_amount_bigint: amountCheck.value.toString(),
      original_total_bigint: totalCheck.value.toString(),
    },
  };
}
