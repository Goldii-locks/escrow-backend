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
  SUM_MISMATCH: "OVERFLOW_SUM_MISMATCH",
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
 * Validate a refund amount (split share or base total) against digit limits.
 */
export function validateRefundAmount(
  input: string | number | bigint,
  label = "amount"
): ValidationResult {
  return parseIntegerInput(input, label, ERROR_CODES.INVALID_RATIO);
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

/**
 * Confirm that a set of split refund amounts sums exactly to the given base
 * amount, rejecting allocations that over- or under-allocate the total.
 */
export function validateRefundSplitSum(
  parts: Array<string | number | bigint>,
  baseAmount: string | number | bigint
): ValidationResult {
  let total = 0n;

  for (let i = 0; i < parts.length; i++) {
    const checked = validateRefundAmount(parts[i], `parts[${i}]`);
    if (!checked.ok) {
      return checked;
    }
    total += checked.value;
  }

  const baseCheck = validateRefundAmount(baseAmount, "baseAmount");
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
