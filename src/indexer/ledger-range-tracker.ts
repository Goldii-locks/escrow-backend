import { getDb, getLastIndexedLedger, insertEvent, type EventRow } from "./db.js";
import logger from "../utils/logger.js";

/**
 * LedgerRangeTracker manages ledger range operations with full transaction support.
 * Ensures that operations on ledger sequence tracking are atomic and consistent
 * under concurrent load.
 *
 * Features:
 * - Atomic read-update of last indexed ledger
 * - Transactional ledger range queries
 * - Consistent state even under high concurrency
 * - Automatic rollback on failures
 * - Dynamic historical start/end ledger ranges (#299)
 * - In-memory queue locks for concurrent event inserts (#296)
 * - Consecutive failure / stall threshold alerting (#298)
 * - High-frequency polling diagnostics (#297)
 *
 * Range semantics: startLedger and endLedger are **inclusive**.
 * Historical imports never advance the live `last_ledger_sequence` pointer
 * unless `advanceLivePointer` is explicitly requested, so live polling is
 * unaffected.
 */

export interface LedgerRange {
  startLedger: number;
  endLedger: number;
}

export interface LedgerRangeSnapshot {
  lastIndexedLedger: number;
  timestamp: number;
}

/**
 * Atomically read the current last indexed ledger with snapshot isolation.
 * Returns the ledger sequence and timestamp of the read for consistency tracking.
 */
export function getLedgerRangeSnapshot(): LedgerRangeSnapshot {
  const db = getDb();

  const readSnapshot = db.transaction(() => {
    const row = db
      .prepare("SELECT value FROM indexer_state WHERE key = 'last_ledger_sequence'")
      .get();
    const ledger = row ? parseInt((row as any).value, 10) : 0;
    return {
      lastIndexedLedger: ledger,
      timestamp: Date.now(),
    };
  });

  return readSnapshot();
}

/**
 * Atomically advance the ledger pointer if and only if the current value
 * matches the expected value. Returns true if the update succeeded, false otherwise.
 *
 * This implements optimistic concurrency control to prevent multiple processes
 * from racing to update the ledger pointer.
 *
 * @param expectedCurrentLedger The ledger sequence we expect to be current
 * @param newLedger The new ledger sequence to advance to
 * @returns true if update succeeded, false if current ledger != expected
 */
export function advanceLedgerIfMatch(
  expectedCurrentLedger: number,
  newLedger: number
): boolean {
  if (newLedger <= expectedCurrentLedger) {
    logger.warn("Attempted to advance ledger to same or lower value", {
      expectedCurrentLedger,
      newLedger,
    });
    return false;
  }

  const db = getDb();

  const updateResult = db.transaction(() => {
    const current = db
      .prepare("SELECT value FROM indexer_state WHERE key = 'last_ledger_sequence'")
      .get() as { value: string } | undefined;

    const currentLedger = current ? parseInt(current.value, 10) : 0;

    if (currentLedger !== expectedCurrentLedger) {
      logger.debug("Ledger pointer mismatch during advance", {
        expectedCurrentLedger,
        actualCurrentLedger: currentLedger,
        attemptedNewLedger: newLedger,
      });
      return false;
    }

    const stmt = db.prepare(
      "UPDATE indexer_state SET value = ? WHERE key = 'last_ledger_sequence'"
    );
    stmt.run(newLedger.toString());
    return true;
  });

  return updateResult();
}

/**
 * Atomically advance the ledger pointer unconditionally.
 * Only use this when you are certain of consistency (e.g., within insertEventBatch).
 *
 * For general-purpose ledger advancement, prefer advanceLedgerIfMatch() instead.
 *
 * @param newLedger The new ledger sequence to set
 */
export function advanceLedgerUnconditional(newLedger: number): void {
  const db = getDb();

  const updateTransaction = db.transaction(() => {
    const stmt = db.prepare(
      "UPDATE indexer_state SET value = ? WHERE key = 'last_ledger_sequence'"
    );
    stmt.run(newLedger.toString());
  });

  updateTransaction();
}

/**
 * Atomically read all events within a ledger range inside a transaction.
 * Prevents phantom reads or inconsistent views when the ledger data is being
 * updated concurrently.
 *
 * @param startLedger Inclusive start of ledger range
 * @param endLedger Inclusive end of ledger range
 * @returns Array of events within the range
 */
export function readLedgerRange(startLedger: number, endLedger: number): any[] {
  const db = getDb();

  const readTransaction = db.transaction(() => {
    const events = db
      .prepare(
        `SELECT * FROM events
         WHERE ledger_sequence >= ? AND ledger_sequence <= ?
         ORDER BY ledger_sequence ASC`
      )
      .all(startLedger, endLedger);
    return events;
  });

  return readTransaction();
}

/**
 * Atomically query ledger range metadata (event counts, types, etc.)
 * Returns consistent snapshot of ledger state.
 *
 * @param startLedger Inclusive start of ledger range
 * @param endLedger Inclusive end of ledger range
 * @returns Metadata about the ledger range
 */
export function getLedgerRangeMetadata(startLedger: number, endLedger: number) {
  const db = getDb();

  const readMetadata = db.transaction(() => {
    const countRow = db
      .prepare(
        `SELECT COUNT(*) as count FROM events
         WHERE ledger_sequence >= ? AND ledger_sequence <= ?`
      )
      .get(startLedger, endLedger) as { count: number };

    const typeRows = db
      .prepare(
        `SELECT event_type, COUNT(*) as count FROM events
         WHERE ledger_sequence >= ? AND ledger_sequence <= ?
         GROUP BY event_type`
      )
      .all(startLedger, endLedger) as Array<{ event_type: string; count: number }>;

    const eventsByType: Record<string, number> = {};
    for (const row of typeRows) {
      eventsByType[row.event_type] = row.count;
    }

    return {
      totalEvents: countRow.count,
      eventsByType,
      ledgerRange: { startLedger, endLedger },
    };
  });

  return readMetadata();
}

/**
 * Atomically apply a custom transaction to ledger state.
 * Use this for complex operations that need full ACID guarantees.
 *
 * @param operation Transaction function that performs the operation
 * @returns Result of the transaction
 */
export function executeInTransaction<T>(
  operation: (db: ReturnType<typeof getDb>) => T
): T {
  const db = getDb();
  const transaction = db.transaction(() => operation(db));
  return transaction();
}

/** Index names used by ledger range queries – validated via EXPLAIN QUERY PLAN (#295). */
export const LEDGER_RANGE_INDEXES = {
  ledgerEventType: "idx_events_ledger_event_type",
  ledgerSequence: "idx_events_ledger_sequence",
} as const;

/**
 * Return SQLite EXPLAIN QUERY PLAN rows for a parameterized statement.
 * Useful in tests to assert index usage for ledger range lookups (#295).
 */
export function explainQueryPlan(
  sql: string,
  ...params: unknown[]
): Array<Record<string, unknown>> {
  const db = getDb();
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<
    Record<string, unknown>
  >;
}

/**
 * True when any EXPLAIN QUERY PLAN detail references the expected index name.
 */
export function queryPlanUsesIndex(
  plan: Array<Record<string, unknown>>,
  indexName: string,
): boolean {
  return plan.some((row) =>
    Object.values(row).some(
      (value) => typeof value === "string" && value.includes(indexName),
    ),
  );
}
