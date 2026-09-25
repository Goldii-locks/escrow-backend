/**
 * Ledger transaction sum checker with overflow / digit-limit validation.
 * Rejects inputs whose digit count would risk unsafe numeric overflow.
 */

/** Max decimal digits allowed for a single ledger amount (below Number.MAX_SAFE_INTEGER). */
export const MAX_SAFE_DIGITS = 15;

export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "OVERFLOW_EXCESSIVE_DIGITS",
  INVALID_AMOUNT: "OVERFLOW_INVALID_AMOUNT",
  SUM_OVERFLOW: "OVERFLOW_SUM_EXCEEDED",
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

/**
 * Parse and validate a ledger amount string/number against digit limits.
 */
export function validateLedgerAmount(
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
