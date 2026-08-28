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

// ---------------------------------------------------------------------------
// Configuration (#299, #298, #297)
// ---------------------------------------------------------------------------

/** Inclusive historical range page size; matches the live poller RPC `limit`. */
export const DEFAULT_LEDGER_RANGE_PAGE_SIZE = 100;

/** Consecutive failures before a threshold alert is emitted. */
export const DEFAULT_LEDGER_RANGE_FAILURE_THRESHOLD = 3;

/** Wall-clock stall window before a stall alert is considered, in ms. */
export const DEFAULT_LEDGER_RANGE_STALL_THRESHOLD_MS = 120_000;

const TRACKER_NAME = "ledger_range_tracker";

export type LedgerRangeFailureType =
  | "poll"
  | "event_retrieval"
  | "indexing"
  | "stall";

export class LedgerRangeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerRangeValidationError";
  }
}

export interface LedgerRangeTrackerConfig {
  /** Optional instance name used in logs and alerts. */
  name?: string;
  /** Optional inclusive historical start ledger. */
  startLedger?: number;
  /** Optional inclusive historical end ledger. */
  endLedger?: number;
  /** Chunk size for pagination across a custom range. */
  pageSize?: number;
  /** Consecutive failures required before an alert is emitted. */
  failureThreshold?: number;
  /** Elapsed ms since last success after which a stall is reported. */
  stallThresholdMs?: number;
}

export interface ProcessLedgerRangeOptions {
  startLedger?: number;
  endLedger?: number;
  /** Fallback start when no custom/env start is set (typically lastIndexed+1). */
  defaultStart?: number;
  /** Fallback end when no custom/env end is set (typically the latest live ledger). */
  defaultEnd?: number;
  /** Pre-fetched events; filtered to the resolved range before persist. */
  events?: EventRow[];
  /** Per-page event source. Called once per chunk with the page's inclusive range. */
  fetchEvents?: (page: LedgerRange) => Promise<EventRow[]> | EventRow[];
  pageSize?: number;
  /**
   * When true, advances `last_ledger_sequence` to the range end after a
   * successful import. Defaults to false so live polling is unchanged.
   */
  advanceLivePointer?: boolean;
}

export interface ProcessLedgerRangeResult {
  range: LedgerRange;
  pages: LedgerRange[];
  eventCount: number;
  insertedCount: number;
  duplicateCount: number;
  processedLedgerCount: number;
  payloadSizeBytes: number;
  elapsedMs: number;
  status: "success" | "failure";
}

export interface PollDiagnostics {
  tracker: string;
  operation: string;
  status: "started" | "success" | "failure";
  elapsedMs: number;
  startLedger?: number;
  endLedger?: number;
  processedLedgerCount?: number;
  eventCount?: number;
  payloadSizeBytes?: number;
  error?: string;
}

function parsePositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new LedgerRangeValidationError(
      `${name} must be a positive integer, received ${JSON.stringify(raw)}`
    );
  }
  return n;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new LedgerRangeValidationError(
      `${name} must be a positive integer, received ${JSON.stringify(raw)}`
    );
  }
  return n;
}

/** Read optional historical start/end from env (`LEDGER_RANGE_START` / `LEDGER_RANGE_END`). */
export function getHistoricalRangeConfig(): {
  startLedger?: number;
  endLedger?: number;
  pageSize: number;
  failureThreshold: number;
  stallThresholdMs: number;
} {
  return {
    startLedger: parsePositiveIntEnv("LEDGER_RANGE_START"),
    endLedger: parsePositiveIntEnv("LEDGER_RANGE_END"),
    pageSize: readIntEnv("LEDGER_RANGE_PAGE_SIZE", DEFAULT_LEDGER_RANGE_PAGE_SIZE),
    failureThreshold: readIntEnv(
      "LEDGER_RANGE_FAILURE_THRESHOLD",
      DEFAULT_LEDGER_RANGE_FAILURE_THRESHOLD
    ),
    stallThresholdMs: readIntEnv(
      "LEDGER_RANGE_STALL_THRESHOLD_MS",
      DEFAULT_LEDGER_RANGE_STALL_THRESHOLD_MS
    ),
  };
}

function isValidLedger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value >= 1;
}

