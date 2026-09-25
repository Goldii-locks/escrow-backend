/**
 * Partial Payment Allocator
 *
 * Formats values calculated during milestone payment division to match
 * database precision schemas. Ensures full precision is preserved when
 * writing to database row attributes.
 *
 * Key responsibilities:
 * - Convert payment amounts to database-compatible formats
 * - Preserve full precision (no rounding errors)
 * - Validate format compliance before database writes
 * - Track allocation state atomically
 */

import { validateLedgerAmount } from "./audit_ledger_sum_checker.js";

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

/**
 * Format a BigInt amount as a database-safe string
 * Preserves full precision without scientific notation
 */
export function formatAmountForDatabase(amount: bigint): string {
  // Convert BigInt to string directly (no precision loss)
  return amount.toString();
}

/**
 * Parse a database formatted amount back to BigInt
 * Ensures no precision loss during round-trip
 */
export function parseAmountFromDatabase(formatted: string): bigint {
  try {
    return BigInt(formatted);
  } catch (error) {
    throw new Error(`Invalid database amount format: ${formatted}`);
  }
}

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
  let precisionLoss = false;

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
      precisionLoss = true;
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
