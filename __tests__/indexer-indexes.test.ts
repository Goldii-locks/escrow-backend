import Database from "better-sqlite3";
import {
  setDb,
  runMigrations,
  insertEvent,
  getActiveContractIds,
  getIndexerStatusData,
  INDEXER_RUNNER_INDEXES,
} from "../src/indexer/db.js";
import { getDb } from "../src/indexer/db.js";
import {
  initializeSyncRangesTable,
  isLedgerSynced,
  SYNC_RANGES_INDEXES,
} from "../src/indexer/duplicate-prevention.js";
import {
  explainQueryPlan,
  queryPlanUsesIndex,
} from "../src/indexer/ledger-range-tracker.js";

describe("indexer_runner SQLite index utilization – EXPLAIN QUERY PLAN (#250)", () => {
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
    testDb.exec("DROP TABLE IF EXISTS webhook_subscriptions");
    testDb.exec("DROP TABLE IF EXISTS sync_ranges");
    testDb.exec("DROP TABLE IF EXISTS schema_migrations");
    runMigrations();
  });

  describe("monitored_contracts (active) for getActiveContractIds", () => {
    it("uses idx_monitored_contracts_active for the active lookup", () => {
      // Seed enough rows that the planner prefers the index over a scan.
      const db = getDb();
      const insert = db.prepare(
        `INSERT OR IGNORE INTO monitored_contracts (contract_id, active)
         VALUES (?, 1)`,
      );
      for (let i = 0; i < 200; i++) {
        insert.run(`C${i}`);
      }
      db.prepare(
        `INSERT INTO monitored_contracts (contract_id, active) VALUES ('C-INACTIVE', 0)`,
      ).run();

      const plan = explainQueryPlan(
        `SELECT contract_id FROM monitored_contracts WHERE active = 1`,
      );

      expect(
        queryPlanUsesIndex(plan, INDEXER_RUNNER_INDEXES.monitoredContractsActive),
      ).toBe(true);
      expect(getActiveContractIds()).toHaveLength(200);
    });
  });

  describe("events (created_at) for status lookups", () => {
    it("uses idx_events_created_at for the MAX(created_at) aggregation", () => {
      for (let i = 0; i < 200; i++) {
        insertEvent(
          `C${i % 5}`,
          i % 2 === 0 ? "initialized" : "funded",
          1000 + i,
          2000 + i,
          JSON.stringify({ index: i }),
        );
      }

      const plan = explainQueryPlan(
        `SELECT MAX(created_at) as last_at FROM events`,
      );

      expect(
        queryPlanUsesIndex(plan, INDEXER_RUNNER_INDEXES.eventsCreatedAt),
      ).toBe(true);
      expect(getIndexerStatusData().totalEvents).toBe(200);
    });

    it("leaves event type aggregation working after the index migration", () => {
      for (let i = 0; i < 20; i++) {
        insertEvent(
          `C${i % 2}`,
          i % 2 === 0 ? "initialized" : "funded",
          1000 + i,
          2000 + i,
          JSON.stringify({ index: i }),
        );
      }

      const byType = getIndexerStatusData().eventsByType;
      expect(byType.initialized).toBe(10);
      expect(byType.funded).toBe(10);
    });
  });

  describe("sync_ranges (start_ledger, end_ledger) for ledger lookups", () => {
    it("uses idx_sync_ranges_ledgers for the in-range lookup", () => {
      initializeSyncRangesTable();
      const db = getDb();
      const insert = db.prepare(
        `INSERT OR IGNORE INTO sync_ranges
         (start_ledger, end_ledger, event_count) VALUES (?, ?, 1)`,
      );
      for (let i = 0; i < 200; i++) {
        insert.run(i * 10, i * 10 + 9);
      }

      const plan = explainQueryPlan(
        `SELECT 1 FROM sync_ranges
         WHERE start_ledger <= ? AND end_ledger >= ? LIMIT 1`,
        50,
        55,
      );

      expect(
        queryPlanUsesIndex(plan, SYNC_RANGES_INDEXES.ledgers),
      ).toBe(true);
      expect(isLedgerSynced(55)).toBe(true);
      expect(isLedgerSynced(10_000)).toBe(false);
    });
  });
});
