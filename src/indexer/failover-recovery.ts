import Database from "better-sqlite3";
import { getDb, getShippedMigrationVersions } from "./db.js";
import logger from "../utils/logger.js";

/**
 * Retries an async operation with exponentially increasing delays.
 *
 * A connection dropout to a Soroban RPC node is usually transient, so the
 * caller gets `maxAttempts` tries with the pause doubling each time
 * (`baseDelayMs`, `2x`, `4x`, ...). Only the gaps between attempts are
 * delayed -- the first call is immediate and a successful attempt returns
 * straight away -- so N attempts sleep at most N-1 times.
 *
 * The error from the final attempt is rethrown, so callers see the reason the
 * operation actually gave up rather than a wrapper.
 *
 * @param operation   The work to attempt. Re-invoked on each retry.
 * @param maxAttempts Total attempts, including the first. Values below 1 are
 *                    treated as 1.
 * @param baseDelayMs Delay before the second attempt; doubles thereafter.
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 100,
): Promise<T> {
  const attempts = Math.max(1, maxAttempts);
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;

      // No pause after the final attempt -- it would delay the rejection
      // without buying another try.
      if (attempt === attempts - 1) break;

      const delayMs = baseDelayMs * 2 ** attempt;
      logger.warn("Operation failed, retrying with backoff", {
        attempt: attempt + 1,
        maxAttempts: attempts,
        delayMs,
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

/**
 * Debug line for one RPC round against a failover node (#249).
 *
 * The elapsed time and payload size are embedded in the message string as well
 * as the metadata, so operators can grep slow or oversized rounds straight out
 * of plain-text logs without a structured log backend.
 */
export function logPollDiagnostics(
  nodeUrl: string,
  startedAt: number,
  payloadSizeBytes: number,
): void {
  const elapsedMs = Math.max(0, Date.now() - startedAt);

  logger.debug(
    `failover_recovery poll elapsedMs=${elapsedMs} payloadSizeBytes=${payloadSizeBytes}`,
    { nodeUrl, elapsedMs, payloadSizeBytes },
  );
}

/**
 * FailoverRecovery tracks the health of the RPC nodes the indexer reads from and
 * manages failover between them. Every write runs inside a SQLite transaction so
 * related fields (failure count, backoff, healthy flag, audit log) can never be
 * left partially updated under concurrent load.
 *
 * Three tables back the module:
 * - `rpc_node_health`      primary per-node health tracking
 * - `failover_state`       singleton row (id = 1) holding the active node
 * - `node_failure_events`  append-only audit log of failures
 */

export interface NodeHealthStatus {
  nodeUrl: string;
  isHealthy: boolean;
  failureCount: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  nextRetryAt: number | null;
  backoffDurationMs: number;
  consecutiveSuccesses: number;
}

export interface FailoverState {
  activeNodeUrl: string | null;
  totalFailovers: number;
  lastFailoverAt: number | null;
}

/** Starting backoff applied after a node's first failure. */
const DEFAULT_BACKOFF_MS = 1000;
/** Ceiling so exponential growth cannot push retries beyond five minutes. */
const MAX_BACKOFF_MS = 300_000;

type HealthRow = {
  node_url: string;
  is_healthy: number;
  failure_count: number;
  last_failure_at: number | null;
  last_success_at: number | null;
  next_retry_at: number | null;
  backoff_duration_ms: number;
  consecutive_successes: number;
};

type FailoverRow = {
  active_node_url: string | null;
  total_failovers: number;
  last_failover_at: number | null;
};

function mapHealthRow(row: HealthRow): NodeHealthStatus {
  return {
    nodeUrl: row.node_url,
    isHealthy: row.is_healthy === 1,
    failureCount: row.failure_count,
    lastFailureAt: row.last_failure_at,
    lastSuccessAt: row.last_success_at,
    nextRetryAt: row.next_retry_at,
    backoffDurationMs: row.backoff_duration_ms,
    consecutiveSuccesses: row.consecutive_successes,
  };
}

