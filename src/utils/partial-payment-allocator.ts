/**
 * Partial Payment Allocator
 *
 * The single allocator module for milestone payment division (#630). It
 * covers two steps:
 *
 * 1. Splitting a total across weighted shares (`allocatePartialPayment`),
 *    using bigint arithmetic throughout.
 * 2. Validating an explicit per-recipient split and formatting it to match
 *    database precision schemas (`allocatePayment` and the row helpers),
 *    so full precision is preserved when writing to database row attributes.
 *
 * Remainder policy: integer division can leave a few base units that no
 * share receives. `allocatePartialPayment` never assigns them silently; it
 * returns them as `remainder` so `sum(allocations) + remainder === total`
 * always holds and the caller decides where they go (e.g. add them to the
 * last recipient before calling `allocatePayment`). `allocatePayment`
 * accepts no remainder at all: the recipient amounts must sum exactly to
 * the total or the allocation is rejected with ALLOCATION_MISMATCH.
 *
 * Integer-string DB helpers live in db-precision.ts (#635).
 */

import { validateLedgerAmount } from "./audit_ledger_sum_checker.js";
import { isAmountWithinRange } from "./digit-limit-validator.js";
import { formatAmountForDatabase, parseAmountFromDatabase } from "./db-precision.js";

/**
 * Database precision schema types
 */
export type DbPrecisionFormat = "BIGINT" | "DECIMAL" | "TEXT";

export interface DbPrecisionSchema {
  field: string;
  format: DbPrecisionFormat;
  maxDigits?: number;
  nullable?: boolean;
}

export interface PaymentAllocation {
  milestoneIndex: number;
  totalAmount: bigint;
  allocations: Array<{
    recipient: string;
    amount: bigint;
    formattedAmount: string;
  }>;
  metadata: {
    createdAt: number;
    processedAt?: number;
    status: "pending" | "processed" | "written";
  };
}

export interface FormattedPaymentRow {
  milestone_index: number;
  total_amount: string;
  amount: string;
  recipient: string;
  processed_at: number;
  precision_preserved: boolean;
  original_value_bigint: string;
}

export interface AllocationResult {
  success: boolean;
  allocation?: PaymentAllocation;
  formatted?: FormattedPaymentRow[];
  error?: string;
  code?: string;
  precisionLoss?: boolean;
}

export const PAYMENT_ALLOCATION_ERRORS = {
  INVALID_MILESTONE_INDEX: "PAYMENT_INVALID_MILESTONE_INDEX",
  INVALID_AMOUNT: "PAYMENT_INVALID_AMOUNT",
  NEGATIVE_AMOUNT: "PAYMENT_NEGATIVE_AMOUNT",
  PRECISION_LOSS: "PAYMENT_PRECISION_LOSS",
  FORMAT_MISMATCH: "PAYMENT_FORMAT_MISMATCH",
  ALLOCATION_MISMATCH: "PAYMENT_ALLOCATION_MISMATCH",
  INVALID_RECIPIENT: "PAYMENT_INVALID_RECIPIENT",
  EMPTY_ALLOCATIONS: "PAYMENT_EMPTY_ALLOCATIONS",
} as const;

/**
 * Standard database precision schemas for payment fields
 */
export const STANDARD_PAYMENT_SCHEMAS: Record<string, DbPrecisionSchema> = {
  total_amount: {
    field: "total_amount",
    format: "TEXT",
    maxDigits: 15,
    nullable: false,
  },
  amount: {
    field: "amount",
    format: "TEXT",
    maxDigits: 15,
    nullable: false,
  },
  recipient: {
    field: "recipient",
    format: "TEXT",
    nullable: false,
  },
  milestone_index: {
    field: "milestone_index",
    format: "BIGINT",
    nullable: false,
  },
};

// Integer-string DB helpers live in db-precision.ts (#635).
export { formatAmountForDatabase, parseAmountFromDatabase };

/**
 * Validate that formatting preserves precision
 * Checks round-trip conversion preserves exact value
 */
export function validatePrecisionPreservation(
  original: bigint,
  formatted: string
): { ok: boolean; precisionLoss: boolean } {
  try {
    const parsed = BigInt(formatted);
    const precisionLoss = parsed !== original;
    return { ok: true, precisionLoss };
  } catch {
    return { ok: false, precisionLoss: true };
  }
}

/**
 * Format a complete payment row for database storage
 * Applies all precision and format requirements
 */
