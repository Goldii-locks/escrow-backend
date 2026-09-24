/**
 * Issue #189 — Database transaction isolation in duplicate_prevention
 *
 * Verifies that insertEventsWithDedup executes atomically:
 *  - On success  → both events rows AND sync_ranges row are committed.
 *  - On failure  → neither events rows NOR sync_ranges row remain.
 *  - No partial state survives a mid-batch failure.
 *  - Repeated / duplicate calls behave correctly.
 *  - Transaction-related errors are handled and surfaced to the caller.
 */

import Database from "better-sqlite3";
import {
  setDb,
  runMigrations,
  getLastIndexedLedger,
} from "../src/indexer/db.js";
import {
  initializeSyncRangesTable,
  insertEventsWithDedup,
  countEventsInRange,
  getSyncedRanges,
  type SyncRange,
} from "../src/indexer/duplicate-prevention.js";

describe("DuplicatePrevention — transaction isolation (#189)", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    testDb.pragma("journal_mode = WAL");
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
    testDb.exec("DROP TABLE IF EXISTS sync_ranges");
    runMigrations();
    initializeSyncRangesTable();
  });

  // -------------------------------------------------------------------------
  // 1. Successful operation commits all changes
  // -------------------------------------------------------------------------

  describe("successful commit", () => {
    it("commits all event rows when the operation succeeds", () => {
      const events = [
        { contractId: "C1", eventType: "initialized", ledgerSequence: 100, timestamp: 1000, dataJson: "{}" },
        { contractId: "C1", eventType: "funded",      ledgerSequence: 101, timestamp: 1001, dataJson: "{}" },
        { contractId: "C2", eventType: "delivered",   ledgerSequence: 102, timestamp: 1002, dataJson: "{}" },
      ];

      insertEventsWithDedup(events, { startLedger: 100, endLedger: 102 });

      expect(countEventsInRange(100, 102)).toBe(3);
    });

    it("commits the sync_ranges metadata row alongside the event rows", () => {
      const events = [
        { contractId: "C1", eventType: "initialized", ledgerSequence: 200, timestamp: 2000, dataJson: "{}" },
      ];

      insertEventsWithDedup(events, { startLedger: 200, endLedger: 250 });

      const ranges = getSyncedRanges();
      expect(ranges).toHaveLength(1);
      expect(ranges[0].startLedger).toBe(200);
      expect(ranges[0].endLedger).toBe(250);
      expect(ranges[0].eventCount).toBe(1);
    });

    it("event rows and sync_ranges row are committed in the same atomic unit", () => {
      const range: SyncRange = { startLedger: 300, endLedger: 350 };
      const events = [
        { contractId: "C1", eventType: "initialized", ledgerSequence: 300, timestamp: 3000, dataJson: "{}" },
        { contractId: "C1", eventType: "funded",      ledgerSequence: 301, timestamp: 3001, dataJson: "{}" },
      ];

      insertEventsWithDedup(events, range);

      // Both should be visible in a single consistent read
      const eventCount = countEventsInRange(300, 350);
      const syncRanges = getSyncedRanges();

      expect(eventCount).toBe(2);
      expect(syncRanges).toHaveLength(1);
      expect(syncRanges[0].startLedger).toBe(300);
    });

    it("returns the correct DuplicateCheckResult on success", () => {
      const events = [
        { contractId: "C1", eventType: "initialized", ledgerSequence: 400, timestamp: 4000, dataJson: "{}" },
        { contractId: "C1", eventType: "funded",      ledgerSequence: 401, timestamp: 4001, dataJson: "{}" },
      ];

      const result = insertEventsWithDedup(events, { startLedger: 400, endLedger: 401 });

      expect(result.totalProcessed).toBe(2);
      expect(result.newEventsInserted).toBe(2);
      expect(result.duplicatesFound).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Failure rolls back all changes
  // -------------------------------------------------------------------------

  describe("rollback on failure", () => {
    it("rolls back ALL event rows when a mid-batch failure occurs", () => {
      // Create a trigger that fails on a specific sentinel contract_id
      testDb.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_fail_dedup_sentinel
        BEFORE INSERT ON events
        WHEN NEW.contract_id = '__DEDUP_FAIL__'
        BEGIN
          SELECT RAISE(FAIL, 'intentional dedup transaction failure');
        END;
      `);

      const events = [
        // These two would succeed...
        { contractId: "C1", eventType: "initialized", ledgerSequence: 500, timestamp: 5000, dataJson: "{}" },
        { contractId: "C1", eventType: "funded",      ledgerSequence: 501, timestamp: 5001, dataJson: "{}" },
        // ...but this one triggers rollback
        { contractId: "__DEDUP_FAIL__", eventType: "delivered", ledgerSequence: 502, timestamp: 5002, dataJson: "{}" },
      ];

      expect(() =>
        insertEventsWithDedup(events, { startLedger: 500, endLedger: 502 })
      ).toThrow("intentional dedup transaction failure");

      // No event rows should exist from the failed batch
      expect(countEventsInRange(500, 502)).toBe(0);

      testDb.exec("DROP TRIGGER IF EXISTS trg_fail_dedup_sentinel");
    });

    it("rolls back sync_ranges metadata row when events fail to insert", () => {
      testDb.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_fail_dedup_meta
        BEFORE INSERT ON events
        WHEN NEW.contract_id = '__META_FAIL__'
        BEGIN
          SELECT RAISE(FAIL, 'force rollback for meta test');
        END;
      `);

      const events = [
        { contractId: "__META_FAIL__", eventType: "initialized", ledgerSequence: 600, timestamp: 6000, dataJson: "{}" },
      ];

      expect(() =>
        insertEventsWithDedup(events, { startLedger: 600, endLedger: 650 })
      ).toThrow();

      // sync_ranges row must NOT have been written
      const ranges = getSyncedRanges();
      const matchingRange = ranges.find(
        (r) => r.startLedger === 600 && r.endLedger === 650
      );
      expect(matchingRange).toBeUndefined();

      testDb.exec("DROP TRIGGER IF EXISTS trg_fail_dedup_meta");
    });

    it("database returns to exact pre-call state after a mid-batch failure", () => {
      // Pre-seed some existing data
      testDb
        .prepare(
          "INSERT INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json) VALUES (?,?,?,?,?)"
        )
        .run("EXISTING", "initialized", 700, 7000, '{"pre":"existing"}');

      const eventsBefore = testDb.prepare("SELECT COUNT(*) as cnt FROM events").get() as any;
      const rangesBefore = testDb.prepare("SELECT COUNT(*) as cnt FROM sync_ranges").get() as any;

      testDb.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_fail_dedup_restore
        BEFORE INSERT ON events
        WHEN NEW.contract_id = '__RESTORE_FAIL__'
        BEGIN
          SELECT RAISE(FAIL, 'restore test failure');
        END;
      `);

      const events = [
        { contractId: "NEW1",           eventType: "funded",      ledgerSequence: 710, timestamp: 7100, dataJson: "{}" },
        { contractId: "__RESTORE_FAIL__", eventType: "delivered", ledgerSequence: 711, timestamp: 7101, dataJson: "{}" },
      ];

      expect(() =>
        insertEventsWithDedup(events, { startLedger: 710, endLedger: 720 })
      ).toThrow();

      const eventsAfter = testDb.prepare("SELECT COUNT(*) as cnt FROM events").get() as any;
      const rangesAfter = testDb.prepare("SELECT COUNT(*) as cnt FROM sync_ranges").get() as any;

      // Row count must be identical to pre-call state
      expect(eventsAfter.cnt).toBe(eventsBefore.cnt);
      expect(rangesAfter.cnt).toBe(rangesBefore.cnt);

      testDb.exec("DROP TRIGGER IF EXISTS trg_fail_dedup_restore");
    });
  });

  // -------------------------------------------------------------------------
  // 3. No partial state after rollback
  // -------------------------------------------------------------------------

  describe("no partial state after rollback", () => {
    it("first events in a batch are not persisted when a later event fails", () => {
      testDb.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_fail_partial
        BEFORE INSERT ON events
        WHEN NEW.ledger_sequence = 804
        BEGIN
          SELECT RAISE(FAIL, 'partial state test failure at ledger 804');
        END;
      `);

      // 5 events: ledgers 800–804; trigger fires on 804
      const events = Array.from({ length: 5 }, (_, i) => ({
        contractId: "C1",
        eventType: "initialized",
        ledgerSequence: 800 + i,
        timestamp: 8000 + i,
        dataJson: "{}",
      }));

      expect(() =>
        insertEventsWithDedup(events, { startLedger: 800, endLedger: 804 })
      ).toThrow();

      // None of the 5 events should be in the DB
      for (let i = 0; i < 5; i++) {
        const row = testDb
          .prepare("SELECT id FROM events WHERE ledger_sequence = ?")
          .get(800 + i);
        expect(row).toBeUndefined();
      }

      testDb.exec("DROP TRIGGER IF EXISTS trg_fail_partial");
    });

    it("a successful call after a rollback writes only the new batch", () => {
      testDb.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_fail_sequence
        BEFORE INSERT ON events
        WHEN NEW.contract_id = '__SEQ_FAIL__'
        BEGIN
          SELECT RAISE(FAIL, 'sequence failure');
        END;
      `);

      // Failed first attempt
      expect(() =>
        insertEventsWithDedup(
          [{ contractId: "__SEQ_FAIL__", eventType: "initialized", ledgerSequence: 900, timestamp: 9000, dataJson: "{}" }],
          { startLedger: 900, endLedger: 900 }
        )
      ).toThrow();

      testDb.exec("DROP TRIGGER IF EXISTS trg_fail_sequence");

      // Successful second attempt with valid data
      insertEventsWithDedup(
        [{ contractId: "VALID", eventType: "initialized", ledgerSequence: 950, timestamp: 9500, dataJson: "{}" }],
        { startLedger: 950, endLedger: 950 }
      );

      expect(countEventsInRange(900, 900)).toBe(0); // failed batch — nothing
      expect(countEventsInRange(950, 950)).toBe(1); // successful batch — committed
    });
  });

  // -------------------------------------------------------------------------
  // 4. Duplicate / repeated events
  // -------------------------------------------------------------------------

  describe("duplicate and repeated event handling", () => {
    it("calling insertEventsWithDedup twice with the same events inserts each row once", () => {
      const events = [
        { contractId: "C1", eventType: "initialized", ledgerSequence: 1000, timestamp: 10000, dataJson: "{}" },
        { contractId: "C1", eventType: "funded",      ledgerSequence: 1001, timestamp: 10001, dataJson: "{}" },
      ];
      const range: SyncRange = { startLedger: 1000, endLedger: 1001 };

      const result1 = insertEventsWithDedup(events, range);
      const result2 = insertEventsWithDedup(events, range);

      // First call inserts both
      expect(result1.newEventsInserted).toBe(2);
      expect(result1.duplicatesFound).toBe(0);

      // Second call sees both as duplicates
      expect(result2.newEventsInserted).toBe(0);
      expect(result2.duplicatesFound).toBe(2);

      // DB has exactly 2 rows
      expect(countEventsInRange(1000, 1001)).toBe(2);
    });

    it("partial duplicate batch (some new, some duplicate) commits only the new events", () => {
      // Pre-insert one event
      testDb
        .prepare(
          "INSERT INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json) VALUES (?,?,?,?,?)"
        )
        .run("C1", "initialized", 1100, 11000, "{}");

      const events = [
        // Duplicate — already exists
        { contractId: "C1", eventType: "initialized", ledgerSequence: 1100, timestamp: 11000, dataJson: "{}" },
        // New
        { contractId: "C1", eventType: "funded", ledgerSequence: 1101, timestamp: 11001, dataJson: "{}" },
      ];

      const result = insertEventsWithDedup(events, { startLedger: 1100, endLedger: 1101 });

      expect(result.newEventsInserted).toBe(1);
      expect(result.duplicatesFound).toBe(1);
      expect(countEventsInRange(1100, 1101)).toBe(2);
    });

    it("empty event array completes successfully and commits a sync_ranges row", () => {
      const result = insertEventsWithDedup([], { startLedger: 1200, endLedger: 1300 });

      expect(result.totalProcessed).toBe(0);
      expect(result.newEventsInserted).toBe(0);
      expect(result.duplicatesFound).toBe(0);

      const ranges = getSyncedRanges();
      expect(ranges.some((r) => r.startLedger === 1200 && r.endLedger === 1300)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Existing behavior preserved
  // -------------------------------------------------------------------------

  describe("existing behavior preserved", () => {
    it("does not affect indexer_state last_ledger_sequence", () => {
      testDb.exec(
        "UPDATE indexer_state SET value = '42' WHERE key = 'last_ledger_sequence'"
      );

      insertEventsWithDedup(
        [{ contractId: "C1", eventType: "initialized", ledgerSequence: 1400, timestamp: 14000, dataJson: "{}" }],
        { startLedger: 1400, endLedger: 1400 }
      );

      // Ledger pointer must not have been touched by dedup logic
      expect(getLastIndexedLedger()).toBe(42);
    });

    it("multiple non-overlapping ranges are all committed independently", () => {
      insertEventsWithDedup(
        [{ contractId: "C1", eventType: "initialized", ledgerSequence: 1500, timestamp: 15000, dataJson: "{}" }],
        { startLedger: 1500, endLedger: 1599 }
      );
      insertEventsWithDedup(
        [{ contractId: "C1", eventType: "funded", ledgerSequence: 1700, timestamp: 17000, dataJson: "{}" }],
        { startLedger: 1700, endLedger: 1799 }
      );

      const ranges = getSyncedRanges();
      expect(ranges.length).toBeGreaterThanOrEqual(2);
      expect(ranges.some((r) => r.startLedger === 1500)).toBe(true);
      expect(ranges.some((r) => r.startLedger === 1700)).toBe(true);
    });
  });
});
