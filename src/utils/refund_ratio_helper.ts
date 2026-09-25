/**
 * Dispute refund percentage splitter with overflow / digit-limit validation.
 * Rejects amounts and ratios whose digit count would risk unsafe numeric overflow.
 */

/** Max decimal digits allowed for a refund amount or ratio (below Number.MAX_SAFE_INTEGER). */
export const MAX_SAFE_DIGITS = 15;

export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "OVERFLOW_EXCESSIVE_DIGITS",
  INVALID_RATIO: "OVERFLOW_INVALID_RATIO",
  PRODUCT_OVERFLOW: "OVERFLOW_PRODUCT_EXCEEDED",
  INVALID_AMOUNT: "REFUND_INVALID_AMOUNT",
  INVALID_RATIO_BPS: "REFUND_INVALID_RATIO_BPS",
} as const;

export type OverflowErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ValidationResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: OverflowErrorCode };

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
 * Validate a refund ratio (integer basis points / scaled percent) against digit limits.
 */
export function validateRefundRatio(
  ratio: string | number | bigint
): ValidationResult {
  return parseIntegerInput(ratio, "ratio", ERROR_CODES.INVALID_RATIO);
}

/**
 * Split a dispute amount by refund ratio after validating both operands for overflow.
 * Ratio is treated as an integer scaled factor (e.g. basis points).
 */
export function applyRefundRatio(
  amount: string | number | bigint,
  ratio: string | number | bigint
): ValidationResult {
  const principal = parseIntegerInput(
    amount,
    "amount",
    ERROR_CODES.INVALID_RATIO
  );
  if (!principal.ok) {
    return principal;
  }

  const factor = validateRefundRatio(ratio);
  if (!factor.ok) {
    return factor;
  }

  const product = principal.value * factor.value;
  if (digitCount(product.toString()) > MAX_SAFE_DIGITS) {
    return {
      ok: false,
      error: `refund share exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
      code: ERROR_CODES.PRODUCT_OVERFLOW,
    };
  }

  return { ok: true, value: product };
}

// ---------------------------------------------------------------------------
// Round-half-to-even refund splitter (#refund rounding)
// ---------------------------------------------------------------------------
//
// `applyRefundRatio` above multiplies by a raw integer factor and rejects any
// overflow, but it never divides — so callers that model a refund as a
// percentage have to perform (and round) the division themselves, and a naive
// `BigInt` division silently truncates the fractional part, leaking value.
//
// The variant below models a refund as `amount * ratioBps / 10000` and rounds
// the quotient using banker's rounding (round-half-to-even): a remainder of
// exactly half the denominator rounds toward the even quotient, everything
// below half truncates, and everything above half rounds up. Because the
// retained amount is always `amount - refundAmount`, the two values
// reconstruct the original amount exactly — no remainder is dropped or leaked.

/** Basis-points denominator (10000 bps = 100%). */
const BPS_DENOMINATOR = 10_000n;

/** Result of applying a refund ratio with round-half-to-even rounding. */
export type RefundHalfEvenOutcome =
  | { ok: true; refundAmount: bigint; retainedAmount: bigint }
  | { ok: false; error: string; code: OverflowErrorCode };

/**
 * Parse and validate a non-negative dispute amount against digit limits.
 */
export function validateRefundAmount(
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
 * Validate a refund ratio expressed in basis points (0-10000, i.e. 0%-100%).
 */
export function validateRefundRatioBps(refundRatioBps: number): ValidationResult {
  if (
    typeof refundRatioBps !== "number" ||
    !Number.isFinite(refundRatioBps) ||
    !Number.isInteger(refundRatioBps)
  ) {
    return {
      ok: false,
      error: "refundRatioBps must be a finite integer",
      code: ERROR_CODES.INVALID_RATIO_BPS,
    };
  }

  if (refundRatioBps < 0 || refundRatioBps > 10_000) {
    return {
      ok: false,
      error: "refundRatioBps must be between 0 and 10000",
      code: ERROR_CODES.INVALID_RATIO_BPS,
    };
  }

  return { ok: true, value: BigInt(refundRatioBps) };
}

/**
 * Apply a refund ratio (basis points) to a dispute amount, rounding the
 * quotient to the nearest even value so the fractional remainder is never
 * dropped or leaked. `refundAmount + retainedAmount` always reconstructs the
 * original amount exactly.
 */
export function applyRefundRatioHalfEven(
  amount: string | number | bigint,
  refundRatioBps: number
): RefundHalfEvenOutcome {
  const base = validateRefundAmount(amount);
  if (!base.ok) {
    return base;
  }

  const rate = validateRefundRatioBps(refundRatioBps);
  if (!rate.ok) {
    return rate;
  }

  const numerator = base.value * rate.value;
  const quotient = numerator / BPS_DENOMINATOR;
  const remainder = numerator % BPS_DENOMINATOR;

  let refundAmount = quotient;
  const twiceRemainder = remainder * 2n;
  if (twiceRemainder > BPS_DENOMINATOR) {
    refundAmount += 1n;
  } else if (twiceRemainder === BPS_DENOMINATOR && quotient % 2n !== 0n) {
    refundAmount += 1n;
  }

  const retainedAmount = base.value - refundAmount;

  return { ok: true, refundAmount, retainedAmount };
}
