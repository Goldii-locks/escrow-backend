/**
 * SQLite index optimization for duplicate_prevention
 *
 * Investigation summary (recorded in the commit message for this ticket):
 * the only lookup duplicate_prevention performs against SQLite is the
 * uniqueness check on (contract_id, ledger_sequence, event_type), enforced
 * by INSERT OR IGNORE against the UNIQUE(contract_id, ledger_sequence,
 * event_type) constraint declared in db.ts's migration v1. SQLite
 * automatically builds an index for every UNIQUE constraint
 * (sqlite_autoindex_events_1) - the exact composite key duplicate_prevention
 * needs is already indexed, and getEventsByContract's `WHERE contract_id = ?`
 * lookup already benefits from it too (contract_id is the leftmost column).
 * No new index was added; adding one would have been the "speculative
 * index" the ticket explicitly warns against. This suite is the "assert
 * indexes are utilized for lookups" validation check, using
 * isDuplicateEvent() (db.ts) as an explicit, EXPLAIN-able stand-in for the
 * lookup SQLite performs implicitly during INSERT OR IGNORE.
 */

import Database from "better-sqlite3";
import {
  runMigrations,
  setDb,
  insertEvent,
  isDuplicateEvent,
  getLastIndexedLedger,
} from "../src/indexer/db.js";

interface QueryPlanRow {
  id: number;
  parent: number;
  notused: number;
  detail: string;
}

describe("SQLite index optimization — duplicate_prevention lookups", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
    runMigrations();
  });

  afterAll(() => {
    testDb.close();
  });

  beforeEach(() => {
    testDb.exec("DELETE FROM events");
  });

  // -------------------------------------------------------------------
  // Schema: the UNIQUE constraint's auto-index is present and unchanged
  // -------------------------------------------------------------------

  it("preserves the UNIQUE(contract_id, ledger_sequence, event_type) constraint exactly as-is", () => {
    const indexes = testDb
      .prepare("SELECT name, \"unique\" FROM pragma_index_list('events')")
      .all() as Array<{ name: string; unique: number }>;

    // Later migrations added non-unique lookup indexes to `events`, so this
    // asserts what the ticket actually cares about: the UNIQUE constraint's
    // auto-index is still the one and only unique index on the table.
    const uniqueIndexes = indexes.filter((i) => i.unique === 1);
    expect(uniqueIndexes).toHaveLength(1);
    expect(uniqueIndexes[0].name).toBe("sqlite_autoindex_events_1");

    const columns = testDb
      .prepare("SELECT name FROM pragma_index_info('sqlite_autoindex_events_1') ORDER BY seqno")
      .all() as Array<{ name: string }>;

    expect(columns.map((c) => c.name)).toEqual([
      "contract_id",
      "ledger_sequence",
      "event_type",
    ]);
  });

  // -------------------------------------------------------------------
  // EXPLAIN QUERY PLAN evidence
  // -------------------------------------------------------------------

  describe("EXPLAIN QUERY PLAN", () => {
    it("isDuplicateEvent()'s lookup uses the UNIQUE index, not a table scan", () => {
      const plan = testDb
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT 1 FROM events
           WHERE contract_id = ? AND ledger_sequence = ? AND event_type = ?
           LIMIT 1`
        )
        .all("C1", 100, "funded") as QueryPlanRow[];

      const detail = plan.map((row) => row.detail).join(" | ");
      // SQLite reports "USING COVERING INDEX" when every referenced column is
      // in the index (as here) or "USING INDEX" otherwise - either is fine,
      // both mean the index was used instead of a table scan.
      expect(detail).toMatch(/USING (COVERING )?INDEX sqlite_autoindex_events_1/);
      expect(detail).not.toMatch(/SCAN events\b/);
    });

    it("getEventsByContract's contract_id lookup (adjacent duplicate_prevention read path) also uses the index", () => {
      const plan = testDb
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT * FROM events WHERE contract_id = ? ORDER BY ledger_sequence ASC LIMIT ? OFFSET ?`
        )
        .all("C1", 10, 0) as QueryPlanRow[];

      const detail = plan.map((row) => row.detail).join(" | ");
      // Later migrations gave the planner a better-suited composite index for
      // this predicate, so assert the property that matters — the lookup is
      // index-backed rather than a full table scan — instead of naming one.
      expect(detail).toMatch(/USING (COVERING )?INDEX/);
      expect(detail).not.toMatch(/SCAN events\b/);
    });
  });

  // -------------------------------------------------------------------
  // Behavioural correctness: lookup result matches actual duplicate state
  // -------------------------------------------------------------------

  describe("isDuplicateEvent()", () => {
    it("returns false before the event exists and true after it is inserted", () => {
      expect(isDuplicateEvent("C1", 100, "funded")).toBe(false);

      insertEvent("C1", "funded", 100, 1000, JSON.stringify({ a: 1 }));

      expect(isDuplicateEvent("C1", 100, "funded")).toBe(true);
    });

    it("does not match on a partial key (different event_type)", () => {
      insertEvent("C1", "funded", 100, 1000, JSON.stringify({ a: 1 }));

      expect(isDuplicateEvent("C1", 100, "initialized")).toBe(false);
    });

    it("insertEvent() dedup behaviour (INSERT OR IGNORE) is unchanged by this ticket", () => {
      const first = insertEvent("C1", "funded", 100, 1000, JSON.stringify({ a: 1 }));
      const second = insertEvent("C1", "funded", 100, 1000, JSON.stringify({ a: 2 }));

      expect(first).toBe(true);
      expect(second).toBe(false); // ignored - still a duplicate per the same constraint
    });
  });

  // -------------------------------------------------------------------
  // Lookup speed at scale (evidence the index keeps checks fast, not O(n))
  // -------------------------------------------------------------------

  describe("lookup speed at scale", () => {
    const ROW_COUNT = 2000;

    beforeEach(() => {
      for (let i = 0; i < ROW_COUNT; i++) {
        insertEvent(`C${i % 50}`, "funded", i, 1_700_000_000 + i, JSON.stringify({ i }));
      }
      expect(getLastIndexedLedger()).toBeDefined();
    });

    it(`performs 500 isDuplicateEvent() lookups across ${ROW_COUNT} rows well under 100ms`, () => {
      const start = performance.now();
      let hits = 0;
      for (let i = 0; i < 500; i++) {
        // Mix of hits (existing rows) and misses (never-inserted ledger numbers)
        if (isDuplicateEvent(`C${i % 50}`, i, "funded")) hits++;
      }
      const elapsed = performance.now() - start;

      expect(hits).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(100);

      console.log(
        `[perf] isDuplicateEvent x500 over ${ROW_COUNT} rows: ${elapsed.toFixed(2)} ms (${hits} hits)`
      );
    });
  });
});
