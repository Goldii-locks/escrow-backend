import { getDb } from "./db.js";
import logger from "../utils/logger.js";

/** Index names used by sync-ranges lookups – validated via EXPLAIN QUERY PLAN (#250). */
export const SYNC_RANGES_INDEXES = {
  ledgers: "idx_sync_ranges_ledgers",
} as const;

// ---------------------------------------------------------------------------
// Task 2: RPC retry backoff for duplicate_prevention (#Task2)
// ---------------------------------------------------------------------------

export interface DuplicatePreventionRpcRetryConfig {
  /** Maximum number of retry attempts (default: 5). */
  maxRetries: number;
  /** Delay in ms after the first failure (default: 200). */
  initialBackoffMs: number;
  /** Multiplier applied on every subsequent failure (default: 2). */
  backoffMultiplier: number;
  /** Upper ceiling on the delay in ms (default: 10 000). */
  maxBackoffMs: number;
}

export const DEFAULT_DUPLICATE_PREVENTION_RPC_RETRY_CONFIG: DuplicatePreventionRpcRetryConfig =
  {
    maxRetries: 5,
    initialBackoffMs: 200,
    backoffMultiplier: 2,
    maxBackoffMs: 10_000,
  };

/** Transient RPC / network error patterns that are worth retrying. */
const DP_RPC_RETRYABLE_PATTERNS = [
  "timeout",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "socket hang up",
  "network",
  "status 429",
  "status 503",
  "status 502",
  "request timeout",
  "connect timeout",
  "connection reset",
  "connection refused",
  "connection dropped",
];

export function isDuplicatePreventionRpcRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return DP_RPC_RETRYABLE_PATTERNS.some((p) => msg.includes(p.toLowerCase()));
}

/**
 * Compute the backoff delay in ms for the given attempt index.
 * attempt 0 → initialBackoffMs, each step multiplied, capped at maxBackoffMs.
 */
export function computeDuplicatePreventionBackoffMs(
  attempt: number,
  config: Pick<
    DuplicatePreventionRpcRetryConfig,
    "initialBackoffMs" | "backoffMultiplier" | "maxBackoffMs"
  >,
): number {
  return Math.min(
    config.initialBackoffMs * Math.pow(config.backoffMultiplier, attempt),
    config.maxBackoffMs,
  );
}

function dpSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an async RPC operation with exponential-backoff retry, retrying
 * only for transient connection/timeout errors.
 *
 * This is the retry entry-point used by `ingestRpcEventNotifications` and
 * any other duplicate_prevention callers that go out to an RPC endpoint.
 */
export async function withDuplicatePreventionRpcRetry<T>(
  fn: () => Promise<T>,
  config: Partial<DuplicatePreventionRpcRetryConfig> = {},
  context = "duplicate_prevention_rpc",
): Promise<T> {
  const cfg = {
    ...DEFAULT_DUPLICATE_PREVENTION_RPC_RETRY_CONFIG,
    ...config,
  };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (!isDuplicatePreventionRpcRetryable(lastError) || attempt >= cfg.maxRetries) {
        throw lastError;
      }

      const delay = computeDuplicatePreventionBackoffMs(attempt, cfg);
      logger.warn(`${context} failed, retrying with backoff`, {
        attempt: attempt + 1,
        maxRetries: cfg.maxRetries,
        backoffMs: delay,
        error: lastError.message,
      });
      await dpSleep(delay);
    }
  }

  throw lastError ?? new Error(`${context} exhausted all retries`);
}

// ---------------------------------------------------------------------------
// Task 3: Schema migration pre-checks for duplicate_prevention (#Task3)
// ---------------------------------------------------------------------------

/** Tables and columns duplicate_prevention reads or writes directly. */
const DP_REQUIRED_SCHEMA: Record<string, string[]> = {
  events: ["contract_id", "event_type", "ledger_sequence", "timestamp", "data_json"],
  sync_ranges: ["id", "start_ledger", "end_ledger", "event_count", "duplicate_count"],
};

export interface DuplicatePreventionSchemaReport {
  valid: boolean;
  missingTables: string[];
  missingColumns: Record<string, string[]>;
  errors: string[];
}

/**
 * Verify that every table and column duplicate_prevention depends on exists
 * in the current database, and that the schema_migrations history has no
 * version gaps.  Returns a structured report rather than throwing so callers
 * can accumulate all problems at once.
 *
 * NOTE: `sync_ranges` is created lazily by `initializeSyncRangesTable()`.
 * This pre-check only validates the static tables (events, indexer_state,
 * schema_migrations) that must exist before the component starts; sync_ranges
 * is omitted from the hard-fail list because it is bootstrapped on first use.
 */
