/**
 * Ledger transaction sum checker with overflow / digit-limit validation.
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
