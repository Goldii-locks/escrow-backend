import Database from "better-sqlite3";
import { runMigrations, setDb, insertEvent, setLastIndexedLedger } from "../src/indexer/db.js";
import { collectIndexerMetrics } from "../src/indexer/indexer_metrics_collector.js";

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
});