export function formatPaymentRowForDatabase(
  milestoneIndex: number,
  totalAmount: bigint,
  recipient: string,
  allocation: bigint
): FormattedPaymentRow {
  const formattedTotal = formatAmountForDatabase(totalAmount);
  const formattedAllocation = formatAmountForDatabase(allocation);

  return {
    milestone_index: milestoneIndex,
    total_amount: formattedTotal,
    amount: formattedAllocation,
    recipient,
    processed_at: Date.now(),
    precision_preserved: true,
    original_value_bigint: formattedAllocation,
  };
}

/**
 * Validate milestone index for database write
 */
export function validateMilestoneIndex(index: unknown): {
  ok: boolean;
  value?: number;
  error?: string;
  code?: string;
} {
  if (typeof index !== "number") {
    return {
      ok: false,
      error: "milestone_index must be a number",
      code: PAYMENT_ALLOCATION_ERRORS.INVALID_MILESTONE_INDEX,
    };
  }

  if (!Number.isInteger(index) || index < 0) {
    return {
      ok: false,
      error: "milestone_index must be a non-negative integer",
      code: PAYMENT_ALLOCATION_ERRORS.INVALID_MILESTONE_INDEX,
    };
  }

  return { ok: true, value: index };
}

/**
 * Validate recipient address format
 */
export function validateRecipient(
  recipient: unknown
): { ok: boolean; error?: string; code?: string } {
  if (typeof recipient !== "string") {
    return {
      ok: false,
      error: "recipient must be a string",
      code: PAYMENT_ALLOCATION_ERRORS.INVALID_RECIPIENT,
    };
  }

  if (recipient.length === 0) {
    return {
      ok: false,
      error: "recipient cannot be empty",
      code: PAYMENT_ALLOCATION_ERRORS.INVALID_RECIPIENT,
    };
  }

  return { ok: true };
}

/**
 * Allocate a milestone payment across multiple recipients
 * Formats all values to match database precision schema
 */
export function allocatePayment(
  milestoneIndex: number,
  totalAmount: string | number | bigint,
  recipients: Array<{ address: string; amount: bigint }>
): AllocationResult {
  // Validate milestone index
  const indexValidation = validateMilestoneIndex(milestoneIndex);
  if (!indexValidation.ok) {
    return {
      success: false,
      error: indexValidation.error,
      code: indexValidation.code,
    };
  }

  // Validate total amount
  const totalValidation = validateLedgerAmount(totalAmount, "totalAmount");
  if (!totalValidation.ok) {
    return {
      success: false,
      error: totalValidation.error,
      code: PAYMENT_ALLOCATION_ERRORS.INVALID_AMOUNT,
    };
  }

  const totalBigInt = totalValidation.value;

  // Validate recipients array
  if (!recipients || recipients.length === 0) {
    return {
      success: false,
      error: "At least one recipient must be provided",
      code: PAYMENT_ALLOCATION_ERRORS.EMPTY_ALLOCATIONS,
    };
  }

  // Validate each recipient
  for (let i = 0; i < recipients.length; i++) {
    const recipient = recipients[i];

    const recipientValidation = validateRecipient(recipient.address);
    if (!recipientValidation.ok) {
      return {
        success: false,
        error: `Recipient ${i}: ${recipientValidation.error}`,
        code: recipientValidation.code,
      };
    }

    if (recipient.amount < 0n) {
      return {
        success: false,
        error: `Recipient ${i}: amount cannot be negative`,
        code: PAYMENT_ALLOCATION_ERRORS.NEGATIVE_AMOUNT,
      };
    }

    if (recipient.amount > totalBigInt) {
      return {
        success: false,
        error: `Recipient ${i}: amount exceeds total`,
        code: PAYMENT_ALLOCATION_ERRORS.INVALID_AMOUNT,
      };
    }
  }

  // Calculate total allocated
  let totalAllocated = 0n;
  for (const recipient of recipients) {
    totalAllocated += recipient.amount;
  }

  // CRITICAL: Verify sum matches total
  if (totalAllocated !== totalBigInt) {
    return {
      success: false,
      error: `Total allocated (${totalAllocated}) does not match total amount (${totalBigInt})`,
      code: PAYMENT_ALLOCATION_ERRORS.ALLOCATION_MISMATCH,
      precisionLoss: false,
    };
  }

  // Format all amounts for database storage
  const formattedRows: FormattedPaymentRow[] = [];

  for (const recipient of recipients) {
    const formatted = formatPaymentRowForDatabase(
      milestoneIndex,
      totalBigInt,
      recipient.address,
      recipient.amount
    );

    // Verify precision is preserved
    const precisionCheck = validatePrecisionPreservation(
      recipient.amount,
      formatted.amount
    );

    if (precisionCheck.precisionLoss) {
      return {
        success: false,
        error: `Precision loss detected for recipient ${recipient.address}`,
        code: PAYMENT_ALLOCATION_ERRORS.PRECISION_LOSS,
        precisionLoss: true,
      };
    }

    formatted.precision_preserved = !precisionCheck.precisionLoss;
    formattedRows.push(formatted);
  }

  const allocation: PaymentAllocation = {
    milestoneIndex,
    totalAmount: totalBigInt,
    allocations: recipients.map((r) => ({
      recipient: r.address,
      amount: r.amount,
      formattedAmount: formatAmountForDatabase(r.amount),
    })),
    metadata: {
      createdAt: Date.now(),
      status: "pending",
    },
  };

  return {
    success: true,
    allocation,
    formatted: formattedRows,
    precisionLoss: false,
  };
}

