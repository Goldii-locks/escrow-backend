import type Database from "better-sqlite3";
import { getDb } from "./db.js";
import logger from "../utils/logger.js";
import { FailureMonitor } from "./failure-monitor.js";

export interface IndexerMetrics {
  lastIndexedLedger: number;
  totalEvents: number;
  lastEventAt: string | null;
  eventsByType: Record<string, number>;
  activeContractsCount: number;
  totalSubscriptions: number;
  collectedAt: string;
}

const COLLECTOR_NAME = "indexer_metrics_collector";

export interface IndexerMetricsMonitorOptions {
  name?: string;
  failureThreshold?: number;
  stallThresholdMs?: number;
}

export class IndexerMetricsFailureMonitor extends FailureMonitor {
  readonly collector: string;

  constructor(options: IndexerMetricsMonitorOptions = {}) {
    super({
      name: options.name ?? COLLECTOR_NAME,
      logComponent: COLLECTOR_NAME,
      payloadKey: "collector",
      failureThreshold: options.failureThreshold ?? 3,
      stallThresholdMs: options.stallThresholdMs ?? 120_000,
      thresholdReachedOrExceeded: true,
      logRecoveryOnSuccess: true,
      onError: (_failureType, payload) => {
        logger.error("indexer_metrics_collector operation failed", payload);
      },
      onAlert: (payload) => {
        logger.warn(
          "indexer_metrics_collector alert: consecutive failure threshold reached",
          payload,
        );
      },
    });
    this.collector = COLLECTOR_NAME;
  }
}

const defaultMonitor = new IndexerMetricsFailureMonitor();

const INDEXER_METRICS_QUERIES = {
  lastLedger:
    "SELECT value FROM indexer_state WHERE key = 'last_ledger_sequence'",
  totalEvents: "SELECT COUNT(*) as count FROM events",
  lastEventAt: "SELECT MAX(created_at) as last_at FROM events",
  eventsByType:
    "SELECT event_type, COUNT(*) as count FROM events GROUP BY event_type",
  activeContracts:
    "SELECT COUNT(*) as count FROM monitored_contracts WHERE active = 1",
  subscriptions: "SELECT COUNT(*) as count FROM webhook_subscriptions",
} as const;

export function collectIndexerMetrics(
  targetDb?: Database.Database,
): IndexerMetrics {
  const database = targetDb || getDb();
  const monitor = defaultMonitor;

  monitor.checkStall();

  const getMetricsTx = database.transaction(() => {
    const lastLedgerRow = database
      .prepare(INDEXER_METRICS_QUERIES.lastLedger)
      .get() as { value: string } | undefined;
    const lastIndexedLedger = lastLedgerRow ? parseInt(lastLedgerRow.value, 10) : 0;

    const totalRow = database
      .prepare(INDEXER_METRICS_QUERIES.totalEvents)
      .get() as { count: number };

    const lastEventRow = database
      .prepare(INDEXER_METRICS_QUERIES.lastEventAt)
      .get() as { last_at: string | null };

    const typeRows = database
      .prepare(INDEXER_METRICS_QUERIES.eventsByType)
      .all() as Array<{ event_type: string; count: number }>;

    const eventsByType: Record<string, number> = {};
    for (const row of typeRows) {
      eventsByType[row.event_type] = row.count;
    }

    let activeContractsCount = 0;
    try {
      const activeContractsRow = database
        .prepare(INDEXER_METRICS_QUERIES.activeContracts)
        .get() as { count: number } | undefined;
      activeContractsCount = activeContractsRow ? activeContractsRow.count : 0;
    } catch {
      // Optional table
    }

    let totalSubscriptions = 0;
    try {
      const subscriptionsRow = database
        .prepare(INDEXER_METRICS_QUERIES.subscriptions)
        .get() as { count: number } | undefined;
      totalSubscriptions = subscriptionsRow ? subscriptionsRow.count : 0;
    } catch {
      // Optional table
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

  try {
    const metrics = getMetricsTx();
    monitor.recordSuccess();
    return metrics;
  } catch (err) {
    monitor.recordFailure("collection", err);
    throw err;
  }
}
