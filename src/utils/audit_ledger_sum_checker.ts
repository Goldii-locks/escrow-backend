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