export function verifyDuplicatePreventionSchema(): DuplicatePreventionSchemaReport {
  const database = getDb();
  const missingTables: string[] = [];
  const missingColumns: Record<string, string[]> = {};
  const errors: string[] = [];

  // Only `events` is required before first use; `sync_ranges` is optional
  // because it is created lazily by initializeSyncRangesTable().
  const hardRequiredTables = ["events"];

  for (const [table, requiredColumns] of Object.entries(DP_REQUIRED_SCHEMA)) {
    const exists = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get(table);

    if (!exists) {
      if (hardRequiredTables.includes(table)) {
        missingTables.push(table);
        errors.push(`missing table: ${table}`);
      }
      // sync_ranges absence is tolerated – it is created lazily
      continue;
    }

    const columns = (
      database
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>
    ).map((c) => c.name);

    const absent = requiredColumns.filter((c) => !columns.includes(c));
    if (absent.length > 0) {
      missingColumns[table] = absent;
      errors.push(`missing columns in ${table}: ${absent.join(", ")}`);
    }
  }

  // Detect version gaps in the applied migration history.
  const migrationsTableExists = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    )
    .get();

  if (migrationsTableExists) {
    try {
      const applied = (
        database
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all() as Array<{ version: number }>
      ).map((r) => r.version);

      if (applied.length > 0) {
        const gaps: number[] = [];
        for (let v = applied[0]; v < applied[applied.length - 1]; v++) {
          if (!applied.includes(v)) gaps.push(v);
        }
        if (gaps.length > 0) {
          errors.push(
            `migration version gap – missing applied migrations: ${gaps.join(", ")}`,
          );
        }
      }
    } catch {
      // schema_migrations exists but cannot be read – already flagged by the
      // table-presence checks above.
    }
  } else {
    errors.push(
      "schema_migrations table not found – run runMigrations() before starting duplicate_prevention",
    );
  }

  return {
    valid: errors.length === 0,
    missingTables,
    missingColumns,
    errors,
  };
}

/**
 * Throw if duplicate_prevention's schema dependencies are not satisfied.
 * Call this during component startup to fail fast on a stale database.
 */
export function assertDuplicatePreventionSchemaValid(): void {
  const report = verifyDuplicatePreventionSchema();
  if (report.valid) return;

  logger.error("DuplicatePrevention schema verification failed", {
    missingTables: report.missingTables,
    missingColumns: report.missingColumns,
    errors: report.errors,
  });

  throw new Error(
    `DuplicatePrevention schema verification failed – the component cannot start: ` +
      report.errors.join("; "),
  );
}

// ---------------------------------------------------------------------------
// Task 4: Threshold warning alerts for duplicate_prevention (#Task4)
// ---------------------------------------------------------------------------

const DP_DEFAULT_FAILURE_THRESHOLD = 3;
const DP_DEFAULT_STALL_THRESHOLD_MS = 120_000;

export type DuplicatePreventionFailureType =
  | "insert"
  | "dedup"
  | "rpc"
  | "stall";

function dpReadPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return n;
}

/**
 * Tracks consecutive failures inside duplicate_prevention and emits a
 * high-priority warning alert exactly when the configured threshold is first
 * crossed.  Behaviour mirrors `LedgerRangeFailureMonitor` and
 * `SqliteSchemaManagerFailureMonitor` so the alerting surface is consistent
 * across all indexer components.
 */
export class DuplicatePreventionFailureMonitor {
  readonly name: string;
  readonly failureThreshold: number;
  readonly stallThresholdMs: number;
  private consecutiveFailures = 0;
  private lastSuccessfulAt: number | null = null;
  private alertActive = false;