/**
 * Verify that formatted payment rows match allocation
 * Ensures database writes will preserve precision
 */
export function verifyFormattedPayments(
  allocation: PaymentAllocation,
  formatted: FormattedPaymentRow[]
): { ok: boolean; error?: string; precisionPreserved: boolean } {
  if (formatted.length !== allocation.allocations.length) {
    return {
      ok: false,
      error: "Formatted row count does not match allocation count",
      precisionPreserved: false,
    };
  }

  for (let i = 0; i < formatted.length; i++) {
    const row = formatted[i];
    const alloc = allocation.allocations[i];

    // Verify milestone index
    if (row.milestone_index !== allocation.milestoneIndex) {
      return {
        ok: false,
        error: `Row ${i}: milestone_index mismatch`,
        precisionPreserved: false,
      };
    }

    // Verify recipient
    if (row.recipient !== alloc.recipient) {
      return {
        ok: false,
        error: `Row ${i}: recipient mismatch`,
        precisionPreserved: false,
      };
    }

    // Verify amount format
    if (row.amount !== alloc.formattedAmount) {
      return {
        ok: false,
        error: `Row ${i}: amount format mismatch`,
        precisionPreserved: false,
      };
    }

    // Verify precision preservation flag
    if (!row.precision_preserved) {
      return {
        ok: false,
        error: `Row ${i}: precision not preserved`,
        precisionPreserved: false,
      };
    }

    // Verify round-trip conversion
    try {
      const parsed = BigInt(row.amount);
      if (parsed !== alloc.amount) {
        return {
          ok: false,
          error: `Row ${i}: parsed value does not match original`,
          precisionPreserved: false,
        };
      }
    } catch {
      return {
        ok: false,
        error: `Row ${i}: invalid amount format`,
        precisionPreserved: false,
      };
    }
  }

  return { ok: true, precisionPreserved: true };
}

/**
 * Get database-safe representation of allocation for storage
 * Ensures all rows are properly formatted for database write
 */
export function getFormattedPaymentRows(
  allocation: PaymentAllocation
): FormattedPaymentRow[] {
  return allocation.allocations.map((alloc) =>
    formatPaymentRowForDatabase(
      allocation.milestoneIndex,
      allocation.totalAmount,
      alloc.recipient,
      alloc.amount
    )
  );
}

/**
 * Mark allocation as processed in database
 * Updates metadata to track write status
 */
export function markAllocationProcessed(
  allocation: PaymentAllocation
): PaymentAllocation {
  return {
    ...allocation,
    metadata: {
      ...allocation.metadata,
      processedAt: Date.now(),
      status: "processed",
    },
  };
}

/**
 * Mark allocation as written to database
 */
export function markAllocationWritten(
  allocation: PaymentAllocation
): PaymentAllocation {
  return {
    ...allocation,
    metadata: {
      ...allocation.metadata,
      status: "written",
    },
  };
}

// ---------------------------------------------------------------------------
// Share-weighted allocation
// ---------------------------------------------------------------------------

/** Max decimal digits allowed for a single payment amount (below Number.MAX_SAFE_INTEGER). */
export const MAX_SAFE_DIGITS = 15;

/** Max decimal digits allowed for an intermediate multiplication product before it is divided. */
export const MAX_INTERMEDIATE_DIGITS = MAX_SAFE_DIGITS * 2;