/**
 * Validate an inclusive ledger range. Throws `LedgerRangeValidationError` for
 * non-integers, values below 1, or start > end.
 */
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

/**
 * Resolve a historical range from explicit values, then instance/env config,
 * then live defaults (`last_indexed + 1` → provided default end).
 *
 * Custom start/end never invent a live poll window: callers that omit both
 * receive the current live defaults so existing behaviour is preserved.
 */
export function resolveHistoricalLedgerRange(options: {
  startLedger?: number;
  endLedger?: number;
  defaultStart?: number;
  defaultEnd?: number;
} = {}): LedgerRange {
  let start = options.startLedger;
  let end = options.endLedger;
  if (start === undefined || end === undefined) {
    const env = getHistoricalRangeConfig();
    start = start ?? env.startLedger ?? options.defaultStart;
    end = end ?? env.endLedger ?? options.defaultEnd;
  }

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

/**
 * Split an inclusive range into inclusive pages of `pageSize` ledgers.
 * The last page may be shorter so the requested end is never exceeded.
 */
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

export function payloadSizeBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

export function rangesOverlap(a: LedgerRange, b: LedgerRange): boolean {
  return a.startLedger <= b.endLedger && b.startLedger <= a.endLedger;
}

// ---------------------------------------------------------------------------
// In-memory queue locks (#296)
// ---------------------------------------------------------------------------

const eventLockTails = new Map<string, Promise<unknown>>();
const heldEventLocks = new Set<string>();

interface ActiveRangeLock {
  range: LedgerRange;
  done: Promise<void>;
}

const activeRangeLocks: ActiveRangeLock[] = [];
let rangeMutex: Promise<void> = Promise.resolve();

async function withRangeMutex<T>(fn: () => T | Promise<T>): Promise<T> {
  const prev = rangeMutex;
  let release!: () => void;
  rangeMutex = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await prev;
    return await fn();
  } finally {
    release();
  }
}

/**
 * Serialize work for a single event identity. Unrelated keys run concurrently.
 * The lock is always released, including when `fn` throws.
 */
export async function withEventLock<T>(
  key: string,
  fn: () => Promise<T> | T
): Promise<T> {
  const prev = eventLockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => gate, () => gate);
  eventLockTails.set(key, tail);

  try {
    await prev.catch(() => undefined);
    heldEventLocks.add(key);
    return await fn();
  } finally {
    heldEventLocks.delete(key);
    release();
    if (eventLockTails.get(key) === tail) {
      eventLockTails.delete(key);
    }
  }
}

/**
 * Acquire a range lock that waits only for overlapping in-flight ranges.
 * Non-overlapping ranges proceed in parallel. Locks are always released.
 */
export async function withOverlappingRangeLock<T>(
  range: LedgerRange,
  fn: () => Promise<T> | T
): Promise<T> {
  let releaseRange!: () => void;
  const done = new Promise<void>((resolve) => {
    releaseRange = resolve;
  });
  const entry: ActiveRangeLock = { range, done };

  for (;;) {
    const blockers = await withRangeMutex(() => {
      const found = activeRangeLocks.filter((active) =>
        rangesOverlap(active.range, range)
      );
      if (found.length === 0) {
        activeRangeLocks.push(entry);
      }
      return found;
    });
    if (blockers.length === 0) break;
    await Promise.all(blockers.map((b) => b.done));
  }

  try {
    return await fn();
  } finally {
    await withRangeMutex(() => {
      const idx = activeRangeLocks.indexOf(entry);
      if (idx >= 0) activeRangeLocks.splice(idx, 1);
    });
    releaseRange();
  }
}

export function getHeldEventLockCount(): number {
  return heldEventLocks.size;
}

export function getHeldRangeLockCount(): number {
  return activeRangeLocks.length;
}

export function resetLedgerRangeLocks(): void {
  eventLockTails.clear();
  heldEventLocks.clear();
  activeRangeLocks.length = 0;
  rangeMutex = Promise.resolve();
}

// ---------------------------------------------------------------------------
// Consecutive failure / stall alerting (#298)
// ---------------------------------------------------------------------------

