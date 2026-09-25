/**
 * Partial payment allocator with overflow / digit-limit validation.
 * Splits a milestone payment amount across multiple recipients/shares
 * (e.g. freelancer + platform fee + arbiter cut) while rejecting inputs
 * whose digit count would risk unsafe numeric overflow during the
 * underlying multiplication/division math.
 */

/** Max decimal digits allowed for a single payment amount (below Number.MAX_SAFE_INTEGER). */
export const MAX_SAFE_DIGITS = 15;

/** Max decimal digits allowed for an intermediate multiplication product before it is divided. */
export const MAX_INTERMEDIATE_DIGITS = MAX_SAFE_DIGITS * 2;

/** Scaling factor used to convert floating-point shares into integer numerators. */
const SHARE_SCALE = 1_000_000;

export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "ALLOCATOR_EXCESSIVE_DIGITS",
  INVALID_AMOUNT: "ALLOCATOR_INVALID_AMOUNT",
  INVALID_SHARES: "ALLOCATOR_INVALID_SHARES",
  ALLOCATION_OVERFLOW: "ALLOCATOR_OVERFLOW",
} as const;

export type OverflowErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ValidationResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: OverflowErrorCode };

export type AllocationOutcome =
  | { ok: true; allocations: bigint[]; remainder: bigint }
  | { ok: false; error: string; code: OverflowErrorCode };

function digitCount(normalized: string): number {
  const digits = normalized.replace(/^-/, "").replace(/^0+(?=\d)/, "");
  return digits.length === 0 ? 1 : digits.length;
}

/**
 * Parse and validate a payment amount string/number against digit limits.
 */
export function validatePaymentAmount(
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
 * Validate the shares array used to weight an allocation. Every share must
 * be a positive, finite number; an empty array is rejected outright.
 */
function validateShares(shares: number[]): ValidationResult | null {
  if (!Array.isArray(shares) || shares.length === 0) {
    return {
      ok: false,
      error: "shares must be a non-empty array",
      code: ERROR_CODES.INVALID_SHARES,
    };
  }

  for (let i = 0; i < shares.length; i++) {
    const share = shares[i];
    if (
      typeof share !== "number" ||
      !Number.isFinite(share) ||
      share <= 0
    ) {
      return {
        ok: false,
        error: `shares[${i}] must be a positive finite number`,
        code: ERROR_CODES.INVALID_SHARES,
      };
    }
  }

  return null;
}

/**
 * Split a total milestone payment amount across the given shares (weights),
 * using scaled integer/bigint arithmetic throughout so floating-point share
 * values are never mixed directly into bigint math. Every intermediate
 * multiplication is digit-checked before it is performed, so an overflowing
 * product is rejected with ALLOCATOR_OVERFLOW rather than silently computed.
 */
export function allocatePartialPayment(
  totalAmount: string | number | bigint,
  shares: number[]
): AllocationOutcome {
  const amountCheck = validatePaymentAmount(totalAmount, "totalAmount");
  if (!amountCheck.ok) {
    return amountCheck;
  }

  const sharesError = validateShares(shares);
  if (sharesError && !sharesError.ok) {
    return sharesError;
  }

  const total = amountCheck.value;

  // Scale each share into an integer numerator, and use a single shared
  // denominator (the sum of scaled numerators) so the split is exact.
  const scaledNumerators = shares.map((s) => BigInt(Math.round(s * SHARE_SCALE)));
  const scaledDenominator = scaledNumerators.reduce((acc, n) => acc + n, 0n);

  if (scaledDenominator <= 0n) {
    return {
      ok: false,
      error: "shares must sum to a positive value",
      code: ERROR_CODES.INVALID_SHARES,
    };
  }

  const allocations: bigint[] = [];
  let allocatedSum = 0n;

  for (let i = 0; i < scaledNumerators.length; i++) {
    const numerator = scaledNumerators[i];
    const product = total * numerator;

    if (digitCount(product.toString()) > MAX_INTERMEDIATE_DIGITS) {
      return {
        ok: false,
        error: `allocation for shares[${i}] would overflow during multiplication`,
        code: ERROR_CODES.ALLOCATION_OVERFLOW,
      };
    }

    const allocation = product / scaledDenominator;
    allocations.push(allocation);
    allocatedSum += allocation;
  }

  const remainder = total - allocatedSum;

  return { ok: true, allocations, remainder };
}