/** Scaling factor used to convert floating-point shares into integer numerators. */
const SHARE_SCALE = 1_000_000;

export const SHARE_ALLOCATION_ERRORS = {
  EXCESSIVE_DIGITS: "ALLOCATOR_EXCESSIVE_DIGITS",
  AMOUNT_OUT_OF_RANGE: "AMOUNT_OUT_OF_RANGE",
  INVALID_AMOUNT: "ALLOCATOR_INVALID_AMOUNT",
  INVALID_SHARES: "ALLOCATOR_INVALID_SHARES",
  ALLOCATION_OVERFLOW: "ALLOCATOR_OVERFLOW",
} as const;

export type ShareAllocationErrorCode =
  (typeof SHARE_ALLOCATION_ERRORS)[keyof typeof SHARE_ALLOCATION_ERRORS];

export type AmountValidationResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: ShareAllocationErrorCode };

export type ShareAllocationOutcome =
  | { ok: true; allocations: bigint[]; remainder: bigint }
  | { ok: false; error: string; code: ShareAllocationErrorCode };

/**
 * Parse and validate a payment amount string/number/bigint. The amount must
 * be an integer within the contract's i128 range.
 */
export function validatePaymentAmount(
  input: string | number | bigint,
  label = "amount"
): AmountValidationResult {
  let raw: string;

  if (typeof input === "bigint") {
    raw = input.toString();
  } else if (typeof input === "number") {
    if (!Number.isFinite(input) || !Number.isInteger(input)) {
      return {
        ok: false,
        error: `${label} must be a finite integer`,
        code: SHARE_ALLOCATION_ERRORS.INVALID_AMOUNT,
      };
    }
    // A JS number above 2^53 has already lost precision; large amounts
    // must arrive as strings or bigints.
    if (!Number.isSafeInteger(input)) {
      return {
        ok: false,
        error: `${label} exceeds Number.MAX_SAFE_INTEGER; pass large amounts as a string or bigint`,
        code: SHARE_ALLOCATION_ERRORS.INVALID_AMOUNT,
      };
    }
    raw = String(input);
  } else {
    raw = input.trim();
    if (!/^-?\d+$/.test(raw)) {
      return {
        ok: false,
        error: `${label} must be an integer numeric value`,
        code: SHARE_ALLOCATION_ERRORS.INVALID_AMOUNT,
      };
    }
  }

  if (!isAmountWithinRange(BigInt(raw))) {
    return {
      ok: false,
      error: `${label} exceeds the i128 amount range`,
      code: SHARE_ALLOCATION_ERRORS.AMOUNT_OUT_OF_RANGE,
    };
  }

  return { ok: true, value: BigInt(raw) };
}

/**
 * Validate the shares array used to weight an allocation. Every share must
 * be a positive, finite number; an empty array is rejected outright.
 */
function validateShares(shares: number[]): AmountValidationResult | null {
  if (!Array.isArray(shares) || shares.length === 0) {
    return {
      ok: false,
      error: "shares must be a non-empty array",
      code: SHARE_ALLOCATION_ERRORS.INVALID_SHARES,
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
        code: SHARE_ALLOCATION_ERRORS.INVALID_SHARES,
      };
    }
  }

  return null;
}

/**
 * Split a total milestone payment amount across the given shares (weights).
 *
 * Each share is scaled to an integer numerator (`round(share * 1e6)`) so
 * floating-point share values are never mixed directly into bigint math;
 * every allocation is then `floor(total * numerator / sum(numerators))`.
 *
 * Remainder policy: the base units left over by the floor division are NOT
 * assigned to any recipient. They are returned as `remainder`, and
 * `sum(allocations) + remainder === total` is guaranteed. The remainder is
 * always in `[0, shares.length)` for a non-negative total.
 */
export function allocatePartialPayment(
  totalAmount: string | number | bigint,
  shares: number[]
): ShareAllocationOutcome {
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
      code: SHARE_ALLOCATION_ERRORS.INVALID_SHARES,
    };
  }

  const allocations: bigint[] = [];
  let allocatedSum = 0n;

  for (let i = 0; i < scaledNumerators.length; i++) {
    const numerator = scaledNumerators[i];
    const product = total * numerator;
    const allocation = product / scaledDenominator;
    allocations.push(allocation);
    allocatedSum += allocation;
  }

  const remainder = total - allocatedSum;

  return { ok: true, allocations, remainder };
}
