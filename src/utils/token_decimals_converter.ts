/**
 * Token decimals converter with overflow / digit-limit validation.
 * Converts between a Soroban token's raw on-chain integer amount and its
 * human-readable decimal amount, rejecting inputs whose digit count or
 * decimals value would risk unsafe numeric overflow when scaling by
 * 10^decimals.
 */

/** Max decimal digits allowed for a single amount (below Number.MAX_SAFE_INTEGER). */
export const MAX_SAFE_DIGITS = 15;

/**
 * Practical upper bound for a token's `decimals` value used by this converter.
 * The SEP-41 token interface technically allows `decimals()` to be any u32
 * (up to 255), but real Soroban/Stellar tokens use values in the 0-18 range.
 * Capping at 18 keeps the 10^decimals scaling factor safe to combine with
 * MAX_SAFE_DIGITS without risking silent precision loss or overflow.
 */
export const MAX_TOKEN_DECIMALS = 18;

export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "DECIMALS_EXCESSIVE_DIGITS",
  INVALID_AMOUNT: "DECIMALS_INVALID_AMOUNT",
  INVALID_DECIMALS: "DECIMALS_INVALID_DECIMALS",
  CONVERSION_OVERFLOW: "DECIMALS_CONVERSION_OVERFLOW",
} as const;

export type DecimalsErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ConversionResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: DecimalsErrorCode };

function digitCount(normalized: string): number {
  const digits = normalized.replace(/^-/, "").replace(/^0+(?=\d)/, "");
  return digits.length === 0 ? 1 : digits.length;
}

/**
 * Validate a token's `decimals` value against the practical safe range.
 */
export function validateDecimals(
  decimals: number
): { ok: true } | { ok: false; error: string; code: DecimalsErrorCode } {
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

  if (decimals < 0 || decimals > MAX_TOKEN_DECIMALS) {
    return {
      ok: false,
      error: `decimals must be between 0 and ${MAX_TOKEN_DECIMALS}`,
      code: ERROR_CODES.INVALID_DECIMALS,
    };
  }

  return { ok: true };
}

/**
 * Parse and validate a raw (integer, on-chain) token amount against digit limits.
 */
export function validateRawAmount(
  input: string | number | bigint,
  label = "amount"
): ConversionResult {
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
    raw = input.trim();
    if (!/^-?\d+$/.test(raw)) {
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
 * Convert a human-readable decimal amount (e.g. "12.5") into raw integer
 * units by scaling with the token's decimals value (raw = human * 10^decimals).
 */
export function toRawUnits(
  humanAmount: string | number,
  decimals: number
): ConversionResult {
  const decimalsCheck = validateDecimals(decimals);
  if (!decimalsCheck.ok) {
    return decimalsCheck;
  }

  if (
    typeof humanAmount === "number" &&
    !Number.isFinite(humanAmount)
  ) {
    return {
      ok: false,
      error: "amount must be a finite number",
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  const raw = String(humanAmount).trim();
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    return {
      ok: false,
      error: "amount must be a numeric decimal value",
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [wholePart, fractionalPart = ""] = unsigned.split(".");

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
      code: ERROR_CODES.CONVERSION_OVERFLOW,
    };
  }

  const value = BigInt(combined) * (negative ? -1n : 1n);
  return { ok: true, value };
}

/**
 * Convert a raw integer token amount back into a human-readable decimal
 * string by inserting the decimal point at the position given by decimals.
 */
export function toHumanUnits(
  rawAmount: string | number | bigint,
  decimals: number
): { ok: true; value: string } | { ok: false; error: string; code: DecimalsErrorCode } {
  const decimalsCheck = validateDecimals(decimals);
  if (!decimalsCheck.ok) {
    return decimalsCheck;
  }

  const rawCheck = validateRawAmount(rawAmount, "rawAmount");
  if (!rawCheck.ok) {
    return rawCheck;
  }

  const negative = rawCheck.value < 0n;
  const digits = (negative ? -rawCheck.value : rawCheck.value).toString();

  if (decimals === 0) {
    return { ok: true, value: `${negative ? "-" : ""}${digits}` };
  }

  const padded = digits.padStart(decimals + 1, "0");
  const wholePart = padded.slice(0, padded.length - decimals);
  const fractionalPart = padded.slice(padded.length - decimals);
  const trimmedFractional = fractionalPart.replace(/0+$/, "");

  const value = trimmedFractional.length > 0
    ? `${wholePart}.${trimmedFractional}`
    : wholePart;

  return { ok: true, value: `${negative ? "-" : ""}${value}` };
}
