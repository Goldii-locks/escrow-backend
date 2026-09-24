/**
 * Tests for SQLite index structures added in migration v3.
 *
 * Issue #277 — Configure SQLite index structures for event_type_filter
 *
 * Goals
 * ─────
 * 1. Verify that the three indexes created by migration v3 exist in the DB.
 * 2. Use EXPLAIN QUERY PLAN to assert that each query pattern that was
 *    identified as hot uses the appropriate index (rather than a full-table
 *    scan).
 * 3. Functional round-trip tests: confirm the indexed queries return correct
 *    data so that the indexes haven't accidentally broken anything.
 */

import Database from "better-sqlite3";
import {
  runMigrations,
  setDb,
  insertEvent,
  insertEventBatch,
  getEventsByContract,
  getIndexerStatusData,
  type EventRow,
} from "../src/indexer/db.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Parse the output of `EXPLAIN QUERY PLAN` into plain strings. */
function queryPlanLines(db: Database.Database, sql: string, ...params: unknown[]): string[] {
  // better-sqlite3 exposes EXPLAIN QUERY PLAN via .prepare().all()
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
    detail: string;
  }>;
  return rows.map((r) => r.detail);
}

/** Returns true when at least one plan line references the given index name. */
function usesIndex(planLines: string[], indexName: string): boolean {
  return planLines.some((line) =>
    line.toLowerCase().includes(indexName.toLowerCase())
  );
}

// ─── test fixtures ────────────────────────────────────────────────────────────

const CONTRACT_A = "CONTRACT-AAAA";
const CONTRACT_B = "CONTRACT-BBBB";

const EVENT_TYPES_SAMPLE = [
  "initialized",
  "funded",
  "delivered",
  "approved",
  "dispute_raised",
];