/**
 * Create the health/failover tables when absent and seed the singleton
 * failover_state row. Safe to call repeatedly.
 */
export function initializeNodeHealthTables(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS rpc_node_health (
      node_url TEXT PRIMARY KEY,
      is_healthy INTEGER NOT NULL DEFAULT 1,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_failure_at INTEGER,
      last_success_at INTEGER,
      next_retry_at INTEGER,
      backoff_duration_ms INTEGER NOT NULL DEFAULT ${DEFAULT_BACKOFF_MS},
      consecutive_successes INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS failover_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active_node_url TEXT,
      total_failovers INTEGER NOT NULL DEFAULT 0,
      last_failover_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS node_failure_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_url TEXT NOT NULL,
      error_message TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      recovery_attempt_at INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (node_url) REFERENCES rpc_node_health(node_url)
    );
  `);

  db.prepare(
    `INSERT OR IGNORE INTO failover_state (id, active_node_url, total_failovers, last_failover_at)
     VALUES (1, NULL, 0, NULL)`
  ).run();
}

/** Insert the node's health row if it is not tracked yet. */
function ensureNodeRow(nodeUrl: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO rpc_node_health
         (node_url, is_healthy, failure_count, backoff_duration_ms, consecutive_successes)
       VALUES (?, 1, 0, ?, 0)`
    )
    .run(nodeUrl, DEFAULT_BACKOFF_MS);
}

/** Create or replace a node's full health record atomically. */
export async function recordNodeHealth(
  status: NodeHealthStatus
): Promise<boolean> {
  const db = getDb();

  try {
    const write = db.transaction((s: NodeHealthStatus) => {
      db.prepare(
        `INSERT INTO rpc_node_health
           (node_url, is_healthy, failure_count, last_failure_at, last_success_at,
            next_retry_at, backoff_duration_ms, consecutive_successes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_url) DO UPDATE SET
           is_healthy = excluded.is_healthy,
           failure_count = excluded.failure_count,
           last_failure_at = excluded.last_failure_at,
           last_success_at = excluded.last_success_at,
           next_retry_at = excluded.next_retry_at,
           backoff_duration_ms = excluded.backoff_duration_ms,
           consecutive_successes = excluded.consecutive_successes`
      ).run(
        s.nodeUrl,
        s.isHealthy ? 1 : 0,
        s.failureCount,
        s.lastFailureAt,
        s.lastSuccessAt,
        s.nextRetryAt,
        s.backoffDurationMs,
        s.consecutiveSuccesses
      );
    });

    write(status);
    return true;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("Failed to record node health", {
      nodeUrl: status.nodeUrl,
      error: errorMsg,
    });
    recordFailoverRecoveryFailure("health_record", {
      operation: "recordNodeHealth",
      nodeUrl: status.nodeUrl,
      error: errorMsg,
    });
    return false;
  }
}

/** Read one node's health record, or null when the node is untracked. */
export function getNodeHealth(nodeUrl: string): NodeHealthStatus | null {
  const row = getDb()
    .prepare("SELECT * FROM rpc_node_health WHERE node_url = ?")
    .get(nodeUrl) as HealthRow | undefined;

  return row ? mapHealthRow(row) : null;
}

/** Read every tracked node's health record. */
export function getAllNodeHealth(): NodeHealthStatus[] {
  const rows = getDb()
    .prepare("SELECT * FROM rpc_node_health ORDER BY node_url")
    .all() as HealthRow[];

  return rows.map(mapHealthRow);
}

/**
 * Record a failure against a node. The audit-log insert, failure count, backoff
 * growth and healthy flag are updated in one transaction so the audit trail can
 * never disagree with the health record.
 *
 * @param failureThreshold consecutive failures tolerated before the node is
 *   marked unhealthy.
 * @param backoffMultiplier factor applied to the current backoff each failure.
 */