export class LedgerRangeFailureMonitor {
  readonly tracker: string;
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
    } = {}
  ) {
    const env = safeEnvConfig();
    this.tracker = options.name ?? TRACKER_NAME;
    this.failureThreshold = options.failureThreshold ?? env.failureThreshold;
    this.stallThresholdMs = options.stallThresholdMs ?? env.stallThresholdMs;
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

  /**
   * Record a failure. Emits a diagnostic error on every attempt and a warning
   * alert only when the consecutive-failure threshold is first reached.
   */
  recordFailure(
    failureType: LedgerRangeFailureType,
    details: {
      error?: string;
      startLedger?: number;
      endLedger?: number;
    } = {}
  ): number {
    this.consecutiveFailures += 1;
    const payload = {
      tracker: this.tracker,
      failureType,
      consecutiveFailures: this.consecutiveFailures,
      threshold: this.failureThreshold,
      startLedger: details.startLedger,
      endLedger: details.endLedger,
      error: details.error,
    };

    logger.error("ledger_range_tracker operation failed", payload);

    if (this.consecutiveFailures === this.failureThreshold) {
      this.alertActive = true;
      logger.warn(
        "ledger_range_tracker alert: consecutive failure threshold reached",
        {
          ...payload,
          action:
            "Inspect RPC connectivity, indexer writes, and stall diagnostics; the tracker resumes automatically after the next successful operation.",
        }
      );
    }

    return this.consecutiveFailures;
  }

  recordSuccess(): void {
    const hadFailures = this.consecutiveFailures > 0 || this.alertActive;
    this.consecutiveFailures = 0;
    this.lastSuccessfulAt = Date.now();
    if (hadFailures) {
      logger.info("ledger_range_tracker recovered after consecutive failures", {
        tracker: this.tracker,
      });
    }
    this.alertActive = false;
  }

  /**
   * If a prior success exists and the stall window has elapsed, emit a stall
   * warning. Does not increment the consecutive-failure counter so a later
   * successful poll can still recover cleanly. Returns true when stalled.
   */
  checkStall(range?: LedgerRange): boolean {
    if (this.lastSuccessfulAt === null) return false;
    const elapsedMs = Date.now() - this.lastSuccessfulAt;
    if (elapsedMs <= this.stallThresholdMs) return false;
    logger.warn("ledger_range_tracker alert: poller stall threshold reached", {
      tracker: this.tracker,
      failureType: "stall" as const,
      consecutiveFailures: this.consecutiveFailures,
      threshold: this.failureThreshold,
      stallThresholdMs: this.stallThresholdMs,
      elapsedMs,
      startLedger: range?.startLedger,
      endLedger: range?.endLedger,
      action:
        "No successful ledger_range_tracker operation within the stall window; inspect RPC polling and indexer health.",
    });
    return true;
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.lastSuccessfulAt = null;
    this.alertActive = false;
  }
}

function safeEnvConfig(): {
  pageSize: number;
  failureThreshold: number;
  stallThresholdMs: number;
} {
  try {
    const env = getHistoricalRangeConfig();
    return {
      pageSize: env.pageSize,
      failureThreshold: env.failureThreshold,
      stallThresholdMs: env.stallThresholdMs,
    };
  } catch {
    return {
      pageSize: DEFAULT_LEDGER_RANGE_PAGE_SIZE,
      failureThreshold: DEFAULT_LEDGER_RANGE_FAILURE_THRESHOLD,
      stallThresholdMs: DEFAULT_LEDGER_RANGE_STALL_THRESHOLD_MS,
    };
  }
}

// ---------------------------------------------------------------------------
// Polling diagnostics (#297)
// ---------------------------------------------------------------------------

export function logPollDiagnostics(diagnostics: PollDiagnostics): void {
  logger.debug("ledger_range_tracker poll diagnostics", diagnostics);
}

function logPollBoundary(
  tracker: string,
  status: "started" | "success" | "failure",
  fields: Omit<PollDiagnostics, "tracker" | "operation" | "status">
): void {
  logPollDiagnostics({
    tracker,
    operation: "poll_ledger_range",
    status,
    ...fields,
  });
}

// ---------------------------------------------------------------------------
// Idempotent persistence under event locks (#296)
// ---------------------------------------------------------------------------

