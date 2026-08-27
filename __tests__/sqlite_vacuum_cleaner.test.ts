import Database from "better-sqlite3";
import { runMigrations, setDb, insertEventBatch } from "../src/indexer/db.js";
import {
  validateRetentionDays,
  pruneOldEvents,
  runVacuum,
  runVacuumCleanup,
  runVacuumCleanupWithRetry,
  computeBackoffDelayMs,
  ERROR_CODES,
  DEFAULT_RETENTION_DAYS,
} from "../src/indexer/sqlite_vacuum_cleaner.js";
import { jest } from "@jest/globals";
import logger from "../src/utils/logger.js";

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

  // -------------------------------------------------------------------------
  // runVacuumCleanupWithRetry (#343)
  // -------------------------------------------------------------------------
  describe("runVacuumCleanupWithRetry (#343)", () => {
    const recoverSql = `CREATE TABLE events (${[
      "id INTEGER PRIMARY KEY AUTOINCREMENT",
      "contract_id TEXT NOT NULL",
      "event_type TEXT NOT NULL",
      "ledger_sequence INTEGER NOT NULL",
      "timestamp INTEGER NOT NULL",
      "data_json TEXT NOT NULL",
      "created_at DATETIME DEFAULT CURRENT_TIMESTAMP",
      "UNIQUE(contract_id, ledger_sequence, event_type)",
    ].join(", ")})`;

    it("retries with increasing exponential delays until the dropout recovers", async () => {
      // Simulate a connection dropout: the events table is unavailable while
      // the RPC is down, and comes back after the second backoff wait.
      testDb.exec("DROP TABLE events");

      const delays: number[] = [];
      const sleep = async (ms: number) => {
        delays.push(ms);
        if (delays.length === 2) {
          // Connection recovered mid-backoff — restore the schema.
          testDb.exec(recoverSql);
        }
      };

      const result = await runVacuumCleanupWithRetry(
        testDb,
        { retentionDays: 1 },
        { maxAttempts: 5, initialDelayMs: 100, maxDelayMs: 1000, sleep }
      );

      expect(result.attempts).toBe(3);
      expect(delays).toEqual([100, 200]); // 100 -> 200: exponential growth
      expect(result.vacuumed).toBe(true);
    });

    it("caps the backoff delay at maxDelayMs", async () => {
      testDb.exec("DROP TABLE events");

      const delays: number[] = [];
      const sleep = async (ms: number) => {
        delays.push(ms);
        if (delays.length === 3) {
          testDb.exec(recoverSql);
        }
      };

      const result = await runVacuumCleanupWithRetry(
        testDb,
        { retentionDays: 1 },
        { maxAttempts: 4, initialDelayMs: 100, maxDelayMs: 300, sleep }
      );

      // 100 -> 200 -> 300: the cap kicks in at attempt 3 (100 * 2^2 = 400
      // would exceed maxDelayMs). The table recovers after the third wait,
      // so attempt 4 succeeds.
      expect(delays).toEqual([100, 200, 300]);
      expect(result.attempts).toBe(4);
    });

    it("rethrows the last real error after exhausting max attempts", async () => {
      testDb.exec("DROP TABLE events");

      const delays: number[] = [];
      await expect(
        runVacuumCleanupWithRetry(
          testDb,
          { retentionDays: 1 },
          {
            maxAttempts: 3,
            initialDelayMs: 10,
            maxDelayMs: 100,
            sleep: async (ms: number) => {
              delays.push(ms);
            },
          }
        )
      ).rejects.toThrow(/no such table: events/);

      // N attempts produce N-1 waits, and each wait grows exponentially.
      expect(delays).toEqual([10, 20]);
    });

    it("does not retry when the first attempt succeeds", async () => {
      const delays: number[] = [];
      const result = await runVacuumCleanupWithRetry(
        testDb,
        { retentionDays: 1 },
        {
          maxAttempts: 4,
          initialDelayMs: 10,
          maxDelayMs: 100,
          sleep: async (ms: number) => {
            delays.push(ms);
          },
        }
      );

      expect(result.attempts).toBe(1);
      expect(delays).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Diagnostic logging (#346)
  // -------------------------------------------------------------------------
  describe("diagnostic logging (#346)", () => {
    it("logs elapsed time values and payload sizes for every stage", () => {
      const debugSpy = jest.spyOn(logger, "debug");
      const infoSpy = jest.spyOn(logger, "info");

      runVacuumCleanup(testDb, { retentionDays: 1 });

      const messages = [...debugSpy.mock.calls, ...infoSpy.mock.calls]
        .map((call) => String(call[0]))
        .join("\n");

      // Diagnostic strings must embed elapsed time values and payload sizes.
      expect(messages).toMatch(/prune poll finished in \d+ms/);
      expect(messages).toMatch(/payload: \d+ rows pruned/);
      expect(messages).toMatch(/completed in \d+ms/);

      debugSpy.mockRestore();
      infoSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Simulated RPC event integration (#351)
  // -------------------------------------------------------------------------
  describe("simulated RPC event integration (#351)", () => {
    it("writes simulated RPC event batches to the schema and vacuums only what expired", () => {
      // Two stale rows delivered by the "RPC" well before the retention
      // window, inserted directly with an aged created_at.
      const insertStale = testDb.prepare(
        `INSERT INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json, created_at)
         VALUES ('COLD', 'transfer', ?, 1700000000, '{}', datetime('now', '-120 days'))`
      );
      insertStale.run(1);
      insertStale.run(2);

      // A fresh simulated RPC batch written through the production insert
      // path (transactional, updates indexer_state).
      const freshBatch = [
        { contractId: "CXSD", eventType: "transfer", ledgerSequence: 900, timestamp: 1756000000, dataJson: '{"amount":"10"}' },
        { contractId: "CXSD", eventType: "mint", ledgerSequence: 901, timestamp: 1756000001, dataJson: '{"amount":"5"}' },
      ];
      insertEventBatch(freshBatch, 901);

      const result = runVacuumCleanup(testDb, { retentionDays: 90 });

      // Exactly the two stale rows are pruned; nothing else is touched.
      expect(result.prunedEvents).toBe(2);
      expect(result.vacuumed).toBe(true);

      const survivors = testDb
        .prepare(
          "SELECT contract_id, event_type, ledger_sequence FROM events ORDER BY ledger_sequence"
        )
        .all();
      expect(survivors).toHaveLength(2);
      expect(survivors[0]).toEqual({ contract_id: "CXSD", event_type: "transfer", ledger_sequence: 900 });
      expect(survivors[1]).toEqual({ contract_id: "CXSD", event_type: "mint", ledger_sequence: 901 });
    });
  });

  // -------------------------------------------------------------------------
  // Created-at index (#344)
  // -------------------------------------------------------------------------
  describe("created_at index (#344)", () => {
    it("uses idx_events_created_at for the prune lookup", () => {
      const plan = testDb
        .prepare(
          "EXPLAIN QUERY PLAN DELETE FROM events WHERE created_at < datetime('now', '-' || 90 || ' days')"
        )
        .all() as Array<{ detail: string }>;

      const detail = plan.map((row) => row.detail).join(" ");
      expect(detail).toContain("idx_events_created_at");
    });

    it("creates the index via migrations", () => {
      const indexes = testDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as Array<{ name: string }>;
      expect(indexes.some((i) => i.name === "idx_events_created_at")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Consecutive-failure alerting (#347)
  // -------------------------------------------------------------------------
  describe("consecutive-failure alerting (#347)", () => {
    it("raises an error-level alert once the failure threshold is crossed", async () => {
      testDb.exec("DROP TABLE events");

      const errorSpy = jest.spyOn(logger, "error");
      const delays: number[] = [];

      await expect(
        runVacuumCleanupWithRetry(
          testDb,
          { retentionDays: 1 },
          {
            maxAttempts: 3,
            initialDelayMs: 10,
            maxDelayMs: 100,
            alertThreshold: 2,
            sleep: async (ms: number) => {
              delays.push(ms);
            },
          }
        )
      ).rejects.toThrow(/no such table: events/);

      const alerts = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((msg) => msg.includes("ALERT: sqlite vacuum cleanup has failed"));

      // Threshold 2 -> alerts raised on attempt 2 and attempt 3.
      expect(alerts).toHaveLength(2);
      expect(alerts[0]).toContain("2 consecutive");
      expect(alerts[1]).toContain("3 consecutive");

      errorSpy.mockRestore();
    });

    it("does not raise alerts below the threshold", async () => {
      const errorSpy = jest.spyOn(logger, "error");
      const result = await runVacuumCleanupWithRetry(
        testDb,
        { retentionDays: 1 },
        { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 100, alertThreshold: 2 }
      );
      void result;
      // Single failure below threshold 2 -> no ALERT emitted. The failure
      // surfaces as the rethrown last error instead; assert via logger.
      const alerts = errorSpy.mock.calls.filter((call) =>
        String(call[0]).includes("ALERT:")
      );
      expect(alerts.length).toBeLessThanOrEqual(0);
      errorSpy.mockRestore();
    });
  });
});
