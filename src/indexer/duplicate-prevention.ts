import { getDb } from "./db.js";
import logger from "../utils/logger.js";

/**
 * DuplicatePrevention manages unique constraint enforcement for event ingestion
 * with support for dynamic historical sync ranges.
 *
 * During historical backfill, operators can specify an arbitrary start/end ledger
 * range. The module ensures events within that range are deduplicated against
 * existing data before bulk insertion, and tracks which ranges have been synced.
 *
 * Concurrent callers are serialized per sync range and per event dedup key so
 * overlapping notifications cannot produce conflicting inserts or metadata (#287).
 */

export interface SyncRange {
  startLedger: number;
  endLedger: number;
}

export interface DuplicateCheckResult {
  /** Number of events that would be duplicates (skipped) */
  duplicatesFound: number;
  /** Number of events that are new (inserted) */
  newEventsInserted: number;
  /** Total events processed in the batch */
  totalProcessed: number;
}

export interface DuplicatePreventionEventInput {
  contractId: string;
  eventType: string;
  ledgerSequence: number;
  timestamp: number;
  dataJson: string;
}

/** Simulated RPC notification shape for integration tests and ingest helpers (#293). */
export interface RpcEventNotification {
  contractId: string;
  eventType: string;
  ledger: number;
  timestamp?: number;
  value: unknown;
}

const inFlightBySyncRange = new Map<string, Promise<DuplicateCheckResult>>();
const inFlightByEventKey = new Map<string, Promise<unknown>>();

/** Optional hook used by tests to observe event-lock serialization (#287). */
let eventLockHookForTests: ((key: string) => Promise<void>) | null = null;

/** Optional hook used by tests to simulate post-insert metadata failures (#287). */
let beforeSyncRangeWriteHookForTests: (() => void) | null = null;

/** Test helper – clears in-memory lock maps between cases. */
export function resetDuplicatePreventionLocksForTests(): void {
  inFlightBySyncRange.clear();
  inFlightByEventKey.clear();
  eventLockHookForTests = null;
  beforeSyncRangeWriteHookForTests = null;
}

/** Test helper – observe or gate event-lock acquisition in concurrency tests. */
export function setEventLockHookForTests(
  hook: ((key: string) => Promise<void>) | null,
): void {
  eventLockHookForTests = hook;
}

/** Test helper – throw from inside the dedup transaction before sync_ranges write. */
export function setBeforeSyncRangeWriteHookForTests(hook: (() => void) | null): void {
  beforeSyncRangeWriteHookForTests = hook;
}

function eventDedupKey(
  contractId: string,
  ledgerSequence: number,
  eventType: string,
): string {
  return `${contractId}:${ledgerSequence}:${eventType}`;
}

function syncRangeKey(range: SyncRange): string {
  return `${range.startLedger}:${range.endLedger}`;
}

function logDuplicatePreventionDiagnostics(
  startMs: number,
  events: DuplicatePreventionEventInput[],
  syncRange: SyncRange,
  result: DuplicateCheckResult,
): void {
  const elapsedMs = Math.round(performance.now() - startMs);
  const payloadSizeBytes = JSON.stringify(events).length;

  logger.debug("Duplicate prevention poll diagnostics", {
    elapsedMs,
    payloadSizeBytes,
    eventCount: events.length,
    startLedger: syncRange.startLedger,
    endLedger: syncRange.endLedger,
    newEventsInserted: result.newEventsInserted,
    duplicatesFound: result.duplicatesFound,
    totalProcessed: result.totalProcessed,
  });
}