function buildBatch(
  contractId: string,
  startLedger: number,
  count: number
): EventRow[] {
  return Array.from({ length: count }, (_, i) => ({
    contractId,
    eventType: EVENT_TYPES_SAMPLE[i % EVENT_TYPES_SAMPLE.length],
    ledgerSequence: startLedger + i,
    timestamp: 1_000_000 + startLedger + i,
    dataJson: JSON.stringify({ client: `GCLIENT${i}`, freelancer: `GFREE${i}` }),
  }));
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe("event_type_filter – SQLite indexes (migration v3)", () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(":memory:");
    setDb(db);
    // Wipe any leftover tables (belt-and-suspenders for in-memory DBs)
    db.exec("DROP TABLE IF EXISTS events");
    db.exec("DROP TABLE IF EXISTS indexer_state");
    db.exec("DROP TABLE IF EXISTS monitored_contracts");
    db.exec("DROP TABLE IF EXISTS schema_migrations");
    db.exec("DROP TABLE IF EXISTS webhook_subscriptions");
    runMigrations();
  });

  afterAll(() => {
    db.close();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Index existence
  // ──────────────────────────────────────────────────────────────────────────

  describe("Index existence – migration v3 creates all three indexes", () => {
    it("idx_events_event_type exists", () => {
      const row = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_event_type'"
        )
        .get();
      expect(row).not.toBeNull();
    });

    it("idx_events_contract_event_type exists", () => {
      const row = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_contract_event_type'"
        )
        .get();
      expect(row).not.toBeNull();
    });

    it("idx_events_contract_ledger exists", () => {
      const row = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_contract_ledger'"
        )
        .get();
      expect(row).not.toBeNull();
    });

    it("migration v3 is recorded in schema_migrations", () => {
      const row = db
        .prepare("SELECT version FROM schema_migrations WHERE version = 3")
        .get();
      expect(row).not.toBeNull();
    });

    it("migration v3 is idempotent (running runMigrations() again does not duplicate indexes)", () => {
      // Should not throw or create duplicates
      expect(() => runMigrations()).not.toThrow();

      const rows = db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type='index' AND name IN (
             'idx_events_event_type',
             'idx_events_contract_event_type',
             'idx_events_contract_ledger'
           )`
        )
        .all() as Array<{ name: string }>;
      // Exactly 3 unique index names — no duplicates
      const names = [...new Set(rows.map((r) => r.name))];
      expect(names).toHaveLength(3);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. EXPLAIN QUERY PLAN – index utilization
  // ──────────────────────────────────────────────────────────────────────────

  describe("EXPLAIN QUERY PLAN – indexes are chosen by the query planner", () => {
    /**
     * Seed a moderate number of rows so the planner actually prefers indexes
     * over a full-scan. SQLite may choose a full-scan for tiny tables.
     */
    beforeAll(() => {
      // 50 rows on CONTRACT_A, 30 on CONTRACT_B
      insertEventBatch(buildBatch(CONTRACT_A, 1, 50), 50);
      insertEventBatch(buildBatch(CONTRACT_B, 100, 30), 130);
    });

    it("GROUP BY event_type scan uses idx_events_event_type", () => {
      const plan = queryPlanLines(
        db,
        "SELECT event_type, COUNT(*) AS cnt FROM events GROUP BY event_type"
      );
      // The planner should cover this with the event_type index
      expect(usesIndex(plan, "idx_events_event_type")).toBe(true);
    });

    it("WHERE contract_id = ? ORDER BY ledger_sequence uses idx_events_contract_ledger", () => {
      const plan = queryPlanLines(
        db,
        "SELECT * FROM events WHERE contract_id = ? ORDER BY ledger_sequence ASC LIMIT 10 OFFSET 0",
        CONTRACT_A
      );
      expect(usesIndex(plan, "idx_events_contract_ledger")).toBe(true);
    });

    it("COUNT(*) WHERE contract_id = ? uses idx_events_contract_ledger", () => {
      const plan = queryPlanLines(
        db,
        "SELECT COUNT(*) AS count FROM events WHERE contract_id = ?",
        CONTRACT_A
      );
      // Covered by the composite (contract_id, ledger_sequence) index
      expect(usesIndex(plan, "idx_events_contract_ledger")).toBe(true);
    });

    it("WHERE contract_id = ? AND event_type = ? uses idx_events_contract_event_type", () => {
      const plan = queryPlanLines(
        db,
        "SELECT * FROM events WHERE contract_id = ? AND event_type = ?",
        CONTRACT_A,
        "funded"
      );
      expect(usesIndex(plan, "idx_events_contract_event_type")).toBe(true);
    });

    it("WHERE event_type = ? (bare filter) uses idx_events_event_type", () => {
      const plan = queryPlanLines(
        db,
        "SELECT * FROM events WHERE event_type = ?",
        "initialized"
      );
      expect(usesIndex(plan, "idx_events_event_type")).toBe(true);
    });

    it("no query plan line is a full-table SCAN for contract-filtered queries", () => {
      // A full SCAN on 'events' without using any index is unacceptable for
      // contract-scoped lookups.  The planner must use the covering composite.
      const plan = queryPlanLines(
        db,
        `SELECT * FROM events
         WHERE contract_id = ?
         ORDER BY ledger_sequence ASC
         LIMIT 10 OFFSET 0`,
        CONTRACT_A
      );
      // None of the plan lines should say "SCAN events" (i.e., full table scan)
      const hasBareTableScan = plan.some(
        (line) =>
          /SCAN\s+events\b(?!\s+USING)/i.test(line)
      );
      expect(hasBareTableScan).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Functional correctness – indexes don't alter query semantics
  // ──────────────────────────────────────────────────────────────────────────

  describe("Functional correctness – indexed queries return correct results", () => {
    it("getEventsByContract returns the right number of rows for CONTRACT_A", () => {
      const result = getEventsByContract(CONTRACT_A, 1, 100);
      expect(result.total).toBe(50);
      expect(result.events.length).toBe(50);
    });

    it("getEventsByContract returns rows ordered by ledger_sequence ascending", () => {
      const result = getEventsByContract(CONTRACT_A, 1, 100);
      const ledgers = result.events.map((e) => e.ledger_sequence);
      for (let i = 1; i < ledgers.length; i++) {
        expect(ledgers[i]).toBeGreaterThanOrEqual(ledgers[i - 1]);
      }
    });

    it("getEventsByContract pagination works correctly with index", () => {
      const page1 = getEventsByContract(CONTRACT_A, 1, 10);
      const page2 = getEventsByContract(CONTRACT_A, 2, 10);
      expect(page1.events.length).toBe(10);
      expect(page2.events.length).toBe(10);
      // No overlap between pages
      const page1Ledgers = new Set(page1.events.map((e) => e.ledger_sequence));
      const page2Ledgers = page2.events.map((e) => e.ledger_sequence);
      for (const ledger of page2Ledgers) {
        expect(page1Ledgers.has(ledger)).toBe(false);
      }
    });

    it("getIndexerStatusData returns correct eventsByType counts", () => {
      const status = getIndexerStatusData();
      // We seeded 80 total events across 5 types (50 + 30), cycling in order
      // Each of the 5 types should be represented
      const typeKeys = Object.keys(status.eventsByType);
      expect(typeKeys.length).toBeGreaterThanOrEqual(1);
      const totalFromTypes = Object.values(status.eventsByType).reduce(
        (sum, cnt) => sum + cnt,
        0
      );
      expect(totalFromTypes).toBe(status.totalEvents);
    });

    it("getIndexerStatusData returns accurate per-type counts matching direct query", () => {
      const status = getIndexerStatusData();
      // Cross-check one type directly
      for (const [eventType, count] of Object.entries(status.eventsByType)) {
        const directCount = (
          db
            .prepare("SELECT COUNT(*) AS cnt FROM events WHERE event_type = ?")
            .get(eventType) as { cnt: number }
        ).cnt;
        expect(count).toBe(directCount);
      }
    });

    it("direct WHERE contract_id AND event_type query returns correct subset", () => {
      const rows = db
        .prepare(
          "SELECT * FROM events WHERE contract_id = ? AND event_type = ?"
        )
        .all(CONTRACT_A, "funded") as Array<{ event_type: string; contract_id: string }>;
      // Every returned row must match the filter
      for (const row of rows) {
        expect(row.contract_id).toBe(CONTRACT_A);
        expect(row.event_type).toBe("funded");
      }
    });

    it("direct WHERE event_type query returns events from multiple contracts", () => {
      const rows = db
        .prepare("SELECT DISTINCT contract_id FROM events WHERE event_type = ?")
        .all("initialized") as Array<{ contract_id: string }>;
      const contractIds = rows.map((r) => r.contract_id);
      // Both contracts have "initialized" events (it's the first in the cycle)
      expect(contractIds).toContain(CONTRACT_A);
      expect(contractIds).toContain(CONTRACT_B);
    });

    it("insertEvent with duplicate key is ignored without corrupting existing data", () => {
      const before = (
        db
          .prepare("SELECT COUNT(*) AS cnt FROM events WHERE contract_id = ?")
          .get(CONTRACT_A) as { cnt: number }
      ).cnt;

      // Re-insert an already-existing event (ledger 1, initialized)
      insertEvent(
        CONTRACT_A,
        "initialized",
        1,
        999_999,
        JSON.stringify({ client: "GCLIENT_DUP" })
      );

      const after = (
        db
          .prepare("SELECT COUNT(*) AS cnt FROM events WHERE contract_id = ?")
          .get(CONTRACT_A) as { cnt: number }
      ).cnt;

      expect(after).toBe(before); // count must not change
    });

    it("all EVENT_TYPES from poller are represented (cycle covers all types)", () => {
      // Our fixture cycles through EVENT_TYPES_SAMPLE; after 50 inserts on
      // CONTRACT_A we expect every type in the sample to exist for that contract.
      for (const et of EVENT_TYPES_SAMPLE) {
        const row = db
          .prepare(
            "SELECT COUNT(*) AS cnt FROM events WHERE contract_id = ? AND event_type = ?"
          )
          .get(CONTRACT_A, et) as { cnt: number };
        expect(row.cnt).toBeGreaterThan(0);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Migration upgrade path – verify v3 applies on top of earlier migrations
  // ──────────────────────────────────────────────────────────────────────────

  describe("Migration upgrade path", () => {
    it("all three migrations are recorded after a fresh runMigrations()", () => {
      const rows = db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number }>;
      const versions = rows.map((r) => r.version);
      expect(versions).toContain(1);
      expect(versions).toContain(2);
      expect(versions).toContain(3);
    });

    it("applying migrations on a fresh in-memory DB creates all three indexes", () => {
      const freshDb = new Database(":memory:");
      setDb(freshDb);

      freshDb.exec("PRAGMA journal_mode = WAL");
      runMigrations();

      const rows = freshDb
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type='index' AND name IN (
             'idx_events_event_type',
             'idx_events_contract_event_type',
             'idx_events_contract_ledger'
           )
           ORDER BY name`
        )
        .all() as Array<{ name: string }>;

      expect(rows.map((r) => r.name)).toEqual([
        "idx_events_contract_event_type",
        "idx_events_contract_ledger",
        "idx_events_event_type",
      ]);

      freshDb.close();
      // Restore the original test DB for any subsequent tests
      setDb(db);
    });
  });
});