async function persistEventsIdempotent(
  events: EventRow[]
): Promise<{ insertedCount: number; duplicateCount: number }> {
  const keys = [...new Set(events.map(eventIdentityKey))].sort();
  const byKey = new Map<string, EventRow[]>();
  for (const ev of events) {
    const key = eventIdentityKey(ev);
    const list = byKey.get(key);
    if (list) list.push(ev);
    else byKey.set(key, [ev]);
  }

  let insertedCount = 0;
  let duplicateCount = 0;

  // Independent identities run concurrently; identical keys serialize inside
  // withEventLock. INSERT OR IGNORE is the final uniqueness boundary.
  await Promise.all(
    keys.map((key) =>
      withEventLock(key, () => {
        for (const ev of byKey.get(key) ?? []) {
          const inserted = insertEvent(
            ev.contractId,
            ev.eventType,
            ev.ledgerSequence,
            ev.timestamp,
            ev.dataJson
          );
          if (inserted) insertedCount += 1;
          else duplicateCount += 1;
        }
      })
    )
  );

  return { insertedCount, duplicateCount };
}

function uniqueLedgerCount(events: EventRow[]): number {
  return new Set(events.map((ev) => ev.ledgerSequence)).size;
}

function defaultStartLedger(): number {
  const last = getLastIndexedLedger();
  return last < 1 ? 1 : last + 1;
}

// ---------------------------------------------------------------------------
// Tracker instance – shared flow for historical + live-compatible imports
// ---------------------------------------------------------------------------

export class LedgerRangeTracker {
  readonly name: string;
  readonly failureMonitor: LedgerRangeFailureMonitor;
  private readonly config: LedgerRangeTrackerConfig;

  constructor(config: LedgerRangeTrackerConfig = {}) {
    this.config = config;
    this.name = config.name ?? TRACKER_NAME;
    this.failureMonitor = new LedgerRangeFailureMonitor({
      name: this.name,
      failureThreshold: config.failureThreshold,
      stallThresholdMs: config.stallThresholdMs,
    });
  }

  resolveRange(options: ProcessLedgerRangeOptions = {}): LedgerRange {
    return resolveHistoricalLedgerRange({
      startLedger: options.startLedger ?? this.config.startLedger,
      endLedger: options.endLedger ?? this.config.endLedger,
      defaultStart: options.defaultStart ?? defaultStartLedger(),
      defaultEnd: options.defaultEnd ?? this.config.endLedger,
    });
  }