function insertEventsWithDedupCore(
  events: DuplicatePreventionEventInput[],
  syncRange: SyncRange,
): DuplicateCheckResult {
  const db = getDb();
  let duplicatesFound = 0;
  let newEventsInserted = 0;

  const write = db.transaction(() => {
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO events
      (contract_id, event_type, ledger_sequence, timestamp, data_json)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const ev of events) {
      const result = insertStmt.run(
        ev.contractId,
        ev.eventType,
        ev.ledgerSequence,
        ev.timestamp,
        ev.dataJson,
      );
      if (result.changes > 0) {
        newEventsInserted++;
      } else {
        duplicatesFound++;
      }
    }

    initializeSyncRangesTable();

    if (beforeSyncRangeWriteHookForTests) {
      beforeSyncRangeWriteHookForTests();
    }

    db.prepare(
      `INSERT OR IGNORE INTO sync_ranges (start_ledger, end_ledger, event_count, duplicate_count)
       VALUES (?, ?, ?, ?)`,
    ).run(
      syncRange.startLedger,
      syncRange.endLedger,
      newEventsInserted,
      duplicatesFound,
    );
  });

  write();

  logger.info("Historical sync completed", {
    startLedger: syncRange.startLedger,
    endLedger: syncRange.endLedger,
    newEventsInserted,
    duplicatesFound,
    totalProcessed: events.length,
  });

  return {
    duplicatesFound,
    newEventsInserted,
    totalProcessed: events.length,
  };
}

function uniqueSortedEventKeys(events: DuplicatePreventionEventInput[]): string[] {
  return [
    ...new Set(
      events.map((ev) =>
        eventDedupKey(ev.contractId, ev.ledgerSequence, ev.eventType),
      ),
    ),
  ].sort();
}

async function withEventLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = inFlightByEventKey.get(key) ?? Promise.resolve();
  const run = prior.then(async () => {
    if (eventLockHookForTests) {
      await eventLockHookForTests(key);
    }
    return operation();
  }, async () => operation());
  inFlightByEventKey.set(key, run);

  try {
    return await run;
  } finally {
    if (inFlightByEventKey.get(key) === run) {
      inFlightByEventKey.delete(key);
    }
  }
}

async function withSortedEventLocks<T>(
  sortedKeys: string[],
  operation: () => T,
): Promise<T> {
  if (sortedKeys.length === 0) {
    return operation();
  }

  const [head, ...tail] = sortedKeys;
  return withEventLock(head, async () => withSortedEventLocks(tail, operation));
}

async function insertEventsWithDedupLocked(
  events: DuplicatePreventionEventInput[],
  syncRange: SyncRange,
): Promise<DuplicateCheckResult> {
  const pollStart = performance.now();
  const eventKeys = uniqueSortedEventKeys(events);

  const result = await withSortedEventLocks(eventKeys, () =>
    insertEventsWithDedupCore(events, syncRange),
  );

  logDuplicatePreventionDiagnostics(pollStart, events, syncRange, result);
  return result;
}

/**
 * Async, lock-protected insert for concurrent duplicate_prevention callers (#287).
 * Serializes work per sync range; duplicate logical events share an event-level lock.
 */
export async function insertEventsWithDedupAsync(
  events: DuplicatePreventionEventInput[],
  syncRange: SyncRange,
): Promise<DuplicateCheckResult> {
  const rangeKey = syncRangeKey(syncRange);
  const prior = inFlightBySyncRange.get(rangeKey);
  const run = () => insertEventsWithDedupLocked(events, syncRange);
  const chained = prior ? prior.then(() => run(), () => run()) : run();

  inFlightBySyncRange.set(rangeKey, chained);

  try {
    return await chained;
  } finally {
    if (inFlightBySyncRange.get(rangeKey) === chained) {
      inFlightBySyncRange.delete(rangeKey);
    }
  }
}

/**
 * Map simulated RPC notifications into duplicate_prevention and persist (#293).
 */
export async function ingestRpcEventNotifications(
  rpcEvents: RpcEventNotification[],
  syncRange: SyncRange,
): Promise<DuplicateCheckResult> {
  const events = rpcEvents.map((event) => ({
    contractId: event.contractId,
    eventType: event.eventType,
    ledgerSequence: event.ledger,
    timestamp: event.timestamp ?? Math.floor(Date.now() / 1000),
    dataJson: JSON.stringify(event.value),
  }));

  return insertEventsWithDedupAsync(events, syncRange);
}

