import type Database from "better-sqlite3";
import { getDb } from "./db.js";

export interface IndexerMetrics {
  lastIndexedLedger: number;
  totalEvents: number;
  lastEventAt: string | null;
  eventsByType: Record<string, number>;
  activeContractsCount: number;
  totalSubscriptions: number;
  collectedAt: string;
}

/**
 * Collect indexer metrics using transaction isolation to ensure
 * a consistent snapshot across all metrics queries.
 */
export function collectIndexerMetrics(targetDb?: Database.Database): IndexerMetrics {
  const database = targetDb || getDb();

  // Execute all metric queries within a database transaction for isolation
  const getMetricsTx = database.transaction(() => {
    const lastLedgerRow = database
      .prepare("SELECT value FROM indexer_state WHERE key = 'last_ledger_sequence'")
      .get() as { value: string } | undefined;
    const lastIndexedLedger = lastLedgerRow ? parseInt(lastLedgerRow.value, 10) : 0;

    const totalRow = database
      .prepare("SELECT COUNT(*) as count FROM events")
      .get() as { count: number };

    const lastEventRow = database
      .prepare("SELECT MAX(created_at) as last_at FROM events")
      .get() as { last_at: string | null };

    const typeRows = database
      .prepare("SELECT event_type, COUNT(*) as count FROM events GROUP BY event_type")
      .all() as Array<{ event_type: string; count: number }>;

    const eventsByType: Record<string, number> = {};
    for (const row of typeRows) {
      eventsByType[row.event_type] = row.count;
    }

    let activeContractsCount = 0;
    try {
      const activeContractsRow = database
        .prepare("SELECT COUNT(*) as count FROM monitored_contracts WHERE active = 1")
        .get() as { count: number } | undefined;
      activeContractsCount = activeContractsRow ? activeContractsRow.count : 0;
    } catch {
      // monitored_contracts table might not exist yet
    }

    let totalSubscriptions = 0;
    try {
      const subscriptionsRow = database
        .prepare("SELECT COUNT(*) as count FROM webhook_subscriptions")
        .get() as { count: number } | undefined;
      totalSubscriptions = subscriptionsRow ? subscriptionsRow.count : 0;
    } catch {
      // webhook_subscriptions table might not exist yet
    }

    return {
      lastIndexedLedger,
      totalEvents: totalRow ? totalRow.count : 0,
      lastEventAt: lastEventRow ? lastEventRow.last_at : null,
      eventsByType,
      activeContractsCount,
      totalSubscriptions,
      collectedAt: new Date().toISOString(),
    };
  });

  return getMetricsTx();
}

// ---------------------------------------------------------------------------
// Migration verification hook (#340)
// ---------------------------------------------------------------------------

/** Tables the metrics collector depends on. */
export const REQUIRED_TABLES = [
  "events",
  "indexer_state",
  "monitored_contracts",
  "webhook_subscriptions",
] as const;

export interface SchemaVerificationResult {
  ok: boolean;
  /** Tables from REQUIRED_TABLES that are missing from sqlite_master. */
  missing: string[];
}

/**
 * (#340) Migration verification hook: validate that every table the metrics
 * collector depends on exists before collection starts. Call this before
 * `collectIndexerMetrics` in startup paths so a half-migrated database fails
 * loudly instead of returning zeros silently.
 */
