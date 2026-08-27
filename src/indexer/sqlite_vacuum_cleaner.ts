import type Database from "better-sqlite3";
import logger from "../utils/logger.js";

// ---------------------------------------------------------------------------
// SQLite vacuum cleaner (#193)
// ---------------------------------------------------------------------------
//
// This module prunes stale rows from the `events` table and reclaims the
// disk space they occupied.
//
// IMPORTANT — transaction isolation vs. VACUUM:
// SQLite does NOT allow the `VACUUM` command to run inside an explicit
// transaction (`db.exec("VACUUM")` while a transaction is active throws
// `SqliteError: cannot VACUUM from within a transaction`). Because of that
// hard engine constraint, "transaction isolation" for this module cannot
// mean wrapping VACUUM itself in a transaction. Instead:
//
//   1. The data-pruning/cleanup step that decides what to delete
//      (pruneOldEvents) runs atomically inside a `db.transaction(...)`
//      block, mirroring the pattern used by `insertEventBatch()` in
//      `src/indexer/db.ts` — if anything fails partway through, the whole
//      deletion rolls back and no rows are left half-deleted.
//   2. The separate, non-transactional `VACUUM` command (runVacuum) only
//      runs afterward, once pruning has fully committed — never nested
//      inside a transaction.
//
// `runVacuumCleanup()` orchestrates these two steps in the correct order.

/**
 * Default retention window (in days) used when the caller doesn't specify
 * one. Events older than this are eligible for pruning.
 */
export const DEFAULT_RETENTION_DAYS = 90;

export interface VacuumCleanupOptions {
  /** How many days of events to retain. Defaults to DEFAULT_RETENTION_DAYS. */
  retentionDays?: number;
}

export interface VacuumCleanupResult {
  /** Number of event rows deleted during the pruning step. */
  prunedEvents: number;
  /** Whether the VACUUM step ran successfully. */
  vacuumed: boolean;
}

export const ERROR_CODES = {
  INVALID_RETENTION: "VACUUM_INVALID_RETENTION",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Validates a retentionDays value. Must be a finite, positive integer.
 * Zero, negative, non-integer, NaN, and Infinity values are all rejected —
 * a zero or negative retention window has no sane "keep nothing older than
 * X days" interpretation and would risk pruning everything (or throwing on
 * a nonsensical SQL interval).
 */
export function validateRetentionDays(
  retentionDays: number
): { ok: true } | { ok: false; error: string; code: "VACUUM_INVALID_RETENTION" } {
  if (
    typeof retentionDays !== "number" ||
    !Number.isFinite(retentionDays) ||
    !Number.isInteger(retentionDays) ||
    retentionDays <= 0
  ) {
    return {
      ok: false,
      error: `retentionDays must be a positive integer, got: ${retentionDays}`,
      code: ERROR_CODES.INVALID_RETENTION,
    };
  }
  return { ok: true };
}

/**
 * Deletes events older than `retentionDays`, computing the cutoff timestamp
 * against the database's own clock (via SQLite's `datetime('now', ...)`
 * rather than in JS) so the comparison is always consistent with the
 * `created_at DATETIME DEFAULT CURRENT_TIMESTAMP` column it's compared
 * against.
 *
 * The deletion is wrapped in `db.transaction(...)` — this is the
 * transactional core of the vacuum cleaner. Even though a single DELETE
 * statement is atomic on its own, wrapping it explicitly is what makes this
 * composable with any future multi-statement pruning logic (e.g. also
 * pruning old webhook delivery logs) added inside the same atomic block,
 * and guarantees that if the transaction throws, better-sqlite3 rolls back
 * everything it did — nothing here swallows that error.
 *
 * Returns the number of rows deleted.
 */
export function pruneOldEvents(db: Database.Database, retentionDays: number): number {
  const validation = validateRetentionDays(retentionDays);
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  const deleteStmt = db.prepare(
    `DELETE FROM events WHERE created_at < datetime('now', '-' || ? || ' days')`
  );

  const pruneTransaction = db.transaction((days: number) => {
    const result = deleteStmt.run(days);
    return result.changes;
  });

  // better-sqlite3's transaction wrapper commits the callback's statements
  // together, or rolls all of them back if it throws — propagate any error
  // as-is so callers know pruning did not complete.
  return pruneTransaction(retentionDays);
}

/**
 * Runs SQLite's VACUUM command to reclaim disk space freed by prior
 * deletions.
 *
 * MUST NEVER be called from inside an active transaction — SQLite will
 * throw `cannot VACUUM from within a transaction` if you do. This is
 * exactly why `runVacuumCleanup` below calls `pruneOldEvents` (transactional)
 * to completion FIRST, and only then calls `runVacuum` (non-transactional)
 * as a separate, later step.
 */
export function runVacuum(db: Database.Database): void {
  db.exec("VACUUM");
}

/**
 * Orchestrates a full vacuum-cleanup cycle:
 *   1. Prune events older than the configured retention window, atomically.
 *   2. Only if pruning fully succeeds, reclaim disk space with VACUUM.
 *
 * If pruning throws, the error propagates immediately and VACUUM is never
 * invoked — we never want to reclaim disk space around data whose cleanup
 * step failed or rolled back ambiguously.
 */
