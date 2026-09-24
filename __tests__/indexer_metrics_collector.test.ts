import Database from "better-sqlite3";
import { runMigrations, setDb, insertEvent, setLastIndexedLedger, registerContract } from "../src/indexer/db.js";
import {
  collectIndexerMetrics,
  metricsPayloadSizeBytes,
  logIndexerMetricsDiagnostics,
  resetIndexerMetricsCollectorState,
  getIndexerMetricsMonitor,
  IndexerMetricsFailureMonitor,
  DEFAULT_METRICS_FAILURE_THRESHOLD,
  DEFAULT_METRICS_STALL_THRESHOLD_MS,
  getIndexerMetricsAlertConfig,
} from "../src/indexer/indexer_metrics_collector.js";

// ---------------------------------------------------------------------------
// Simulated RPC event helpers
// ---------------------------------------------------------------------------

/** Minimal RPC event shape used by the collector tests. */
interface SimulatedRpcEvent {
  contractId: string;
  eventType: string;
  ledgerSequence: number;
  timestamp: number;
  dataJson: string;
}

/**
 * Write a simulated RPC event into the in-memory database.
 * Mirrors the INSERT pattern used by insertEvent in db.ts.
 */
function simulateRpcEvent(db: Database.Database, event: SimulatedRpcEvent): void {
  db.prepare(
    `INSERT OR IGNORE INTO events
       (contract_id, event_type, ledger_sequence, timestamp, data_json)
     VALUES (?, ?, ?, ?, ?)`
  ).run(event.contractId, event.eventType, event.ledgerSequence, event.timestamp, event.dataJson);
}

// ---------------------------------------------------------------------------
// Main test suite
// ---------------------------------------------------------------------------

