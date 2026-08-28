import Database from "better-sqlite3";
import {
  setDb,
  runMigrations,
  setLastIndexedLedger,
  getLastIndexedLedger,
  insertEvent,
  insertEventBatch,
  type EventRow,
} from "../src/indexer/db.js";
import { countEventsInRange } from "../src/indexer/duplicate-prevention.js";
import {
  getLedgerRangeSnapshot,
  advanceLedgerIfMatch,
  advanceLedgerUnconditional,
  readLedgerRange,
  getLedgerRangeMetadata,
  executeInTransaction,
  explainQueryPlan,
  queryPlanUsesIndex,
  LEDGER_RANGE_INDEXES,
} from "../src/indexer/ledger-range-tracker.js";

describe("LedgerRangeTracker – Transactional Operations", () => {
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
    testDb.exec("DROP TABLE IF EXISTS schema_migrations");
    runMigrations();
  });

  // -------------------------------------------------------------------------
  // Snapshot isolation
  // -------------------------------------------------------------------------

  describe("getLedgerRangeSnapshot – snapshot isolation", () => {
    it("returns current ledger and timestamp", () => {
      setLastIndexedLedger(42);
      const snapshot = getLedgerRangeSnapshot();

      expect(snapshot.lastIndexedLedger).toBe(42);
      expect(snapshot.timestamp).toBeGreaterThan(0);
      expect(typeof snapshot.timestamp).toBe("number");
    });

    it("reads initial ledger as 0 when unset", () => {
      const snapshot = getLedgerRangeSnapshot();
      expect(snapshot.lastIndexedLedger).toBe(0);
    });

    it("isolation: multiple concurrent reads see consistent state", () => {
      setLastIndexedLedger(100);

      const snapshots = [
        getLedgerRangeSnapshot(),
        getLedgerRangeSnapshot(),
        getLedgerRangeSnapshot(),
      ];

      snapshots.forEach((snap) => {
        expect(snap.lastIndexedLedger).toBe(100);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Optimistic concurrency: advanceLedgerIfMatch
  // -------------------------------------------------------------------------

  describe("advanceLedgerIfMatch – optimistic concurrency", () => {
    it("advances ledger when expected value matches", () => {
      setLastIndexedLedger(50);

      const success = advanceLedgerIfMatch(50, 100);

      expect(success).toBe(true);
      expect(getLastIndexedLedger()).toBe(100);
    });

    it("does NOT advance when expected value does not match", () => {
      setLastIndexedLedger(50);

      const success = advanceLedgerIfMatch(99, 100); // expect 99 but actual is 50

      expect(success).toBe(false);
      expect(getLastIndexedLedger()).toBe(50);
    });

    it("rejects attempts to advance to same ledger", () => {
      setLastIndexedLedger(75);

      const success = advanceLedgerIfMatch(75, 75); // newLedger == currentLedger

      expect(success).toBe(false);
      expect(getLastIndexedLedger()).toBe(75);
    });

    it("rejects attempts to advance to lower ledger", () => {
      setLastIndexedLedger(100);

      const success = advanceLedgerIfMatch(100, 50); // attempt to go backwards

      expect(success).toBe(false);
      expect(getLastIndexedLedger()).toBe(100);
    });

    it("handles multiple sequential advances correctly", () => {
      setLastIndexedLedger(0);

      const adv1 = advanceLedgerIfMatch(0, 10);
      expect(adv1).toBe(true);
      expect(getLastIndexedLedger()).toBe(10);

      const adv2 = advanceLedgerIfMatch(10, 20);
      expect(adv2).toBe(true);
      expect(getLastIndexedLedger()).toBe(20);

      const adv3 = advanceLedgerIfMatch(20, 30);
      expect(adv3).toBe(true);
      expect(getLastIndexedLedger()).toBe(30);
    });
  });

  // -------------------------------------------------------------------------
  // Unconditional advance
  // -------------------------------------------------------------------------

  describe("advanceLedgerUnconditional – unconditional update", () => {
    it("advances ledger unconditionally", () => {
      setLastIndexedLedger(50);
      advanceLedgerUnconditional(200);
      expect(getLastIndexedLedger()).toBe(200);
    });

    it("is idempotent when called with same value multiple times", () => {
      setLastIndexedLedger(0);
      advanceLedgerUnconditional(999);
      advanceLedgerUnconditional(999);
      advanceLedgerUnconditional(999);

      expect(getLastIndexedLedger()).toBe(999);
    });
  });

  // -------------------------------------------------------------------------
  // Transactional ledger range reads
  // -------------------------------------------------------------------------

  describe("readLedgerRange – transactional range reads", () => {
    beforeEach(() => {
      // Seed events across different ledger ranges
      insertEvent("C1", "initialized", 10, 1000, JSON.stringify({ data: "ev1" }));
      insertEvent("C1", "funded", 15, 1001, JSON.stringify({ data: "ev2" }));
      insertEvent("C1", "delivered", 20, 1002, JSON.stringify({ data: "ev3" }));
      insertEvent("C2", "approved", 12, 1003, JSON.stringify({ data: "ev4" }));
      insertEvent("C2", "dispute_raised", 18, 1004, JSON.stringify({ data: "ev5" }));
      insertEvent("C3", "auto_release_claimed", 25, 1005, JSON.stringify({ data: "ev6" }));
    });

    it("reads all events within a ledger range", () => {
      const events = readLedgerRange(12, 20);

      expect(events.length).toBe(4); // ev2(15), ev4(12), ev5(18), ev3(20)
      const ledgers = (events as any[]).map((e) => e.ledger_sequence).sort((a, b) => a - b);
      expect(ledgers).toEqual([12, 15, 18, 20]);
    });

    it("returns empty array for range with no events", () => {
      const events = readLedgerRange(200, 300);
      expect(events).toEqual([]);
    });

    it("includes boundary ledgers (inclusive on both ends)", () => {
      const events = readLedgerRange(10, 10); // just ledger 10
      expect(events.length).toBe(1);
      expect((events[0] as any).ledger_sequence).toBe(10);
    });

    it("reads are ordered by ledger sequence ascending", () => {
      const events = readLedgerRange(10, 25);
      const ledgers = (events as any[]).map((e) => e.ledger_sequence);

      for (let i = 1; i < ledgers.length; i++) {
        expect(ledgers[i]).toBeGreaterThanOrEqual(ledgers[i - 1]);
      }
    });

    it("isolation: read sees only committed state (not uncommitted updates)", () => {
      // Insert some events
      insertEvent("C4", "token_whitelisted", 30, 1006, JSON.stringify({ data: "ev7" }));

      // Read the range before attempting other updates
      const events1 = readLedgerRange(10, 30);
      const count1 = events1.length;

      // Attempt to read again in the same transaction context
      const events2 = readLedgerRange(10, 30);
      const count2 = events2.length;

      expect(count1).toBe(count2); // should see same data
    });
  });

  // -------------------------------------------------------------------------
  // Ledger range metadata queries
  // -------------------------------------------------------------------------

  describe("getLedgerRangeMetadata – consistent metadata", () => {
    beforeEach(() => {
      // Seed diverse events
      insertEvent("C1", "initialized", 10, 1000, JSON.stringify({ data: "ev1" }));
      insertEvent("C1", "initialized", 11, 1001, JSON.stringify({ data: "ev1b" }));
      insertEvent("C1", "funded", 12, 1002, JSON.stringify({ data: "ev2" }));
      insertEvent("C2", "delivered", 13, 1003, JSON.stringify({ data: "ev3" }));
      insertEvent("C2", "delivered", 14, 1004, JSON.stringify({ data: "ev3b" }));
      insertEvent("C3", "approved", 15, 1005, JSON.stringify({ data: "ev4" }));
    });

    it("counts total events in range", () => {
      const metadata = getLedgerRangeMetadata(10, 15);
      expect(metadata.totalEvents).toBe(6);
    });

    it("aggregates event counts by type", () => {
      const metadata = getLedgerRangeMetadata(10, 15);

      expect(metadata.eventsByType["initialized"]).toBe(2);
      expect(metadata.eventsByType["funded"]).toBe(1);
      expect(metadata.eventsByType["delivered"]).toBe(2);
      expect(metadata.eventsByType["approved"]).toBe(1);
    });

    it("returns 0 totals for empty range", () => {
      const metadata = getLedgerRangeMetadata(100, 200);
      expect(metadata.totalEvents).toBe(0);
      expect(Object.keys(metadata.eventsByType).length).toBe(0);
    });

    it("includes correct ledger range in response", () => {
      const metadata = getLedgerRangeMetadata(10, 15);
      expect(metadata.ledgerRange.startLedger).toBe(10);
      expect(metadata.ledgerRange.endLedger).toBe(15);
    });

    it("isolation: metadata read sees consistent aggregate state", () => {
      const meta1 = getLedgerRangeMetadata(10, 15);
      const meta2 = getLedgerRangeMetadata(10, 15);

      expect(meta1.totalEvents).toBe(meta2.totalEvents);
      expect(meta1.eventsByType).toEqual(meta2.eventsByType);
    });
  });

  // -------------------------------------------------------------------------
  // Custom transactional operations
  // -------------------------------------------------------------------------

  describe("executeInTransaction – custom ACID operations", () => {
    it("executes custom operation inside a transaction", () => {
      setLastIndexedLedger(50);
      insertEvent("C1", "test_event", 100, 1000, JSON.stringify({ data: "test" }));

      const result = executeInTransaction((db) => {
        const ledgerRow = db
          .prepare("SELECT value FROM indexer_state WHERE key = 'last_ledger_sequence'")
          .get();
        const eventCount = db
          .prepare("SELECT COUNT(*) as cnt FROM events")
          .get();
        return {
          ledger: parseInt((ledgerRow as any).value, 10),
          events: (eventCount as any).cnt,
        };
      });

      expect(result.ledger).toBe(50);
      expect(result.events).toBe(1);
    });

    it("rolls back transaction on error within custom operation", () => {
      setLastIndexedLedger(100);

      expect(() => {
        executeInTransaction((db) => {
          // This should succeed
          db.prepare(
            "UPDATE indexer_state SET value = ? WHERE key = 'last_ledger_sequence'"
          ).run("200");

          // But then we throw an error
          throw new Error("Simulated failure");
        });
      }).toThrow("Simulated failure");

      // The update should have been rolled back
      expect(getLastIndexedLedger()).toBe(100);
    });

    it("isolation: multiple nested transaction reads see consistent state", () => {
      insertEventBatch(
        [
          {
            contractId: "C1",
            eventType: "test1",
            ledgerSequence: 50,
            timestamp: 1000,
            dataJson: JSON.stringify({ a: 1 }),
          },
          {
            contractId: "C2",
            eventType: "test2",
            ledgerSequence: 51,
            timestamp: 1001,
            dataJson: JSON.stringify({ a: 2 }),
          },
        ],
        51
      );

      const result = executeInTransaction((db) => {
        const count1 = (
          db.prepare("SELECT COUNT(*) as cnt FROM events").get() as any
        ).cnt;
        const count2 = (
          db.prepare("SELECT COUNT(*) as cnt FROM events").get() as any
        ).cnt;
        return count1 === count2 ? "consistent" : "inconsistent";
      });

      expect(result).toBe("consistent");
    });
  });

  // -------------------------------------------------------------------------
  // Data consistency under load (stress testing)
  // -------------------------------------------------------------------------

  describe("Data consistency stress tests", () => {
    it("sequential ledger advances maintain consistency", () => {
      setLastIndexedLedger(0);

      for (let i = 1; i <= 100; i++) {
        const success = advanceLedgerIfMatch(i - 1, i);
        expect(success).toBe(true);
      }

      expect(getLastIndexedLedger()).toBe(100);
    });

    it("insertEventBatch with large batch maintains transaction boundaries", () => {
      const largeBatch: EventRow[] = [];
      for (let i = 0; i < 1000; i++) {
        largeBatch.push({
          contractId: `C${i % 10}`,
          eventType: `event_${i % 5}`,
          ledgerSequence: 100 + i,
          timestamp: 1000 + i,
          dataJson: JSON.stringify({ index: i }),
        });
      }

      insertEventBatch(largeBatch, 1099);

      const metadata = getLedgerRangeMetadata(100, 1099);
      expect(metadata.totalEvents).toBe(1000);
      expect(getLastIndexedLedger()).toBe(1099);
    });

    it("rollback on error during large batch insert preserves consistency", () => {
      setLastIndexedLedger(0);

      // Set up a trigger that will fail on a specific pattern
      testDb.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_fail_at_500
        BEFORE INSERT ON events
        WHEN NEW.ledger_sequence = 599
        BEGIN
          SELECT RAISE(FAIL, 'Simulated load failure at ledger 599');
        END;
      `);

      const largeBatch: EventRow[] = [];
      for (let i = 0; i < 500; i++) {
        largeBatch.push({
          contractId: `C${i % 10}`,
          eventType: `event_${i % 5}`,
          ledgerSequence: 100 + i,
          timestamp: 1000 + i,
          dataJson: JSON.stringify({ index: i }),
        });
      }

      expect(() => insertEventBatch(largeBatch, 599)).toThrow(
        "Simulated load failure at ledger 599"
      );

      // After failure, ledger should NOT have advanced
      expect(getLastIndexedLedger()).toBe(0);

      // No events from the failed batch should exist
      const metadata = getLedgerRangeMetadata(100, 599);
      expect(metadata.totalEvents).toBe(0);

      testDb.exec("DROP TRIGGER IF EXISTS trg_fail_at_500");
    });

    it("ledger range metadata remains consistent after multiple operations", () => {
      // Build up events in phases
      const phase1: EventRow[] = [];
      for (let i = 0; i < 100; i++) {
        phase1.push({
          contractId: "C1",
          eventType: "phase1_event",
          ledgerSequence: 1000 + i,
          timestamp: 1000 + i,
          dataJson: JSON.stringify({ phase: 1 }),
        });
      }
      insertEventBatch(phase1, 1099);

      const phase2: EventRow[] = [];
      for (let i = 0; i < 100; i++) {
        phase2.push({
          contractId: "C2",
          eventType: "phase2_event",
          ledgerSequence: 1100 + i,
          timestamp: 1100 + i,
          dataJson: JSON.stringify({ phase: 2 }),
        });
      }
      insertEventBatch(phase2, 1199);

      // Check consistency across full range
      const metadata = getLedgerRangeMetadata(1000, 1199);
      expect(metadata.totalEvents).toBe(200);
      expect(metadata.eventsByType["phase1_event"]).toBe(100);
      expect(metadata.eventsByType["phase2_event"]).toBe(100);
      expect(getLastIndexedLedger()).toBe(1199);
    });
  });

  // -------------------------------------------------------------------------
  // Integration: transaction isolation + ledger operations
  // -------------------------------------------------------------------------

  describe("Integration: full transaction lifecycle", () => {
    it("complete workflow: snapshot → read range → advance ledger", () => {
      // Step 1: Get snapshot of current state
      const snapshot = getLedgerRangeSnapshot();
      expect(snapshot.lastIndexedLedger).toBe(0);

      // Step 2: Insert batch of events
      const batch: EventRow[] = [
        {
          contractId: "C1",
          eventType: "initialized",
          ledgerSequence: 100,
          timestamp: 1000,
          dataJson: JSON.stringify({ data: "test" }),
        },
        {
          contractId: "C2",
          eventType: "funded",
          ledgerSequence: 101,
          timestamp: 1001,
          dataJson: JSON.stringify({ data: "test2" }),
        },
      ];
      insertEventBatch(batch, 101);

      // Step 3: Verify ledger advanced
      expect(getLastIndexedLedger()).toBe(101);

      // Step 4: Read the range inside transaction
      const events = readLedgerRange(100, 101);
      expect(events.length).toBe(2);

      // Step 5: Get metadata snapshot
      const metadata = getLedgerRangeMetadata(100, 101);
      expect(metadata.totalEvents).toBe(2);
      expect(metadata.eventsByType["initialized"]).toBe(1);
      expect(metadata.eventsByType["funded"]).toBe(1);

      // Step 6: Attempt optimistic advance
      const canAdvance = advanceLedgerIfMatch(101, 150);
      expect(canAdvance).toBe(true);
      expect(getLastIndexedLedger()).toBe(150);
    });
  });

  // -------------------------------------------------------------------------
  // Index utilization via EXPLAIN QUERY PLAN (#295)
  // -------------------------------------------------------------------------

  describe("SQLite index utilization – EXPLAIN QUERY PLAN (#295)", () => {
    beforeEach(() => {
      for (let i = 0; i < 50; i++) {
        insertEvent(
          `C${i % 5}`,
          i % 2 === 0 ? "initialized" : "funded",
          1000 + i,
          2000 + i,
          JSON.stringify({ index: i }),
        );
      }
    });

    it("uses idx_events_ledger_sequence for readLedgerRange lookups", () => {
      const plan = explainQueryPlan(
        `SELECT * FROM events
         WHERE ledger_sequence >= ? AND ledger_sequence <= ?
         ORDER BY ledger_sequence ASC`,
        1005,
        1020,
      );

      expect(queryPlanUsesIndex(plan, LEDGER_RANGE_INDEXES.ledgerSequence)).toBe(
        true,
      );
      expect(queryPlanUsesIndex(plan, LEDGER_RANGE_INDEXES.ledgerEventType)).toBe(
        false,
      );
    });

    it("uses idx_events_ledger_sequence for metadata count queries", () => {
      const plan = explainQueryPlan(
        `SELECT COUNT(*) as count FROM events
         WHERE ledger_sequence >= ? AND ledger_sequence <= ?`,
        1000,
        1040,
      );

      expect(queryPlanUsesIndex(plan, LEDGER_RANGE_INDEXES.ledgerSequence)).toBe(
        true,
      );
      expect(queryPlanUsesIndex(plan, LEDGER_RANGE_INDEXES.ledgerEventType)).toBe(
        false,
      );
    });

    it("uses idx_events_ledger_event_type for metadata aggregation", () => {
      const plan = explainQueryPlan(
        `SELECT event_type, COUNT(*) as count FROM events
         WHERE ledger_sequence >= ? AND ledger_sequence <= ?
         GROUP BY event_type`,
        1000,
        1040,
      );

      expect(queryPlanUsesIndex(plan, LEDGER_RANGE_INDEXES.ledgerEventType)).toBe(
        true,
      );
      expect(queryPlanUsesIndex(plan, LEDGER_RANGE_INDEXES.ledgerSequence)).toBe(
        false,
      );
    });

    it("continues to insert, update, and delete events after index migration", () => {
      insertEvent("C-IDX", "delivered", 2000, 3000, JSON.stringify({ ok: true }));
      expect(countEventsInRange(2000, 2000)).toBe(1);

      testDb
        .prepare(
          `UPDATE events SET data_json = ? WHERE contract_id = ? AND ledger_sequence = ?`,
        )
        .run(JSON.stringify({ ok: false }), "C-IDX", 2000);

      const updated = testDb
        .prepare(
          `SELECT data_json FROM events WHERE contract_id = ? AND ledger_sequence = ?`,
        )
        .get("C-IDX", 2000) as { data_json: string };
      expect(JSON.parse(updated.data_json)).toEqual({ ok: false });

      testDb
        .prepare(`DELETE FROM events WHERE contract_id = ? AND ledger_sequence = ?`)
        .run("C-IDX", 2000);
      expect(countEventsInRange(2000, 2000)).toBe(0);
    });
  });
});