  /**
   * Process a (possibly custom) inclusive ledger range:
   * validate → overlap lock → paginated fetch → idempotent persist →
   * diagnostics + consecutive-failure tracking.
   *
   * Does not update the live ledger pointer unless `advanceLivePointer` is set.
   */
  async processRange(
    options: ProcessLedgerRangeOptions = {}
  ): Promise<ProcessLedgerRangeResult> {
    const pollStart = performance.now();
    let range: LedgerRange | undefined;
    let failureRecorded = false;

    logPollBoundary(this.name, "started", { elapsedMs: 0 });

    try {
      range = this.resolveRange(options);
      const env = safeEnvConfig();
      const pageSize = options.pageSize ?? this.config.pageSize ?? env.pageSize;
      const pages = chunkLedgerRange(range, pageSize);

      this.failureMonitor.checkStall(range);

      const result = await withOverlappingRangeLock(range, async () => {
        const collected: EventRow[] = [];

        if (options.fetchEvents) {
          for (const page of pages) {
            const pageStart = performance.now();
            let pageEvents: EventRow[];
            try {
              pageEvents = await options.fetchEvents(page);
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err);
              this.failureMonitor.recordFailure("event_retrieval", {
                error,
                startLedger: page.startLedger,
                endLedger: page.endLedger,
              });
              failureRecorded = true;
              logPollBoundary(this.name, "failure", {
                elapsedMs: Math.max(0, performance.now() - pageStart),
                startLedger: page.startLedger,
                endLedger: page.endLedger,
                error,
              });
              throw err;
            }
            const inPage = filterEventsToRange(pageEvents, page);
            collected.push(...inPage);
            logPollDiagnostics({
              tracker: this.name,
              operation: "poll_ledger_page",
              status: "success",
              elapsedMs: Math.max(0, performance.now() - pageStart),
              startLedger: page.startLedger,
              endLedger: page.endLedger,
              processedLedgerCount: uniqueLedgerCount(inPage),
              eventCount: inPage.length,
              payloadSizeBytes: payloadSizeBytes(inPage),
            });
          }
        } else if (options.events) {
          collected.push(...filterEventsToRange(options.events, range!));
        }

        let insertedCount = 0;
        let duplicateCount = 0;
        try {
          const persisted = await persistEventsIdempotent(collected);
          insertedCount = persisted.insertedCount;
          duplicateCount = persisted.duplicateCount;
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          this.failureMonitor.recordFailure("indexing", {
            error,
            startLedger: range!.startLedger,
            endLedger: range!.endLedger,
          });
          failureRecorded = true;
          throw err;
        }

        if (options.advanceLivePointer) {
          advanceLedgerUnconditional(range!.endLedger);
        }

        return {
          collected,
          insertedCount,
          duplicateCount,
          pages,
        };
      });

      const elapsedMs = Math.max(0, performance.now() - pollStart);
      const payloadBytes = payloadSizeBytes(result.collected);
      const processedLedgerCount = uniqueLedgerCount(result.collected);

      this.failureMonitor.recordSuccess();
      logPollBoundary(this.name, "success", {
        elapsedMs,
        startLedger: range.startLedger,
        endLedger: range.endLedger,
        processedLedgerCount,
        eventCount: result.collected.length,
        payloadSizeBytes: payloadBytes,
      });

      return {
        range,
        pages: result.pages,
        eventCount: result.collected.length,
        insertedCount: result.insertedCount,
        duplicateCount: result.duplicateCount,
        processedLedgerCount,
        payloadSizeBytes: payloadBytes,
        elapsedMs,
        status: "success",
      };
    } catch (err) {
      const elapsedMs = Math.max(0, performance.now() - pollStart);
      const error = err instanceof Error ? err.message : String(err);

      if (!failureRecorded && !(err instanceof LedgerRangeValidationError)) {
        this.failureMonitor.recordFailure("poll", {
            error,
            startLedger:
              range?.startLedger ??
              (typeof options.startLedger === "number" ? options.startLedger : undefined),
            endLedger:
              range?.endLedger ??
              (typeof options.endLedger === "number" ? options.endLedger : undefined),
          }
        );
      }

      logPollBoundary(this.name, "failure", {
        elapsedMs,
        startLedger:
          range?.startLedger ??
          (typeof options.startLedger === "number" ? options.startLedger : undefined),
        endLedger:
          range?.endLedger ??
          (typeof options.endLedger === "number" ? options.endLedger : undefined),
        error,
      });

      throw err;
    }
  }

  /**
   * Index a batch of event notifications through the same lock + persist path.
   * The processed range is derived from the events themselves.
   */
  async indexEvents(events: EventRow[]): Promise<ProcessLedgerRangeResult> {
    if (events.length === 0) {
      const elapsedMs = 0;
      logPollBoundary(this.name, "success", {
        elapsedMs,
        eventCount: 0,
        payloadSizeBytes: payloadSizeBytes([]),
        processedLedgerCount: 0,
      });
      this.failureMonitor.recordSuccess();
      return {
        range: { startLedger: 1, endLedger: 1 },
        pages: [],
        eventCount: 0,
        insertedCount: 0,
        duplicateCount: 0,
        processedLedgerCount: 0,
        payloadSizeBytes: payloadSizeBytes([]),
        elapsedMs,
        status: "success",
      };
    }

    const ledgers = events.map((e) => e.ledgerSequence);
    return this.processRange({
      startLedger: Math.min(...ledgers),
      endLedger: Math.max(...ledgers),
      events,
    });
  }
}

const defaultTracker = new LedgerRangeTracker();

export function getDefaultLedgerRangeTracker(): LedgerRangeTracker {
  return defaultTracker;
}

export function resetLedgerRangeTrackerState(): void {
  defaultTracker.failureMonitor.reset();
  resetLedgerRangeLocks();
}

/**
 * Process a ledger range through the default tracker instance.
 * Prefer constructing `LedgerRangeTracker` when independent failure state is required.
 */
export async function processLedgerRange(
  options: ProcessLedgerRangeOptions = {}
): Promise<ProcessLedgerRangeResult> {
  return defaultTracker.processRange(options);
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