  constructor(
    options: {
      name?: string;
      failureThreshold?: number;
      stallThresholdMs?: number;
    } = {},
  ) {
    this.name = options.name ?? "duplicate_prevention";
    this.failureThreshold =
      options.failureThreshold ??
      dpReadPositiveIntEnv(
        "DUPLICATE_PREVENTION_FAILURE_THRESHOLD",
        DP_DEFAULT_FAILURE_THRESHOLD,
      );
    this.stallThresholdMs =
      options.stallThresholdMs ??
      dpReadPositiveIntEnv(
        "DUPLICATE_PREVENTION_STALL_THRESHOLD_MS",
        DP_DEFAULT_STALL_THRESHOLD_MS,
      );
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  getLastSuccessfulAt(): number | null {
    return this.lastSuccessfulAt;
  }

  isAlertActive(): boolean {
    return this.alertActive;
  }

  getFailureThreshold(): number {
    return this.failureThreshold;
  }

  /**
   * Record a failure.  Logs `error` on every call and emits a `warn` alert
   * exactly once when `consecutiveFailures === failureThreshold`.
   */
  recordFailure(
    failureType: DuplicatePreventionFailureType,
    details: {
      error?: string;
      startLedger?: number;
      endLedger?: number;
    } = {},
  ): number {
    this.consecutiveFailures += 1;
    const payload = {
      component: this.name,
      failureType,
      consecutiveFailures: this.consecutiveFailures,
      threshold: this.failureThreshold,
      startLedger: details.startLedger,
      endLedger: details.endLedger,
      error: details.error,
    };

    logger.error("duplicate_prevention operation failed", payload);

    if (this.consecutiveFailures === this.failureThreshold) {
      this.alertActive = true;
      logger.warn(
        "duplicate_prevention alert: consecutive failure threshold reached",
        {
          ...payload,
          action:
            "Inspect database connectivity, SQLite lock contention, and RPC health; " +
            "the component resumes automatically after the next successful operation.",
        },
      );
    }

    return this.consecutiveFailures;
  }

  recordSuccess(): void {
    const hadFailures = this.consecutiveFailures > 0 || this.alertActive;
    this.consecutiveFailures = 0;
    this.lastSuccessfulAt = Date.now();
    if (hadFailures) {
      logger.info(
        "duplicate_prevention recovered after consecutive failures",
        { component: this.name },
      );
    }
    this.alertActive = false;
  }

  /**
   * Emit a stall warning when the elapsed time since the last successful
   * operation exceeds `stallThresholdMs`.  Does not increment the consecutive
   * failure counter.
   */
  checkStall(range?: { startLedger?: number; endLedger?: number }): boolean {
    if (this.lastSuccessfulAt === null) return false;
    const elapsedMs = Date.now() - this.lastSuccessfulAt;
    if (elapsedMs <= this.stallThresholdMs) return false;

    logger.warn(
      "duplicate_prevention alert: poller stall threshold reached",
      {
        component: this.name,
        failureType: "stall" as const,
        consecutiveFailures: this.consecutiveFailures,
        threshold: this.failureThreshold,
        stallThresholdMs: this.stallThresholdMs,
        elapsedMs,
        startLedger: range?.startLedger,
        endLedger: range?.endLedger,
        action:
          "No successful duplicate_prevention operation within the stall window; " +
          "inspect database and RPC health.",
      },
    );
    return true;
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.lastSuccessfulAt = null;
    this.alertActive = false;
  }
}

const defaultDpFailureMonitor = new DuplicatePreventionFailureMonitor();

export function getDefaultDuplicatePreventionFailureMonitor(): DuplicatePreventionFailureMonitor {
  return defaultDpFailureMonitor;
}

export function resetDuplicatePreventionFailureMonitor(): void {
  defaultDpFailureMonitor.reset();
}

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
  defaultDpFailureMonitor.reset();
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

  let result: DuplicateCheckResult;
  try {
    result = await withSortedEventLocks(eventKeys, () =>
      insertEventsWithDedupCore(events, syncRange),
    );
  } catch (err) {
    defaultDpFailureMonitor.recordFailure("insert", {
      error: err instanceof Error ? err.message : String(err),
      startLedger: syncRange.startLedger,
      endLedger: syncRange.endLedger,
    });
    throw err;
  }

  defaultDpFailureMonitor.recordSuccess();
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

    CREATE INDEX IF NOT EXISTS ${SYNC_RANGES_INDEXES.ledgers}
      ON sync_ranges (start_ledger, end_ledger);
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
 * All event inserts and the sync_ranges metadata write execute inside a
 * single better-sqlite3 transaction. If any step throws, better-sqlite3
 * automatically rolls back the entire transaction so no partial state is
 * left in the database (#189).
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
  defaultDpFailureMonitor.checkStall(syncRange);
  let result: DuplicateCheckResult;
  try {
    result = insertEventsWithDedupCore(events, syncRange);
  } catch (err) {
    defaultDpFailureMonitor.recordFailure("insert", {
      error: err instanceof Error ? err.message : String(err),
      startLedger: syncRange.startLedger,
      endLedger: syncRange.endLedger,
    });
    throw err;
  }
  defaultDpFailureMonitor.recordSuccess();
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
 * Wrapped in a transaction so both events and sync_ranges deletes are atomic.
 */
export function deleteEventsInRange(
  startLedger: number,
  endLedger: number,
): number {
  const db = getDb();
  const tx = db.transaction(() => {
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
  });
  return tx();
}