export function runVacuumCleanup(
  db: Database.Database,
  options: VacuumCleanupOptions = {}
): VacuumCleanupResult {
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;

  logger.info("Starting sqlite vacuum cleanup", { retentionDays });

  const startedAt = Date.now();

  // Step 1: transactional prune. If this throws, we intentionally do not
  // catch it here — propagate immediately and skip VACUUM entirely.
  const pruneStartedAt = Date.now();
  const prunedEvents = pruneOldEvents(db, retentionDays);
  const pruneElapsedMs = Date.now() - pruneStartedAt;

  // (#346) High-frequency diagnostics: poll speed and payload size for the
  // prune stage. The elapsed time is embedded directly in the message so
  // plain-string log shipping preserves it too.
  logger.debug(
    `sqlite vacuum prune poll finished in ${pruneElapsedMs}ms ` +
      `(payload: ${prunedEvents} rows pruned)`
  );

  // Step 2: non-transactional VACUUM, only reached once pruning committed.
  const vacuumStartedAt = Date.now();
  runVacuum(db);
  const vacuumElapsedMs = Date.now() - vacuumStartedAt;

  logger.debug(`sqlite VACUUM finished in ${vacuumElapsedMs}ms`);

  const totalElapsedMs = Date.now() - startedAt;
  logger.info(
    `sqlite vacuum cleanup completed in ${totalElapsedMs}ms ` +
      `(prune ${pruneElapsedMs}ms, vacuum ${vacuumElapsedMs}ms, payload: ${prunedEvents} rows)`
  );

  return { prunedEvents, vacuumed: true };
}


// ---------------------------------------------------------------------------
// Exponential backoff retry (#343)
// ---------------------------------------------------------------------------

/** Default retry behaviour for runVacuumCleanupWithRetry. */
export const DEFAULT_RETRY_MAX_ATTEMPTS = 4;
export const DEFAULT_RETRY_INITIAL_DELAY_MS = 200;
export const DEFAULT_RETRY_MAX_DELAY_MS = 8000;
/** (#347) Consecutive failures before an alert is raised. */
export const DEFAULT_RETRY_ALERT_THRESHOLD = 2;

export interface VacuumRetryOptions {
  /** Total attempts (first try + retries). Defaults to 4. */
  maxAttempts?: number;
  /** Delay before the first retry. Defaults to 200ms. */
  initialDelayMs?: number;
  /** Upper bound for the exponentially growing delay. Defaults to 8000ms. */
  maxDelayMs?: number;
  /** Injectable delay so tests can observe the backoff without real waits. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Consecutive failures before an alert is raised (#347). Defaults to 2.
   * Set to a value larger than maxAttempts to disable alerting.
   */
  alertThreshold?: number;
}

export interface VacuumCleanupRetryResult extends VacuumCleanupResult {
  /** The attempt on which the cleanup ultimately succeeded. */
  attempts: number;
}

/**
 * Exponential backoff delay for the 1-based ${attempt}: initialDelayMs *
 * 2^(attempt-1), capped at maxDelayMs — so the retry frequency increases up
 * to maxAttempts exactly as the connection-dropout recovery rules require.
 */
export function computeBackoffDelayMs(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number
): number {
  return Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
}

/**
 * Runs a full vacuum-cleanup cycle with exponential backoff so transient
 * RPC/connection dropouts are retried gracefully instead of aborting the
 * maintenance pass.
 *
 * Attempt 1 runs immediately; every subsequent attempt waits
 * initialDelayMs * 2^(n-1) ms (capped at maxDelayMs) before running.
 *
 * If every attempt fails, the LAST real error is rethrown after the final
 * attempt — callers see the actual failure, never a synthetic one.
 */
export async function runVacuumCleanupWithRetry(
  db: Database.Database,
  options: VacuumCleanupOptions = {},
  retryOptions: VacuumRetryOptions = {}
): Promise<VacuumCleanupRetryResult> {
  const maxAttempts =
    retryOptions.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS;
  const initialDelayMs =
    retryOptions.initialDelayMs ?? DEFAULT_RETRY_INITIAL_DELAY_MS;
  const maxDelayMs = retryOptions.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  const sleep =
    retryOptions.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  let lastError: unknown = new Error("vacuum cleanup never ran");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = runVacuumCleanup(db, options);
      logger.info("sqlite vacuum cleanup succeeded", {
        attempt,
        maxAttempts,
        prunedEvents: result.prunedEvents,
      });
      return { ...result, attempts: attempt };
    } catch (err) {
      lastError = err;
      const delayMs = computeBackoffDelayMs(attempt, initialDelayMs, maxDelayMs);
      logger.warn("sqlite vacuum cleanup attempt failed", {
        attempt,
        maxAttempts,
        delayMs,
        error: err instanceof Error ? err.message : String(err),
      });

      // (#347) Threshold alerting: once the operation has failed
      // consecutively past the configured threshold, raise an explicit
      // error-level alert so on-call tooling can page on it.
      const alertThreshold =
        retryOptions.alertThreshold ?? DEFAULT_RETRY_ALERT_THRESHOLD;
      if (attempt >= alertThreshold) {
        logger.error(
          `ALERT: sqlite vacuum cleanup has failed ${attempt} consecutive ` +
            `times (threshold: ${alertThreshold}). Disk-space reclamation ` +
            `is stalled — inspect the indexer RPC connection.`
        );
      }

      if (attempt < maxAttempts) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}
