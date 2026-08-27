import Database from "better-sqlite3";
import { runMigrations, setDb, insertEvent, setLastIndexedLedger } from "../src/indexer/db.js";
import {
  collectIndexerMetrics,
  verifyIndexerSchema,
  collectIndexerMetricsInRange,
  computeDynamicPollInterval,
} from "../src/indexer/indexer_metrics_collector.js";

describe("indexer_metrics_collector", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
    runMigrations();
  });

  afterAll(() => {
    testDb.close();
  });

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

// -------------------------------------------------------------------------
// verifyIndexerSchema (#340)
// -------------------------------------------------------------------------
describe("verifyIndexerSchema (#340)", () => {
  it("passes on a fully migrated database", () => {
    const result = verifyIndexerSchema(testDb);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("reports missing tables on a bare database", () => {
    const bare = new Database(":memory:");
    const result = verifyIndexerSchema(bare);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("events");
    expect(result.missing).toContain("indexer_state");
    bare.close();
  });
});

// -------------------------------------------------------------------------
// collectIndexerMetricsInRange (#339)
// -------------------------------------------------------------------------
describe("collectIndexerMetricsInRange (#339)", () => {
  it("restricts metrics to the inclusive ledger range", () => {
    setLastIndexedLedger(500);
    insertEvent("contract-9", "job_created", 90, 1600000000, "{}");
    insertEvent("contract-9", "transfer", 100, 1600000050, "{}");
    insertEvent("contract-9", "transfer", 110, 1600000100, "{}");

    const metrics = collectIndexerMetricsInRange(95, 115, testDb);

    expect(metrics.startLedger).toBe(95);
    expect(metrics.endLedger).toBe(115);
    expect(metrics.totalEvents).toBe(1); // only ledger 110 is inside
    expect(metrics.eventsByType["transfer"]).toBe(1);
  });

  it("rejects endLedger < startLedger", () => {
    expect(() => collectIndexerMetricsInRange(200, 100, testDb)).toThrow(
      /endLedger/
    );
  });
});

// -------------------------------------------------------------------------
// computeDynamicPollInterval (#341)
// -------------------------------------------------------------------------
describe("computeDynamicPollInterval (#341)", () => {
  it("uses the base interval on an empty ledger", () => {
    const { intervalMs } = computeDynamicPollInterval({
      lastIndexedLedger: 0,
      totalEvents: 0,
      lastEventAt: null,
      eventsByType: {},
      activeContractsCount: 0,
      totalSubscriptions: 0,
      collectedAt: new Date().toISOString(),
    });
    expect(intervalMs).toBe(1000);
  });

  it("stretches the interval as ledger density grows", () => {
    const base = {
      lastEventAt: null,
      eventsByType: {},
      activeContractsCount: 0,
      totalSubscriptions: 0,
      collectedAt: new Date().toISOString(),
    };

    const sparse = computeDynamicPollInterval(
      { ...base, lastIndexedLedger: 500, totalEvents: 500 }
    );
    const dense = computeDynamicPollInterval(
      { ...base, lastIndexedLedger: 500, totalEvents: 4000 }
    );

    expect(sparse.eventsPerLedger).toBe(1);
    expect(dense.eventsPerLedger).toBe(8);
    expect(dense.intervalMs).toBeGreaterThan(sparse.intervalMs);
  });

  it("clamps the interval to maxIntervalMs", () => {
    const { intervalMs } = computeDynamicPollInterval(
      {
        lastIndexedLedger: 10,
        totalEvents: 1000000,
        lastEventAt: null,
        eventsByType: {},
        activeContractsCount: 0,
        totalSubscriptions: 0,
        collectedAt: new Date().toISOString(),
      },
      { maxIntervalMs: 30000 }
    );
    expect(intervalMs).toBe(30000);
  });
});

// -------------------------------------------------------------------------
// Simulated RPC events (#342)
// -------------------------------------------------------------------------
describe("simulated RPC events (#342)", () => {
  it("writes simulated RPC batches and captures them in range metrics", () => {
    // Simulate two RPC deliveries writing through the production path.
    insertEvent("contract-42", "transfer", 300, 1700000100, "{}");
    insertEvent("contract-42", "mint", 301, 1700000200, "{}");
    insertEvent("contract-42", "burn", 305, 1700000300, "{}");
    setLastIndexedLedger(305);

    const range = collectIndexerMetricsInRange(300, 305, testDb);
    expect(range.totalEvents).toBe(3);
    expect(range.eventsByType).toEqual({ transfer: 1, mint: 1, burn: 1 });

    // The whole-collection metrics agree with the range view.
    const all = collectIndexerMetrics(testDb);
    expect(all.totalEvents).toBe(3);
  });

  it("verifyIndexerSchema flags a dropped table before collection", () => {
    testDb.exec("DROP TABLE webhook_subscriptions");
    const result = verifyIndexerSchema(testDb);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("webhook_subscriptions");
    // Restore for other tests.
    testDb.exec(
      "CREATE TABLE IF NOT EXISTS webhook_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id TEXT NOT NULL, webhook_url TEXT NOT NULL, event_types TEXT NOT NULL DEFAULT '*', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(contract_id, webhook_url))"
    );
  });
});