export async function recordNodeFailure(
  nodeUrl: string,
  errorMessage: string,
  failureThreshold = 5,
  backoffMultiplier = 2
): Promise<NodeHealthStatus | null> {
  const db = getDb();

  try {
    const write = db.transaction(() => {
      // The audit log references rpc_node_health, so the parent row must exist first.
      ensureNodeRow(nodeUrl);

      const current = db
        .prepare("SELECT * FROM rpc_node_health WHERE node_url = ?")
        .get(nodeUrl) as HealthRow;

      const now = Date.now();
      const failureCount = current.failure_count + 1;
      const backoff = Math.min(
        Math.max(current.backoff_duration_ms, DEFAULT_BACKOFF_MS) *
          backoffMultiplier,
        MAX_BACKOFF_MS
      );
      const isHealthy = failureCount < failureThreshold;

      db.prepare(
        `UPDATE rpc_node_health
            SET failure_count = ?,
                is_healthy = ?,
                last_failure_at = ?,
                next_retry_at = ?,
                backoff_duration_ms = ?,
                consecutive_successes = 0
          WHERE node_url = ?`
      ).run(
        failureCount,
        isHealthy ? 1 : 0,
        now,
        now + backoff,
        backoff,
        nodeUrl
      );

      db.prepare(
        `INSERT INTO node_failure_events
           (node_url, error_message, retry_count, recovery_attempt_at)
         VALUES (?, ?, ?, ?)`
      ).run(nodeUrl, errorMessage, failureCount, now + backoff);

      return db
        .prepare("SELECT * FROM rpc_node_health WHERE node_url = ?")
        .get(nodeUrl) as HealthRow;
    });

    return mapHealthRow(write());
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("Failed to record node failure", {
      nodeUrl,
      error: errorMsg,
    });
    recordFailoverRecoveryFailure("node_failure", {
      operation: "recordNodeFailure",
      nodeUrl,
      error: errorMsg,
    });
    return null;
  }
}

/**
 * Record a successful call against a node, easing it back toward healthy: the
 * consecutive-success counter rises, the failure count and backoff decay, and
 * the node is marked healthy once it clears `successThreshold`.
 */
export async function recordNodeSuccess(
  nodeUrl: string,
  successThreshold = 3
): Promise<NodeHealthStatus | null> {
  const db = getDb();

  try {
    const write = db.transaction(() => {
      ensureNodeRow(nodeUrl);

      const current = db
        .prepare("SELECT * FROM rpc_node_health WHERE node_url = ?")
        .get(nodeUrl) as HealthRow;

      const now = Date.now();
      const consecutiveSuccesses = current.consecutive_successes + 1;
      const failureCount = Math.max(0, current.failure_count - 1);
      const backoff = Math.max(
        DEFAULT_BACKOFF_MS,
        Math.floor(current.backoff_duration_ms / 2)
      );
      const isHealthy =
        consecutiveSuccesses >= successThreshold || failureCount === 0;

      db.prepare(
        `UPDATE rpc_node_health
            SET consecutive_successes = ?,
                failure_count = ?,
                backoff_duration_ms = ?,
                is_healthy = ?,
                last_success_at = ?,
                next_retry_at = NULL
          WHERE node_url = ?`
      ).run(
        consecutiveSuccesses,
        failureCount,
        backoff,
        isHealthy ? 1 : 0,
        now,
        nodeUrl
      );

      return db
        .prepare("SELECT * FROM rpc_node_health WHERE node_url = ?")
        .get(nodeUrl) as HealthRow;
    });

    return mapHealthRow(write());
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("Failed to record node success", {
      nodeUrl,
      error: errorMsg,
    });
    recordFailoverRecoveryFailure("health_record", {
      operation: "recordNodeSuccess",
      nodeUrl,
      error: errorMsg,
    });
    return null;
  }
}

/** Read the current failover state, seeding defaults when the row is absent. */
export function getFailoverState(): FailoverState {
  const row = getDb()
    .prepare(
      "SELECT active_node_url, total_failovers, last_failover_at FROM failover_state WHERE id = 1"
    )
    .get() as FailoverRow | undefined;

  if (!row) {
    return { activeNodeUrl: null, totalFailovers: 0, lastFailoverAt: null };
  }

  return {
    activeNodeUrl: row.active_node_url,
    totalFailovers: row.total_failovers,
    lastFailoverAt: row.last_failover_at,
  };
}

