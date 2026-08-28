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