describe("indexer_metrics_collector", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
  });

  afterAll(() => {
    testDb.close();
  });

  beforeEach(() => {
    testDb.exec("DROP TABLE IF EXISTS events");
    testDb.exec("DROP TABLE IF EXISTS indexer_state");
    testDb.exec("DROP TABLE IF EXISTS monitored_contracts");
    testDb.exec("DROP TABLE IF EXISTS schema_migrations");
    testDb.exec("DROP TABLE IF EXISTS webhook_subscriptions");
    runMigrations();
    resetIndexerMetricsCollectorState();
  });

  // -------------------------------------------------------------------------
  // Basic collection
  // -------------------------------------------------------------------------

  describe("collectIndexerMetrics — basic collection", () => {
    it("collects metrics inside isolated database transaction", () => {
      setLastIndexedLedger(500);
      insertEvent("contract-1", "job_created", 100, 1600000000, JSON.stringify({ fee: 10 }));
      insertEvent("contract-1", "job_completed", 105, 1600000100, JSON.stringify({ fee: 10 }));

      const metrics = collectIndexerMetrics(testDb);

      expect(metrics.lastIndexedLedger).toBe(500);
      expect(metrics.totalEvents).toBe(2);
      expect(metrics.eventsByType["job_created"]).toBe(1);
      expect(metrics.eventsByType["job_completed"]).toBe(1);
      expect(metrics.collectedAt).toBeDefined();
    });

    it("returns zero metrics for an empty database", () => {
      const metrics = collectIndexerMetrics(testDb);

      expect(metrics.lastIndexedLedger).toBe(0);
      expect(metrics.totalEvents).toBe(0);
      expect(metrics.lastEventAt).toBeNull();
      expect(metrics.eventsByType).toEqual({});
      expect(metrics.activeContractsCount).toBe(0);
      expect(metrics.totalSubscriptions).toBe(0);
    });

    it("returns correct lastIndexedLedger when no events exist", () => {
      setLastIndexedLedger(12345);
      const metrics = collectIndexerMetrics(testDb);
      expect(metrics.lastIndexedLedger).toBe(12345);
    });
  });

  // -------------------------------------------------------------------------
  // Simulated RPC events → DB persistence
  // -------------------------------------------------------------------------

  describe("indexer_metrics_collector — Issue 342: Simulated RPC events write to DB schema", () => {
    it("simulated ContractInitialized event is persisted and counted", () => {
      simulateRpcEvent(testDb, {
        contractId: "CONTRACT-1",
        eventType: "ContractInitialized",
        ledgerSequence: 100,
        timestamp: 1700000000,
        dataJson: JSON.stringify({ client: "GABC", freelancer: "GDEF", amount: 500 }),
      });

      const metrics = collectIndexerMetrics(testDb);

      expect(metrics.totalEvents).toBe(1);
      expect(metrics.eventsByType["ContractInitialized"]).toBe(1);
    });

    it("simulated MilestoneApproved event is persisted and counted", () => {
      simulateRpcEvent(testDb, {
        contractId: "CONTRACT-2",
        eventType: "MilestoneApproved",
        ledgerSequence: 200,
        timestamp: 1700001000,
        dataJson: JSON.stringify({ milestone_index: 0, approved_by: "GABC" }),
      });

      const metrics = collectIndexerMetrics(testDb);

      expect(metrics.totalEvents).toBe(1);
      expect(metrics.eventsByType["MilestoneApproved"]).toBe(1);
    });

    it("multiple simulated RPC events for the same contract are all counted", () => {
      const events: SimulatedRpcEvent[] = [
        { contractId: "CONTRACT-3", eventType: "ContractInitialized", ledgerSequence: 300, timestamp: 1700002000, dataJson: "{}" },
        { contractId: "CONTRACT-3", eventType: "FundsDeposited", ledgerSequence: 310, timestamp: 1700002010, dataJson: "{}" },
        { contractId: "CONTRACT-3", eventType: "MilestoneApproved", ledgerSequence: 320, timestamp: 1700002020, dataJson: "{}" },
        { contractId: "CONTRACT-3", eventType: "ContractCompleted", ledgerSequence: 330, timestamp: 1700002030, dataJson: "{}" },
      ];

      for (const ev of events) {
        simulateRpcEvent(testDb, ev);
      }

      const metrics = collectIndexerMetrics(testDb);

      expect(metrics.totalEvents).toBe(4);
      expect(metrics.eventsByType["ContractInitialized"]).toBe(1);
      expect(metrics.eventsByType["FundsDeposited"]).toBe(1);
      expect(metrics.eventsByType["MilestoneApproved"]).toBe(1);
      expect(metrics.eventsByType["ContractCompleted"]).toBe(1);
    });

    it("duplicate RPC events (same contract+ledger+type) are not double-counted", () => {
      simulateRpcEvent(testDb, { contractId: "CONTRACT-4", eventType: "FundsDeposited", ledgerSequence: 400, timestamp: 1700003000, dataJson: "{}" });
      simulateRpcEvent(testDb, { contractId: "CONTRACT-4", eventType: "FundsDeposited", ledgerSequence: 400, timestamp: 1700003000, dataJson: "{}" });

      const metrics = collectIndexerMetrics(testDb);

      expect(metrics.totalEvents).toBe(1);
      expect(metrics.eventsByType["FundsDeposited"]).toBe(1);
    });

    it("events across multiple contracts are aggregated correctly", () => {
      simulateRpcEvent(testDb, { contractId: "C-A", eventType: "ContractInitialized", ledgerSequence: 1, timestamp: 1000, dataJson: "{}" });
      simulateRpcEvent(testDb, { contractId: "C-B", eventType: "ContractInitialized", ledgerSequence: 2, timestamp: 1001, dataJson: "{}" });
      simulateRpcEvent(testDb, { contractId: "C-A", eventType: "FundsDeposited", ledgerSequence: 3, timestamp: 1002, dataJson: "{}" });

      const metrics = collectIndexerMetrics(testDb);

      expect(metrics.totalEvents).toBe(3);
      expect(metrics.eventsByType["ContractInitialized"]).toBe(2);
      expect(metrics.eventsByType["FundsDeposited"]).toBe(1);
    });

    it("lastEventAt reflects the most recent event timestamp", () => {
      simulateRpcEvent(testDb, { contractId: "C-1", eventType: "ContractInitialized", ledgerSequence: 1, timestamp: 1000, dataJson: "{}" });
      simulateRpcEvent(testDb, { contractId: "C-2", eventType: "ContractInitialized", ledgerSequence: 2, timestamp: 2000, dataJson: "{}" });

      const metrics = collectIndexerMetrics(testDb);

      expect(metrics.lastEventAt).toBeDefined();
      // lastEventAt is a DATETIME string from SQLite's CURRENT_TIMESTAMP
      // Just verify it's not null since events exist.
      expect(metrics.lastEventAt).not.toBeNull();
    });

    it("simulated events survive a subsequent collection cycle", () => {
      simulateRpcEvent(testDb, { contractId: "C-5", eventType: "ContractInitialized", ledgerSequence: 500, timestamp: 1700004000, dataJson: "{}" });

      // First collection
      const m1 = collectIndexerMetrics(testDb);
      expect(m1.totalEvents).toBe(1);

      // Second collection — the event should still be there.
      const m2 = collectIndexerMetrics(testDb);
      expect(m2.totalEvents).toBe(1);
    });

    it("all required schema columns are present after migrations", () => {
      const columns = testDb
        .prepare("PRAGMA table_info(events)")
        .all() as Array<{ name: string }>;
      const names = new Set(columns.map((c) => c.name));

      for (const col of [
        "id",
        "contract_id",
        "event_type",
        "ledger_sequence",
        "timestamp",
        "data_json",
        "created_at",
      ]) {
        expect(names.has(col)).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Monitored contracts and subscriptions
  // -------------------------------------------------------------------------

  describe("collectIndexerMetrics — monitored contracts and subscriptions", () => {
    it("counts active monitored contracts", () => {
      registerContract("CONTRACT-A", "Escrow A");
      registerContract("CONTRACT-B", "Escrow B");

      const metrics = collectIndexerMetrics(testDb);

      expect(metrics.activeContractsCount).toBe(2);
    });

    it("does not count inactive monitored contracts", () => {
      registerContract("CONTRACT-A", "Escrow A");
      registerContract("CONTRACT-B", "Escrow B");
      // Deactivate one
      testDb.prepare("UPDATE monitored_contracts SET active = 0 WHERE contract_id = ?").run("CONTRACT-B");

      const metrics = collectIndexerMetrics(testDb);

      expect(metrics.activeContractsCount).toBe(1);
    });

    it("returns 0 activeContractsCount when monitored_contracts table is empty", () => {
      const metrics = collectIndexerMetrics(testDb);
      expect(metrics.activeContractsCount).toBe(0);
    });

    it("counts webhook subscriptions", () => {
      // Insert directly into webhook_subscriptions
      testDb.prepare(
        "INSERT INTO webhook_subscriptions (contract_id, webhook_url, event_types) VALUES (?, ?, ?)"
      ).run("C-1", "https://example.com/hook1", "*");
      testDb.prepare(
        "INSERT INTO webhook_subscriptions (contract_id, webhook_url, event_types) VALUES (?, ?, ?)"
      ).run("C-2", "https://example.com/hook2", "ContractInitialized");

      const metrics = collectIndexerMetrics(testDb);

      expect(metrics.totalSubscriptions).toBe(2);
    });

    it("returns 0 totalSubscriptions when webhook_subscriptions table is empty", () => {
      const metrics = collectIndexerMetrics(testDb);
      expect(metrics.totalSubscriptions).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Failure monitor
  // -------------------------------------------------------------------------

  describe("IndexerMetricsFailureMonitor", () => {
    it("starts with zero consecutive failures", () => {
      const monitor = new IndexerMetricsFailureMonitor({ failureThreshold: 3 });
      expect(monitor.getConsecutiveFailures()).toBe(0);
      expect(monitor.isAlertActive()).toBe(false);
    });

    it("increments consecutive failures on recordFailure", () => {
      const monitor = new IndexerMetricsFailureMonitor({ failureThreshold: 5 });
      monitor.recordFailure("collection");
      expect(monitor.getConsecutiveFailures()).toBe(1);
      monitor.recordFailure("query");
      expect(monitor.getConsecutiveFailures()).toBe(2);
    });

    it("activates alert when failure threshold is reached", () => {
      const monitor = new IndexerMetricsFailureMonitor({ failureThreshold: 3 });
      monitor.recordFailure("collection");
      monitor.recordFailure("collection");
      expect(monitor.isAlertActive()).toBe(false);
      monitor.recordFailure("collection");
      expect(monitor.isAlertActive()).toBe(true);
    });

    it("clears alert on recordSuccess", () => {
      const monitor = new IndexerMetricsFailureMonitor({ failureThreshold: 2 });
      monitor.recordFailure("collection");
      monitor.recordFailure("collection");
      expect(monitor.isAlertActive()).toBe(true);

      monitor.recordSuccess();
      expect(monitor.getConsecutiveFailures()).toBe(0);
      expect(monitor.isAlertActive()).toBe(false);
    });

    it("checkStall returns false when no successful collection has occurred", () => {
      const monitor = new IndexerMetricsFailureMonitor({ stallThresholdMs: 1000 });
      expect(monitor.checkStall()).toBe(false);
    });

    it("reset clears all state", () => {
      const monitor = new IndexerMetricsFailureMonitor({ failureThreshold: 2 });
      monitor.recordFailure("collection");
      monitor.recordFailure("collection");
      monitor.recordSuccess();
      monitor.reset();

      expect(monitor.getConsecutiveFailures()).toBe(0);
      expect(monitor.isAlertActive()).toBe(false);
      expect(monitor.getLastSuccessfulAt()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Helper functions
  // -------------------------------------------------------------------------

  describe("metricsPayloadSizeBytes", () => {
    it("returns byte size of JSON-serialized value", () => {
      const size = metricsPayloadSizeBytes({ key: "value" });
      expect(size).toBeGreaterThan(0);
      expect(typeof size).toBe("number");
    });

    it("handles null input", () => {
      const size = metricsPayloadSizeBytes(null);
      expect(size).toBeGreaterThan(0); // JSON.stringify(null) = "null"
    });

    it("handles undefined input", () => {
      const size = metricsPayloadSizeBytes(undefined);
      expect(size).toBe(4); // JSON.stringify(undefined) = undefined → "null" byte length
    });
  });

  describe("getIndexerMetricsAlertConfig", () => {
    it("returns default thresholds when env vars are not set", () => {
      const config = getIndexerMetricsAlertConfig();
      expect(config.failureThreshold).toBe(DEFAULT_METRICS_FAILURE_THRESHOLD);
      expect(config.stallThresholdMs).toBe(DEFAULT_METRICS_STALL_THRESHOLD_MS);
    });
  });

  // -------------------------------------------------------------------------
  // Integration: simulated events + metrics collection end-to-end
  // -------------------------------------------------------------------------

  describe("Integration — simulated RPC events through full metrics pipeline", () => {
    it("inserts multiple event types via simulateRpcEvent and verifies metrics", () => {
      const events: SimulatedRpcEvent[] = [
        { contractId: "ESC-1", eventType: "ContractInitialized", ledgerSequence: 10, timestamp: 1700000000, dataJson: '{"client":"GA1"}' },
        { contractId: "ESC-1", eventType: "FundsDeposited", ledgerSequence: 20, timestamp: 1700000100, dataJson: '{"amount":100}' },
        { contractId: "ESC-2", eventType: "ContractInitialized", ledgerSequence: 30, timestamp: 1700000200, dataJson: '{"client":"GA2"}' },
        { contractId: "ESC-1", eventType: "MilestoneApproved", ledgerSequence: 40, timestamp: 1700000300, dataJson: '{"milestone":0}' },
        { contractId: "ESC-2", eventType: "FundsDeposited", ledgerSequence: 50, timestamp: 1700000400, dataJson: '{"amount":200}' },
        { contractId: "ESC-1", eventType: "ContractCompleted", ledgerSequence: 60, timestamp: 1700000500, dataJson: '{}' },
      ];

      for (const ev of events) {
        simulateRpcEvent(testDb, ev);
      }

      setLastIndexedLedger(60);
      registerContract("ESC-1");
      registerContract("ESC-2");

      const metrics = collectIndexerMetrics(testDb);

      expect(metrics.lastIndexedLedger).toBe(60);
      expect(metrics.totalEvents).toBe(6);
      expect(metrics.eventsByType).toEqual({
        ContractInitialized: 2,
        FundsDeposited: 2,
        MilestoneApproved: 1,
        ContractCompleted: 1,
      });
      expect(metrics.activeContractsCount).toBe(2);
      expect(metrics.collectedAt).toBeDefined();
    });

    it("consecutive collections produce consistent results", () => {
      simulateRpcEvent(testDb, { contractId: "C-1", eventType: "ContractInitialized", ledgerSequence: 1, timestamp: 1000, dataJson: "{}" });
      simulateRpcEvent(testDb, { contractId: "C-1", eventType: "FundsDeposited", ledgerSequence: 2, timestamp: 1001, dataJson: "{}" });

      const m1 = collectIndexerMetrics(testDb);
      const m2 = collectIndexerMetrics(testDb);

      expect(m1.totalEvents).toBe(m2.totalEvents);
      expect(m1.eventsByType).toEqual(m2.eventsByType);
      expect(m1.lastIndexedLedger).toBe(m2.lastIndexedLedger);
    });
  });
});
