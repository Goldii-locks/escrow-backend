import { getDb } from "./db.js";
import logger from "../utils/logger.js";

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

    CREATE INDEX IF NOT EXISTS idx_node_failure_events_node_url
      ON node_failure_events (node_url);

    CREATE INDEX IF NOT EXISTS idx_node_failure_events_created_at
      ON node_failure_events (created_at);

    CREATE INDEX IF NOT EXISTS idx_rpc_node_health_recovery
      ON rpc_node_health (is_healthy, next_retry_at);
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
    logger.error("Failed to record node health", {
      nodeUrl: status.nodeUrl,
      error: err instanceof Error ? err.message : String(err),
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
    const startedAt = Date.now();

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

    const mapped = mapHealthRow(write());

    // (#355) Poll diagnostics: elapsed time and payload sizes embedded in the
    // message so plain-string log shipping preserves them too.
    const elapsedMs = Date.now() - startedAt;
    logger.debug(
      `node failure poll for ${nodeUrl} recorded in ${elapsedMs}ms ` +
        `(payload: failure_count=${mapped.failureCount}, ` +
        `backoff_duration_ms=${mapped.backoffDurationMs}, ` +
        `is_healthy=${mapped.isHealthy})`
    );

    return mapped;
  } catch (err) {
    logger.error("Failed to record node failure", {
      nodeUrl,
      error: err instanceof Error ? err.message : String(err),
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
    const successStartedAt = Date.now();

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

    const mappedSuccess = mapHealthRow(write());

    // (#355) Poll diagnostics for the success path as well.
    const successElapsedMs = Date.now() - successStartedAt;
    logger.debug(
      `node success poll for ${nodeUrl} recorded in ${successElapsedMs}ms ` +
        `(payload: consecutive_successes=${mappedSuccess.consecutiveSuccesses}, ` +
        `failure_count=${mappedSuccess.failureCount})`
    );

    return mappedSuccess;
  } catch (err) {
    logger.error("Failed to record node success", {
      nodeUrl,
      error: err instanceof Error ? err.message : String(err),
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
    logger.error("Failed to fail over to node", {
      nodeUrl,
      error: err instanceof Error ? err.message : String(err),
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
    return null;
  }

  if (getActiveNodeUrl() !== nodeUrl) {
    await failoverToNode(nodeUrl);
  }

  return { server: createServer(nodeUrl), nodeUrl };
}
