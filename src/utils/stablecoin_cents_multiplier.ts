/**
 * Stablecoin cents multiplier with overflow / digit-limit validation.
 * Integer precision conversion helper converting between dollar decimal
 * amounts and integer cents (multiplier 100), rejecting inputs whose
 * digit count would risk unsafe numeric overflow.
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
  INVALID_MULTIPLIER: "CENTS_INVALID_MULTIPLIER",
  PRODUCT_OVERFLOW: "CENTS_PRODUCT_OVERFLOW",
} as const;

export type CentsErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ConversionResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: CentsErrorCode };

export type DollarsResult =
  | { ok: true; value: string }
  | { ok: false; error: string; code: CentsErrorCode };

function digitCount(normalized: string): number {
  const digits = normalized.replace(/^-/, "").replace(/^0+(?=\d)/, "");
  return digits.length === 0 ? 1 : digits.length;
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

// ---------------------------------------------------------------------------
// Cents multiplier with overflow guards (#476)
// ---------------------------------------------------------------------------
//
// The dollars/cents helpers above convert between representations. These apply
// an arbitrary integer multiplier to an amount already in cents, rejecting a
// product that would outgrow MAX_SAFE_DIGITS before it is returned.
//
// Unlike validateCentsAmount, a multiplier may be negative -- a reversal or a
// debit adjustment is a legitimate factor -- so this path parses signed input.

function parseSignedInteger(
  input: string | number | bigint,
  label: string,
  invalidCode: CentsErrorCode
): ConversionResult {
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
 * Validate a cents multiplier against digit limits.
 */
export function validateMultiplier(
  multiplier: string | number | bigint
): ConversionResult {
  return parseSignedInteger(
    multiplier,
    "multiplier",
    ERROR_CODES.INVALID_MULTIPLIER
  );
}

/** Alias for validateMultiplier. */
export const validateCentsMultiplier = validateMultiplier;

/**
 * Multiply a stablecoin cents amount by a multiplier factor after validating
 * both operands, and reject a product that exceeds the safe digit limit.
 */
export function applyCentsMultiplier(
  amount: string | number | bigint,
  multiplier: string | number | bigint
): ConversionResult {
  const amountCheck = parseSignedInteger(
    amount,
    "amount",
    ERROR_CODES.INVALID_MULTIPLIER
  );
  if (!amountCheck.ok) {
    return amountCheck;
  }

  const factor = validateMultiplier(multiplier);
  if (!factor.ok) {
    return factor;
  }

  const product = amountCheck.value * factor.value;
  if (digitCount(product.toString()) > MAX_SAFE_DIGITS) {
    return {
      ok: false,
      error: `multiplied value exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
      code: ERROR_CODES.PRODUCT_OVERFLOW,
    };
  }

  return { ok: true, value: product };
}

/** Alias for applyCentsMultiplier. */
export const multiplyStablecoinCents = applyCentsMultiplier;