/** Create the sync_ranges tracking table if it doesn't exist. */
export function initializeSyncRangesTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_ranges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      start_ledger INTEGER NOT NULL,
      end_ledger INTEGER NOT NULL,
      event_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(start_ledger, end_ledger)
    );
  `);
}

/**
 * Check if a ledger sequence falls within any already-synced range.
 */
export function isLedgerSynced(ledgerSequence: number): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM sync_ranges
       WHERE start_ledger <= ? AND end_ledger >= ?
       LIMIT 1`,
    )
    .get(ledgerSequence, ledgerSequence);
  return row !== undefined;
}

/**
 * Get all completed sync ranges, ordered by start ledger.
 */
export function getSyncedRanges(): Array<{
  id: number;
  startLedger: number;
  endLedger: number;
  eventCount: number;
  duplicateCount: number;
  createdAt: string;
}> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, start_ledger, end_ledger, event_count, duplicate_count, created_at
       FROM sync_ranges
       WHERE status = 'completed'
       ORDER BY start_ledger ASC`,
    )
    .all() as Array<{
    id: number;
    start_ledger: number;
    end_ledger: number;
    event_count: number;
    duplicate_count: number;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    startLedger: r.start_ledger,
    endLedger: r.end_ledger,
    eventCount: r.event_count,
    duplicateCount: r.duplicate_count,
    createdAt: r.created_at,
  }));
}

/**
 * Find gaps in synced ledger coverage up to a given maxLedger.
 * Returns ranges [start, end] that have NOT been synced.
 */
export function findUnsyncedRanges(
  minLedger: number,
  maxLedger: number,
): SyncRange[] {
  const synced = getSyncedRanges();
  const gaps: SyncRange[] = [];
  let cursor = minLedger;

  for (const range of synced) {
    if (range.startLedger > cursor) {
      gaps.push({ startLedger: cursor, endLedger: range.startLedger - 1 });
    }
    cursor = Math.max(cursor, range.endLedger + 1);
  }

  if (cursor <= maxLedger) {
    gaps.push({ startLedger: cursor, endLedger: maxLedger });
  }

  return gaps;
}

/**
 * Insert events for a given ledger range, skipping duplicates.
 * Uses INSERT OR IGNORE at the DB level for idempotency, and tracks the
 * sync range metadata atomically.
 *
 * @param events - Array of event rows to insert
 * @param syncRange - The ledger range being synced
 * @returns DuplicateCheckResult with counts
 */
export function insertEventsWithDedup(
  events: DuplicatePreventionEventInput[],
  syncRange: SyncRange,
): DuplicateCheckResult {
  const pollStart = performance.now();
  const result = insertEventsWithDedupCore(events, syncRange);
  logDuplicatePreventionDiagnostics(pollStart, events, syncRange, result);
  return result;
}

/**
 * Count events within a given ledger range.
 */
export function countEventsInRange(
  startLedger: number,
  endLedger: number,
): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM events
       WHERE ledger_sequence >= ? AND ledger_sequence <= ?`,
    )
    .get(startLedger, endLedger) as { cnt: number };
  return row.cnt;
}

/**
 * Delete event data for a specific ledger range (useful for re-sync).
 */
export function deleteEventsInRange(
  startLedger: number,
  endLedger: number,
): number {
  const db = getDb();
  const result = db
    .prepare(
      `DELETE FROM events
       WHERE ledger_sequence >= ? AND ledger_sequence <= ?`,
    )
    .run(startLedger, endLedger);

  const hasSyncRanges = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_ranges'")
    .get();
  if (hasSyncRanges) {
    db.prepare(
      `DELETE FROM sync_ranges
       WHERE start_ledger >= ? AND end_ledger <= ?`,
    ).run(startLedger, endLedger);
  }

  return result.changes;
}
