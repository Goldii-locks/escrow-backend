import type { EventRow } from "./db.js";

export interface LedgerRange {
  startLedger: number;
  endLedger: number;
}

export const DEFAULT_LEDGER_RANGE_PAGE_SIZE = 100;

export class LedgerRangeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerRangeValidationError";
  }
}

function isValidLedger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value >= 1
  );
}

export function validateLedgerRange(
  startLedger: unknown,
  endLedger: unknown
): LedgerRange {
  if (!isValidLedger(startLedger)) {
    throw new LedgerRangeValidationError(
      `start ledger must be a positive integer, received ${String(startLedger)}`
    );
  }
  if (!isValidLedger(endLedger)) {
    throw new LedgerRangeValidationError(
      `end ledger must be a positive integer, received ${String(endLedger)}`
    );
  }
  if (startLedger > endLedger) {
    throw new LedgerRangeValidationError(
      `start ledger must not exceed end ledger (start=${startLedger}, end=${endLedger})`
    );
  }
  return { startLedger, endLedger };
}

export function resolveHistoricalLedgerRange(options: {
  startLedger?: number;
  endLedger?: number;
  defaultStart?: number;
  defaultEnd?: number;
} = {}): LedgerRange {
  const start =
    options.startLedger ??
    (process.env.LEDGER_RANGE_START
      ? parseInt(process.env.LEDGER_RANGE_START, 10)
      : undefined) ??
    options.defaultStart;
  const end =
    options.endLedger ??
    (process.env.LEDGER_RANGE_END
      ? parseInt(process.env.LEDGER_RANGE_END, 10)
      : undefined) ??
    options.defaultEnd;

  if (start === undefined) {
    throw new LedgerRangeValidationError(
      "start ledger is required: pass startLedger or set LEDGER_RANGE_START"
    );
  }
  if (end === undefined) {
    throw new LedgerRangeValidationError(
      "end ledger is required: pass endLedger or set LEDGER_RANGE_END"
    );
  }
  return validateLedgerRange(start, end);
}

export function chunkLedgerRange(
  range: LedgerRange,
  pageSize: number = DEFAULT_LEDGER_RANGE_PAGE_SIZE
): LedgerRange[] {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new LedgerRangeValidationError(
      `page size must be a positive integer, received ${String(pageSize)}`
    );
  }
  const pages: LedgerRange[] = [];
  for (let start = range.startLedger; start <= range.endLedger; start += pageSize) {
    pages.push({
      startLedger: start,
      endLedger: Math.min(start + pageSize - 1, range.endLedger),
    });
  }
  return pages;
}

export function filterEventsToRange(
  events: EventRow[],
  range: LedgerRange
): EventRow[] {
  return events.filter(
    (ev) =>
      ev.ledgerSequence >= range.startLedger &&
      ev.ledgerSequence <= range.endLedger
  );
}

export function eventIdentityKey(
  event: Pick<EventRow, "contractId" | "eventType" | "ledgerSequence">
): string {
  return `${event.contractId}|${event.ledgerSequence}|${event.eventType}`;
}
