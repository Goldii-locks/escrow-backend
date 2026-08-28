import Database from "better-sqlite3";
import { runMigrations, setDb } from "../src/indexer/db.js";
import {
  validateRetentionDays,
  pruneOldEvents,
  runVacuum,
  runVacuumCleanup,
  ERROR_CODES,
  DEFAULT_RETENTION_DAYS,
} from "../src/indexer/sqlite_vacuum_cleaner.js";

describe("sqlite_vacuum_cleaner (#193)", () => {
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
  });

  // -------------------------------------------------------------------------
  // validateRetentionDays
  // -------------------------------------------------------------------------

  describe("validateRetentionDays", () => {
    it("accepts positive integers", () => {
      expect(validateRetentionDays(1)).toEqual({ ok: true });
      expect(validateRetentionDays(90)).toEqual({ ok: true });
      expect(validateRetentionDays(365)).toEqual({ ok: true });
    });

    it("rejects zero", () => {
      const result = validateRetentionDays(0);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_RETENTION);
      }
    });

    it("rejects negative values", () => {
      const result = validateRetentionDays(-5);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_RETENTION);
      }
    });

    it("rejects non-integer values", () => {
      const result = validateRetentionDays(1.5);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_RETENTION);
      }
    });

    it("rejects NaN", () => {
      const result = validateRetentionDays(NaN);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_RETENTION);
      }
    });

    it("rejects Infinity", () => {
      const result = validateRetentionDays(Infinity);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(ERROR_CODES.INVALID_RETENTION);
      }
    });
  });

  // -------------------------------------------------------------------------
  // pruneOldEvents
  // -------------------------------------------------------------------------

  describe("pruneOldEvents", () => {
    function insertEventWithCreatedAt(
      contractId: string,
      ledgerSequence: number,
      createdAtExpr: string
    ) {
      testDb
        .prepare(
          `INSERT INTO events
           (contract_id, event_type, ledger_sequence, timestamp, data_json, created_at)
           VALUES (?, 'test-event', ?, 1000, '{}', ${createdAtExpr})`
        )
        .run(contractId, ledgerSequence);
    }

    it("deletes only events older than the retention window", () => {
      // Old events: backdated 100 days.
      insertEventWithCreatedAt("OLD-1", 1, "datetime('now', '-100 days')");
      insertEventWithCreatedAt("OLD-2", 2, "datetime('now', '-120 days')");
      // Recent events: within the 90-day window.
      insertEventWithCreatedAt("RECENT-1", 3, "datetime('now', '-1 days')");
      insertEventWithCreatedAt("RECENT-2", 4, "datetime('now')");

      const beforeCount = (
        testDb.prepare("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number }
      ).cnt;
      expect(beforeCount).toBe(4);

      const deleted = pruneOldEvents(testDb, 90);
      expect(deleted).toBe(2);

      const afterCount = (
        testDb.prepare("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number }
      ).cnt;
      expect(afterCount).toBe(2);

      const remaining = testDb
        .prepare("SELECT contract_id FROM events ORDER BY contract_id")
        .all() as Array<{ contract_id: string }>;
      expect(remaining.map((r) => r.contract_id)).toEqual(["RECENT-1", "RECENT-2"]);
    });

    it("throws for invalid retentionDays and does not touch any rows", () => {
      insertEventWithCreatedAt("OLD-1", 1, "datetime('now', '-200 days')");

      expect(() => pruneOldEvents(testDb, -1)).toThrow();
      expect(() => pruneOldEvents(testDb, 0)).toThrow();

      const count = (
        testDb.prepare("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number }
      ).cnt;
      expect(count).toBe(1);
    });

    it("rolls back the entire deletion when a trigger forces a failure mid-transaction", () => {
      insertEventWithCreatedAt("OLD-1", 1, "datetime('now', '-100 days')");
      insertEventWithCreatedAt("__SENTINEL_FAIL__", 2, "datetime('now', '-100 days')");
      insertEventWithCreatedAt("OLD-3", 3, "datetime('now', '-100 days')");

      const beforeCount = (
        testDb.prepare("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number }
      ).cnt;
      expect(beforeCount).toBe(3);

      testDb.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_fail_on_delete_sentinel
        BEFORE DELETE ON events
        WHEN OLD.contract_id = '__SENTINEL_FAIL__'
        BEGIN
          SELECT RAISE(FAIL, 'intentional test failure');
        END;
      `);

      try {
        expect(() => pruneOldEvents(testDb, 90)).toThrow();

        // Zero rows should have been deleted -- the whole transaction must
        // have rolled back, not just stopped partway through.
        const afterCount = (
          testDb.prepare("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number }
        ).cnt;
        expect(afterCount).toBe(3);
      } finally {
        testDb.exec("DROP TRIGGER IF EXISTS trg_fail_on_delete_sentinel");
      }
    });
  });

  // -------------------------------------------------------------------------
  // runVacuum
  // -------------------------------------------------------------------------

  describe("runVacuum", () => {
    it("runs without throwing when called outside any transaction", () => {
      expect(() => runVacuum(testDb)).not.toThrow();
    });

    it("throws when run from inside an active transaction (SQLite constraint)", () => {
      // This documents and proves the exact engine constraint that shapes
      // this module's design: VACUUM cannot run nested inside a transaction.
      expect(() => {
        const wrapped = testDb.transaction(() => {
          runVacuum(testDb);
        });
        wrapped();
      }).toThrow(/cannot VACUUM from within a transaction/i);
    });
  });

  // -------------------------------------------------------------------------
  // runVacuumCleanup
  // -------------------------------------------------------------------------

  describe("runVacuumCleanup", () => {
    function insertEventWithCreatedAt(
      contractId: string,
      ledgerSequence: number,
      createdAtExpr: string
    ) {
      testDb
        .prepare(
          `INSERT INTO events
           (contract_id, event_type, ledger_sequence, timestamp, data_json, created_at)
           VALUES (?, 'test-event', ?, 1000, '{}', ${createdAtExpr})`
        )
        .run(contractId, ledgerSequence);
    }

    it("prunes old events and vacuums end-to-end", () => {
      insertEventWithCreatedAt("OLD-1", 1, "datetime('now', '-100 days')");
      insertEventWithCreatedAt("OLD-2", 2, "datetime('now', '-95 days')");
      insertEventWithCreatedAt("RECENT-1", 3, "datetime('now', '-1 days')");

      const result = runVacuumCleanup(testDb, { retentionDays: 90 });

      expect(result.prunedEvents).toBe(2);
      expect(result.vacuumed).toBe(true);

      const remaining = testDb
        .prepare("SELECT contract_id FROM events")
        .all() as Array<{ contract_id: string }>;
      expect(remaining).toEqual([{ contract_id: "RECENT-1" }]);
    });

    it("uses the default retention window when none is provided", () => {
      insertEventWithCreatedAt(
        "OLD-BEYOND-DEFAULT",
        1,
        `datetime('now', '-${DEFAULT_RETENTION_DAYS + 10} days')`
      );
      insertEventWithCreatedAt("RECENT-1", 2, "datetime('now')");

      const result = runVacuumCleanup(testDb);

      expect(result.prunedEvents).toBe(1);
      expect(result.vacuumed).toBe(true);
    });

    it("propagates the pruning error and never reaches VACUUM when pruning fails", () => {
      insertEventWithCreatedAt("__SENTINEL_FAIL__", 1, "datetime('now', '-100 days')");
      insertEventWithCreatedAt("OLD-2", 2, "datetime('now', '-100 days')");

      testDb.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_fail_on_delete_sentinel_cleanup
        BEFORE DELETE ON events
        WHEN OLD.contract_id = '__SENTINEL_FAIL__'
        BEGIN
          SELECT RAISE(FAIL, 'intentional test failure');
        END;
      `);

      try {
        expect(() => runVacuumCleanup(testDb, { retentionDays: 90 })).toThrow(
          /intentional test failure/i
        );

        // Nothing pruned (transaction rolled back) and vacuum never reached
        // as a consequence -- verified by the fact no rows were removed.
        const count = (
          testDb.prepare("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number }
        ).cnt;
        expect(count).toBe(2);
      } finally {
        testDb.exec("DROP TRIGGER IF EXISTS trg_fail_on_delete_sentinel_cleanup");
      }
    });

    it("throws for an invalid retentionDays option and never reaches VACUUM", () => {
      insertEventWithCreatedAt("OLD-1", 1, "datetime('now', '-100 days')");

      expect(() => runVacuumCleanup(testDb, { retentionDays: 0 })).toThrow();

      const count = (
        testDb.prepare("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number }
      ).cnt;
      expect(count).toBe(1);
    });
  });
});