export function verifyIndexerSchema(
  targetDb?: Database.Database
): SchemaVerificationResult {
  const database = targetDb || getDb();

  const rows = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    )
    .all() as Array<{ name: string }>;
  const present = new Set(rows.map((row) => row.name));

  const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Ledger-range metrics (#339)
// ---------------------------------------------------------------------------

export interface LedgerRangeMetrics {
  startLedger: number;
  endLedger: number;
  /** Events whose ledger_sequence falls inside the inclusive range. */
  totalEvents: number;
  eventsByType: Record<string, number>;
  lastEventAt: string | null;
  collectedAt: string;
}

/**
 * (#339) Metrics restricted to an inclusive ledger range, for custom
 * historical event imports: callers can point the collector at
 * [startLedger, endLedger] and verify what the indexer actually wrote
 * there without scanning the whole table.
 */
export function collectIndexerMetricsInRange(
  startLedger: number,
  endLedger: number,
  targetDb?: Database.Database
): LedgerRangeMetrics {
  const database = targetDb || getDb();

  if (endLedger < startLedger) {
    throw new Error(
      `endLedger (${endLedger}) must be >= startLedger (${startLedger})`
    );
  }

  const rangeTx = database.transaction(() => {
    const totalRow = database
      .prepare(
        "SELECT COUNT(*) as count FROM events WHERE ledger_sequence BETWEEN ? AND ?"
      )
      .get(startLedger, endLedger) as { count: number };

    const typeRows = database
      .prepare(
        "SELECT event_type, COUNT(*) as count FROM events WHERE ledger_sequence BETWEEN ? AND ? GROUP BY event_type"
      )
      .all(startLedger, endLedger) as Array<{ event_type: string; count: number }>;

    const eventsByType: Record<string, number> = {};
    for (const row of typeRows) {
      eventsByType[row.event_type] = row.count;
    }

    const lastEventRow = database
      .prepare(
        "SELECT MAX(created_at) as last_at FROM events WHERE ledger_sequence BETWEEN ? AND ?"
      )
      .get(startLedger, endLedger) as { last_at: string | null };

    return {
      startLedger,
      endLedger,
      totalEvents: totalRow ? totalRow.count : 0,
      eventsByType,
      lastEventAt: lastEventRow ? lastEventRow.last_at : null,
      collectedAt: new Date().toISOString(),
    };
  });

  return rangeTx();
}

// ---------------------------------------------------------------------------
// Dynamic poll interval heuristic (#341)
// ---------------------------------------------------------------------------

/** Base interval when load is neutral. */
export const DEFAULT_BASE_POLL_INTERVAL_MS = 1000;
/** Fastest allowed interval when the ledger is empty. */
export const DEFAULT_MIN_POLL_INTERVAL_MS = 250;
/** Slowest allowed interval under a heavy backlog. */
export const DEFAULT_MAX_POLL_INTERVAL_MS = 30000;

export interface DynamicPollIntervalOptions {
  baseIntervalMs?: number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
}

export interface DynamicPollIntervalResult {
  /** Suggested interval in milliseconds. */
  intervalMs: number;
  /** Events per ledger step derived from the metrics. */
  eventsPerLedger: number;
}

/**
 * (#341) Suggest a polling frequency from ledger processing load.
 *
 * Heuristic: the denser the chain (more events per ledger step), the more
 * work each poll performs, so the interval stretches toward maxIntervalMs;
 * a sparse or empty ledger polls at minIntervalMs. The result is always
 * clamped to [minIntervalMs, maxIntervalMs] and grows exponentially with
 * the events-per-ledger ratio so bursts back off smoothly instead of
 * stepping line by line.
 */
export function computeDynamicPollInterval(
  metrics: IndexerMetrics,
  options: DynamicPollIntervalOptions = {}
): DynamicPollIntervalResult {
  const baseIntervalMs =
    options.baseIntervalMs ?? DEFAULT_BASE_POLL_INTERVAL_MS;
  const minIntervalMs =
    options.minIntervalMs ?? DEFAULT_MIN_POLL_INTERVAL_MS;
  const maxIntervalMs =
    options.maxIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS;

  const lastLedger = Math.max(metrics.lastIndexedLedger, 1);
  const eventsPerLedger = metrics.totalEvents / lastLedger;

  // Doubling threshold: every 2x density doubles the interval.
  const densitySteps = Math.max(0, Math.round(Math.log2(eventsPerLedger + 1)));
  const intervalMs = Math.min(
    maxIntervalMs,
    Math.max(minIntervalMs, baseIntervalMs * 2 ** densitySteps)
  );

  return { intervalMs, eventsPerLedger };
}