/** URL of the node the indexer should currently be reading from. */
export function getActiveNodeUrl(): string | null {
  return getFailoverState().activeNodeUrl;
}

/**
 * Switch the active node and bump the failover counter in one transaction, so a
 * burst of concurrent failovers still yields an exact count.
 */
export async function failoverToNode(
  nodeUrl: string
): Promise<FailoverState | null> {
  const db = getDb();

  try {
    const write = db.transaction(() => {
      db.prepare(
        `INSERT INTO failover_state (id, active_node_url, total_failovers, last_failover_at)
         VALUES (1, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET
           active_node_url = excluded.active_node_url,
           total_failovers = failover_state.total_failovers + 1,
           last_failover_at = excluded.last_failover_at`
      ).run(nodeUrl, Date.now());

      return db
        .prepare(
          "SELECT active_node_url, total_failovers, last_failover_at FROM failover_state WHERE id = 1"
        )
        .get() as FailoverRow;
    });

    const row = write();
    return {
      activeNodeUrl: row.active_node_url,
      totalFailovers: row.total_failovers,
      lastFailoverAt: row.last_failover_at,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("Failed to fail over to node", {
      nodeUrl,
      error: errorMsg,
    });
    recordFailoverRecoveryFailure("failover", {
      operation: "failoverToNode",
      nodeUrl,
      error: errorMsg,
    });
    return null;
  }
}

/**
 * Pick the best candidate from `nodeUrls`: healthy nodes first, then fewest
 * failures, then most recent success. Untracked nodes are treated as healthy
 * since they have no failures on record. Returns null for an empty list.
 */
export function selectHealthiestNode(nodeUrls: string[]): string | null {
  if (nodeUrls.length === 0) return null;

  const scored = nodeUrls.map((nodeUrl) => {
    const health = getNodeHealth(nodeUrl);
    return {
      nodeUrl,
      isHealthy: health ? health.isHealthy : true,
      failureCount: health ? health.failureCount : 0,
      lastSuccessAt: health?.lastSuccessAt ?? 0,
    };
  });

  scored.sort((a, b) => {
    if (a.isHealthy !== b.isHealthy) return a.isHealthy ? -1 : 1;
    if (a.failureCount !== b.failureCount) return a.failureCount - b.failureCount;
    return b.lastSuccessAt - a.lastSuccessAt;
  });

  return scored[0].nodeUrl;
}

/**
 * Build a client for whichever node is currently healthiest and record it as
 * active. `createServer` is supplied by the caller (e.g. the Soroban RPC
 * `Server` constructor) so this module stays free of SDK coupling.
 */
export async function createFailoverServer<T>(
  nodeUrls: string[],
  createServer: (nodeUrl: string) => T
): Promise<{ server: T; nodeUrl: string } | null> {
  const nodeUrl = selectHealthiestNode(nodeUrls);
  if (!nodeUrl) {
    logger.error("Cannot create failover server: no nodes configured");
    recordFailoverRecoveryFailure("failover", {
      operation: "createFailoverServer",
      error: "Cannot create failover server: no nodes configured",
    });
    return null;
  }

  if (getActiveNodeUrl() !== nodeUrl) {
    await failoverToNode(nodeUrl);
  }

  return { server: createServer(nodeUrl), nodeUrl };
}

// ---------------------------------------------------------------------------
// Migration verification hooks (#417)
// ---------------------------------------------------------------------------

/**
 * Tables and columns required by indexer_failover_recovery to operate safely.
 */
export const FAILOVER_RECOVERY_REQUIRED_SCHEMA: Record<string, string[]> = {
  rpc_node_health: [
    "node_url",
    "is_healthy",
    "failure_count",
    "last_failure_at",
    "last_success_at",
    "next_retry_at",
    "backoff_duration_ms",
    "consecutive_successes",
  ],
  failover_state: [
    "id",
    "active_node_url",
    "total_failovers",
    "last_failover_at",
  ],
  node_failure_events: [
    "id",
    "node_url",
    "error_message",
    "retry_count",
    "recovery_attempt_at",
  ],
  schema_migrations: ["version"],
};

export interface FailoverRecoverySchemaReport {
  valid: boolean;
  missingTables: string[];
  missingColumns: Record<string, string[]>;
  missingMigrations: number[];
  errors: string[];
  issues: string[];
}

export class FailoverRecoverySchemaError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "FailoverRecoverySchemaError";
    this.issues = issues;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type FailoverRecoveryMigrationHook = (
  db: Database.Database,
) => string[] | string | void;

const failoverRecoveryMigrationHooks = new Map<string, FailoverRecoveryMigrationHook>();

export function registerFailoverRecoveryMigrationHook(
  name: string,
  hook: FailoverRecoveryMigrationHook,
): void {
  failoverRecoveryMigrationHooks.set(name, hook);
}

export function unregisterFailoverRecoveryMigrationHook(name: string): boolean {
  return failoverRecoveryMigrationHooks.delete(name);
}

export function clearFailoverRecoveryMigrationHooks(): void {
  failoverRecoveryMigrationHooks.clear();
}

export function getFailoverRecoveryMigrationHookNames(): string[] {
  return [...failoverRecoveryMigrationHooks.keys()];
}

// Aliases for generic migration hook registration
export const registerMigrationVerificationHook = registerFailoverRecoveryMigrationHook;
export const registerMigrationHook = registerFailoverRecoveryMigrationHook;
export const unregisterMigrationVerificationHook = unregisterFailoverRecoveryMigrationHook;
export const clearMigrationVerificationHooks = clearFailoverRecoveryMigrationHooks;
export const getMigrationVerificationHookNames = getFailoverRecoveryMigrationHookNames;

/**
 * Validate that every table, column, and migration required by indexer_failover_recovery
 * is present and healthy. Reports all issues at once rather than failing on the first.
 */
export function validateFailoverRecoverySchema(
  targetDb?: Database.Database,
): FailoverRecoverySchemaReport {
  const database = targetDb || getDb();
  const missingTables: string[] = [];
  const missingColumns: Record<string, string[]> = {};
  const missingMigrations: number[] = [];
  const errors: string[] = [];

  for (const [table, requiredColumns] of Object.entries(
    FAILOVER_RECOVERY_REQUIRED_SCHEMA,
  )) {
    const exists = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);

    if (!exists) {
      missingTables.push(table);
      errors.push(`Missing table: ${table}`);
      continue;
    }

    const columns = (
      database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);

    const absent = requiredColumns.filter((c) => !columns.includes(c));
    if (absent.length > 0) {
      missingColumns[table] = absent;
      errors.push(`Missing columns in ${table}: ${absent.join(", ")}`);
    }
  }

  // Verify migrations completeness and continuity when schema_migrations exists
  if (!missingTables.includes("schema_migrations")) {
    try {
      const appliedRows = database
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number }>;
      const applied = new Set(appliedRows.map((r) => r.version));

      for (const version of getShippedMigrationVersions()) {
        if (!applied.has(version)) {
          missingMigrations.push(version);
        }
      }

      if (missingMigrations.length > 0) {
        errors.push(`Missing applied migrations: ${missingMigrations.join(", ")}`);
      }

      const versions = appliedRows.map((r) => r.version);
      for (let i = 1; i < versions.length; i++) {
        if (versions[i] - versions[i - 1] > 1) {
          errors.push(
            `Migration version gap between ${versions[i - 1]} and ${versions[i]}`,
          );
        }
      }
    } catch (err) {
      errors.push(
        `schema_migrations table is unreadable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Run registered migration verification hooks
  for (const [name, hook] of failoverRecoveryMigrationHooks) {
    try {
      const result = hook(database);
      const hookIssues =
        typeof result === "string" ? [result] : Array.isArray(result) ? result : [];
      for (const issue of hookIssues) {
        errors.push(`${name}: ${issue}`);
      }
    } catch (err) {
      errors.push(
        `${name}: hook threw ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    missingTables,
    missingColumns,
    missingMigrations,
    errors,
    issues: errors,
  };
}

export const verifyFailoverRecoverySchema = validateFailoverRecoverySchema;

/**
 * Throw FailoverRecoverySchemaError unless all required tables, columns,
 * and migrations are present and healthy.
 */
export function assertFailoverRecoverySchemaValid(
  targetDb?: Database.Database,
): FailoverRecoverySchemaReport {
  const report = validateFailoverRecoverySchema(targetDb);
  if (report.valid) return report;

  logger.error("indexer_failover_recovery schema verification failed", {
    missingTables: report.missingTables,
    missingColumns: report.missingColumns,
    missingMigrations: report.missingMigrations,
    errors: report.errors,
  });

  throw new FailoverRecoverySchemaError(
    `indexer_failover_recovery: database schema is out of sync – ${report.errors.join("; ")}`,
    report.errors,
  );
}

export const assertFailoverRecoverySchemaReady = assertFailoverRecoverySchemaValid;

export interface FailoverRecoveryStartOptions {
  targetDb?: Database.Database;
  autoInitialize?: boolean;
}

let failoverRecoveryStarted = false;
let lastFailoverRecoverySchemaReport: FailoverRecoverySchemaReport | null = null;

export function isFailoverRecoveryStarted(): boolean {
  return failoverRecoveryStarted;
}

export function getFailoverRecoverySchemaReport(): FailoverRecoverySchemaReport | null {
  return lastFailoverRecoverySchemaReport;
}

/**
 * Start the indexer failover recovery component.
 * Verifies schema integrity and fails fast (throws FailoverRecoverySchemaError)
 * if the database state is out of sync.
 */
export function startFailoverRecovery(
  options: FailoverRecoveryStartOptions = {},
): FailoverRecoverySchemaReport {
  const db = options.targetDb || getDb();

  if (options.autoInitialize) {
    initializeNodeHealthTables();
  }

  try {
    const report = assertFailoverRecoverySchemaValid(db);
    failoverRecoveryStarted = true;
    lastFailoverRecoverySchemaReport = report;
    recordFailoverRecoverySuccess({ operation: "startFailoverRecovery" });
    logger.info("indexer_failover_recovery started", {
      started: true,
      valid: report.valid,
    });
    return report;
  } catch (err) {
    failoverRecoveryStarted = false;
    lastFailoverRecoverySchemaReport = validateFailoverRecoverySchema(db);
    recordFailoverRecoveryFailure("schema", {
      operation: "startFailoverRecovery",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export const startFailoverRecoveryClient = startFailoverRecovery;

export function stopFailoverRecovery(): void {
  failoverRecoveryStarted = false;
  lastFailoverRecoverySchemaReport = null;
}

export function resetFailoverRecovery(): void {
  stopFailoverRecovery();
  clearFailoverRecoveryMigrationHooks();
  resetFailoverRecoveryFailureMonitorState();
}

// ---------------------------------------------------------------------------
// Consecutive failure and stall threshold alerting (#415)
// ---------------------------------------------------------------------------

export const DEFAULT_FAILOVER_RECOVERY_FAILURE_THRESHOLD = 3;
export const DEFAULT_FAILOVER_FAILURE_THRESHOLD = DEFAULT_FAILOVER_RECOVERY_FAILURE_THRESHOLD;

export const DEFAULT_FAILOVER_RECOVERY_STALL_THRESHOLD_MS = 120_000;
export const DEFAULT_FAILOVER_STALL_THRESHOLD_MS = DEFAULT_FAILOVER_RECOVERY_STALL_THRESHOLD_MS;

export type FailoverRecoveryFailureType =
  | "node_failure"
  | "failover"
  | "health_record"
  | "schema"
  | "retry"
  | "stall"
  | "operation"
  | "query";

export interface FailoverRecoveryFailureDetails {
  error?: string;
  operation?: string;
  nodeUrl?: string;
  elapsedMs?: number;
  failureThreshold?: number;
  [key: string]: unknown;
}

export interface FailoverRecoveryMonitorOptions {
  name?: string;
  failureThreshold?: number;
  stallThresholdMs?: number;
  repeatAlerts?: boolean;
}

export interface FailoverRecoveryAlertConfig {
  failureThreshold: number;
  stallThresholdMs: number;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    logger.warn("indexer_failover_recovery ignoring invalid threshold config", {
      variable: name,
      received: raw,
      fallback,
    });
    return fallback;
  }
  return value;
}

export function getFailoverRecoveryAlertConfig(): FailoverRecoveryAlertConfig {
  const failureThreshold =
    process.env.FAILOVER_RECOVERY_FAILURE_THRESHOLD !== undefined
      ? readPositiveIntEnv(
          "FAILOVER_RECOVERY_FAILURE_THRESHOLD",
          DEFAULT_FAILOVER_RECOVERY_FAILURE_THRESHOLD,
        )
      : process.env.INDEXER_FAILOVER_RECOVERY_FAILURE_THRESHOLD !== undefined
        ? readPositiveIntEnv(
            "INDEXER_FAILOVER_RECOVERY_FAILURE_THRESHOLD",
            DEFAULT_FAILOVER_RECOVERY_FAILURE_THRESHOLD,
          )
        : readPositiveIntEnv(
            "FAILOVER_FAILURE_THRESHOLD",
            DEFAULT_FAILOVER_RECOVERY_FAILURE_THRESHOLD,
          );

  const stallThresholdMs =
    process.env.FAILOVER_RECOVERY_STALL_THRESHOLD_MS !== undefined
      ? readPositiveIntEnv(
          "FAILOVER_RECOVERY_STALL_THRESHOLD_MS",
          DEFAULT_FAILOVER_RECOVERY_STALL_THRESHOLD_MS,
        )
      : process.env.INDEXER_FAILOVER_RECOVERY_STALL_THRESHOLD_MS !== undefined
        ? readPositiveIntEnv(
            "INDEXER_FAILOVER_RECOVERY_STALL_THRESHOLD_MS",
            DEFAULT_FAILOVER_RECOVERY_STALL_THRESHOLD_MS,
          )
        : readPositiveIntEnv(
            "FAILOVER_STALL_THRESHOLD_MS",
            DEFAULT_FAILOVER_RECOVERY_STALL_THRESHOLD_MS,
          );

  return { failureThreshold, stallThresholdMs };
}

export const getFailoverAlertConfig = getFailoverRecoveryAlertConfig;
export const getIndexerFailoverRecoveryAlertConfig = getFailoverRecoveryAlertConfig;

/**
 * Tracks consecutive indexer_failover_recovery operation failures and stalls,
 * raising warning alerts once configured thresholds are reached (#415).
 */
export class FailoverRecoveryFailureMonitor {
  readonly component: string;
  readonly failureThreshold: number;
  readonly stallThresholdMs: number;
  readonly repeatAlerts: boolean;

  private consecutiveFailures = 0;
  private lastSuccessfulAt: number | null = null;
  private alertActive = false;
  private stallAlerted = false;

  constructor(options: FailoverRecoveryMonitorOptions = {}) {
    const env = getFailoverRecoveryAlertConfig();
    this.component = options.name ?? "indexer_failover_recovery";
    this.failureThreshold = options.failureThreshold ?? env.failureThreshold;
    this.stallThresholdMs = options.stallThresholdMs ?? env.stallThresholdMs;
    this.repeatAlerts = options.repeatAlerts ?? false;
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

  getStallThresholdMs(): number {
    return this.stallThresholdMs;
  }

  /**
   * Record a failed indexer_failover_recovery operation.
   * Logs an error every time and emits a warning alert when the
   * consecutive-failure threshold is reached.
   */
  recordFailure(
    failureType: FailoverRecoveryFailureType,
    details: FailoverRecoveryFailureDetails = {},
  ): number {
    this.consecutiveFailures += 1;

    const payload = {
      component: this.component,
      failureType,
      operation: details.operation,
      nodeUrl: details.nodeUrl,
      consecutiveFailures: this.consecutiveFailures,
      threshold: this.failureThreshold,
      error: details.error,
      elapsedMs: details.elapsedMs,
    };

    logger.error("indexer_failover_recovery operation failed", payload);

    if (
      this.consecutiveFailures === this.failureThreshold ||
      (this.repeatAlerts && this.consecutiveFailures > this.failureThreshold)
    ) {
      this.alertActive = true;
      logger.warn(
        "indexer_failover_recovery alert: consecutive failure threshold reached",
        {
          ...payload,
          action:
            "Inspect RPC node health, failover state, and network connectivity; alerting clears automatically after the next successful operation.",
        },
      );
    }

    return this.consecutiveFailures;
  }

  /**
   * Record a successful operation, clearing any active failure or stall alert.
   */
  recordSuccess(details?: { operation?: string; nodeUrl?: string }): void {
    const hadFailures = this.consecutiveFailures > 0 || this.alertActive;
    this.consecutiveFailures = 0;
    this.lastSuccessfulAt = Date.now();
    if (hadFailures) {
      logger.info(
        "indexer_failover_recovery recovered after consecutive failures",
        {
          component: this.component,
          operation: details?.operation,
          nodeUrl: details?.nodeUrl,
        },
      );
    }
    this.alertActive = false;
    this.stallAlerted = false;
  }

  /**
   * Warn when no successful operation has completed inside the stall window.
   */
  checkStall(): boolean {
    if (this.lastSuccessfulAt === null) return false;
    const elapsedMs = Date.now() - this.lastSuccessfulAt;
    if (elapsedMs <= this.stallThresholdMs) return false;
    if (this.stallAlerted) return true;

    this.stallAlerted = true;
    logger.warn("indexer_failover_recovery alert: stall threshold reached", {
      component: this.component,
      failureType: "stall" as const,
      consecutiveFailures: this.consecutiveFailures,
      threshold: this.failureThreshold,
      stallThresholdMs: this.stallThresholdMs,
      elapsedMs,
      action:
        "No successful indexer_failover_recovery operation within the stall window; inspect RPC nodes, network connectivity, and indexer health.",
    });
    return true;
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.lastSuccessfulAt = null;
    this.alertActive = false;
    this.stallAlerted = false;
  }
}

export const IndexerFailoverRecoveryFailureMonitor = FailoverRecoveryFailureMonitor;

let defaultFailoverRecoveryFailureMonitor = new FailoverRecoveryFailureMonitor();

export function getFailoverRecoveryFailureMonitor(): FailoverRecoveryFailureMonitor {
  return defaultFailoverRecoveryFailureMonitor;
}

export const getIndexerFailoverRecoveryFailureMonitor = getFailoverRecoveryFailureMonitor;

export function resetFailoverRecoveryFailureMonitorState(): void {
  defaultFailoverRecoveryFailureMonitor = new FailoverRecoveryFailureMonitor();
}

export const resetFailoverRecoveryAlertState = resetFailoverRecoveryFailureMonitorState;
export const resetIndexerFailoverRecoveryFailureState = resetFailoverRecoveryFailureMonitorState;

export function recordFailoverRecoveryFailure(
  failureType: FailoverRecoveryFailureType,
  details?: FailoverRecoveryFailureDetails,
): number {
  return defaultFailoverRecoveryFailureMonitor.recordFailure(failureType, details);
}

export function recordFailoverRecoverySuccess(details?: {
  operation?: string;
  nodeUrl?: string;
}): void {
  defaultFailoverRecoveryFailureMonitor.recordSuccess(details);
}

export function checkFailoverRecoveryStall(): boolean {
  return defaultFailoverRecoveryFailureMonitor.checkStall();
}


