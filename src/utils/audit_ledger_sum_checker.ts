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
} as const;

export type OverflowErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ValidationResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: OverflowErrorCode };

/**
 * Parse and validate a ledger amount string/number against digit limits.
 */
export function validateLedgerAmount(
  input: string | number | bigint,
  label = "amount"
): ValidationResult {
  return parseIntegerInput(
    input,
    label,
    ERROR_CODES.INVALID_AMOUNT,
    ERROR_CODES.EXCESSIVE_DIGITS
  );
}

/**
 * Sum ledger entry amounts after validating each against overflow digit limits.
 */
export function sumLedgerAmounts(
  amounts: Array<string | number | bigint>
): ValidationResult {
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

// ---------------------------------------------------------------------------
// TASK 5 – DB-column precision formatting (issue #498)
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
