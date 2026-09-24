import { computeBackoffMs, withRetry } from "../src/indexer/rpc-poller-client.js";
import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import {
  setDb,
  runMigrations,
  insertEventBatch,
  registerContract,
  deregisterContract,
  insertEvent,
  addSubscription,
  removeSubscription,
  getActiveContractIds,
  getLastIndexedLedger,
  getSubscriptions,
  type EventRow,
} from "../src/indexer/db.js";
import {
  deleteEventsInRange,
  insertEventsWithDedup,
  initializeSyncRangesTable,
  getSyncedRanges,
  countEventsInRange,
} from "../src/indexer/duplicate-prevention.js";

describe("RpcPollerClient – exponential backoff retry", () => {
  describe("computeBackoffMs", () => {
    const config = {
      initialBackoffMs: 1000,
      backoffMultiplier: 2,
      maxBackoffMs: 30000,
    };

    it("returns initial backoff for attempt 0", () => {
      expect(computeBackoffMs(0, config)).toBe(1000);
    });

    it("doubles backoff on each attempt", () => {
      expect(computeBackoffMs(1, config)).toBe(2000);
      expect(computeBackoffMs(2, config)).toBe(4000);
      expect(computeBackoffMs(3, config)).toBe(8000);
      expect(computeBackoffMs(4, config)).toBe(16000);
    });

    it("caps at maxBackoffMs", () => {
      expect(computeBackoffMs(5, config)).toBe(30000);
      expect(computeBackoffMs(10, config)).toBe(30000);
      expect(computeBackoffMs(100, config)).toBe(30000);
    });

    it("respects custom multiplier", () => {
      const cfg3x = { ...config, backoffMultiplier: 3 };
      expect(computeBackoffMs(0, cfg3x)).toBe(1000);
      expect(computeBackoffMs(1, cfg3x)).toBe(3000);
      expect(computeBackoffMs(2, cfg3x)).toBe(9000);
    });

    it("respects custom initial backoff", () => {
      const cfg500 = { ...config, initialBackoffMs: 500 };
      expect(computeBackoffMs(0, cfg500)).toBe(500);
      expect(computeBackoffMs(1, cfg500)).toBe(1000);
    });
  });

  describe("withRetry", () => {
    it("returns result on first success without retry", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        return "ok";
      };
      const result = await withRetry(fn, { maxRetries: 3 }, "test");
      expect(result).toBe("ok");
      expect(calls).toBe(1);
    });

    it("retries on retryable error and eventually succeeds", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        if (calls === 1) throw new Error("timeout");
        if (calls === 2) throw new Error("ECONNRESET");
        return "recovered";
      };

      const result = await withRetry(
        fn,
        { maxRetries: 3, initialBackoffMs: 10 },
        "test"
      );
      expect(result).toBe("recovered");
      expect(calls).toBe(3);
    });

    it("throws after exhausting retries", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        throw new Error("timeout");
      };

      await expect(
        withRetry(fn, { maxRetries: 2, initialBackoffMs: 10 }, "test")
      ).rejects.toThrow("timeout");
      expect(calls).toBe(3); // initial + 2 retries
    });

    it("does not retry non-retryable errors", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        throw new Error("invalid argument");
      };

      await expect(
        withRetry(fn, { maxRetries: 5, initialBackoffMs: 10 }, "test")
      ).rejects.toThrow("invalid argument");
      expect(calls).toBe(1);
    });

    it("retries on various retryable patterns", async () => {
      const patterns = [
        "ECONNREFUSED",
        "ETIMEDOUT",
        "socket hang up",
        "status 429",
        "status 503",
        "request timeout",
      ];

      for (const pattern of patterns) {
        let calls = 0;
        const fn = async () => {
          calls++;
          if (calls === 1) throw new Error(pattern);
          return "ok";
        };

        const result = await withRetry(
          fn,
          { maxRetries: 1, initialBackoffMs: 10 },
          "test"
        );
        expect(result).toBe("ok");
        expect(calls).toBe(2);
      }
    });

    it("succeeds on retry after mixed failures", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        if (calls === 1) throw new Error("timeout");
        if (calls === 2) throw new Error("ECONNRESET");
        if (calls === 3) throw new Error("network");
        return "final-success";
      };

      const result = await withRetry(
        fn,
        { maxRetries: 5, initialBackoffMs: 10 },
        "test"
      );
      expect(result).toBe("final-success");
      expect(calls).toBe(4);
    });

    it("handles non-Error thrown values as non-retryable", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        throw "string error";
      };

      await expect(
        withRetry(fn, { maxRetries: 3, initialBackoffMs: 10 }, "test")
      ).rejects.toThrow("string error");
      expect(calls).toBe(1);
    });
  });
});

describe("RpcPollerClient – database transaction isolation", () => {
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
    testDb.exec("DROP TABLE IF EXISTS sync_ranges");
    testDb.exec("DROP TABLE IF EXISTS rpc_node_health");
    testDb.exec("DROP TABLE IF EXISTS failover_state");
    testDb.exec("DROP TABLE IF EXISTS node_failure_events");
    runMigrations();
  });

  describe("Successful transaction commits", () => {
    it("insertEventBatch commits events and advances ledger atomically on success", () => {
      const events: EventRow[] = [
        { contractId: "C1", eventType: "initialized", ledgerSequence: 100, timestamp: 1000, dataJson: "{}" },
        { contractId: "C1", eventType: "funded", ledgerSequence: 101, timestamp: 1001, dataJson: "{}" },
      ];

      insertEventBatch(events, 101);

      const rows = testDb.prepare("SELECT COUNT(*) AS cnt FROM events").get() as { cnt: number };
      expect(rows.cnt).toBe(2);
      expect(getLastIndexedLedger()).toBe(101);
    });

    it("registerContract commits successfully", () => {
      registerContract("C1", "test-contract");
      const active = getActiveContractIds();
      expect(active).toContain("C1");
    });

    it("deregisterContract commits successfully", () => {
      registerContract("C1", "test");
      deregisterContract("C1");
      const active = getActiveContractIds();
      expect(active).not.toContain("C1");
    });

    it("insertEvent commits successfully", () => {
      const inserted = insertEvent("C1", "initialized", 100, 1000, "{}");
      expect(inserted).toBe(true);
      const count = testDb.prepare("SELECT COUNT(*) AS cnt FROM events").get() as { cnt: number };
      expect(count.cnt).toBe(1);
    });

    it("addSubscription commits INSERT + SELECT atomically", () => {
      const sub = addSubscription("C1", "https://example.com/hook", ["*"]);
      expect(sub).toBeDefined();
      expect(sub.contract_id).toBe("C1");
      expect(sub.webhook_url).toBe("https://example.com/hook");
      const all = getSubscriptions();
      expect(all.length).toBe(1);
    });

    it("removeSubscription commits successfully", () => {
      addSubscription("C1", "https://example.com/hook", ["*"]);
      const removed = removeSubscription("C1", "https://example.com/hook");
      expect(removed).toBe(true);
      const all = getSubscriptions();
      expect(all.length).toBe(0);
    });

    it("deleteEventsInRange commits events + sync_ranges deletes atomically", () => {
      initializeSyncRangesTable();
      insertEventsWithDedup(
        [
          { contractId: "C1", eventType: "initialized", ledgerSequence: 100, timestamp: 1000, dataJson: "{}" },
          { contractId: "C1", eventType: "funded", ledgerSequence: 101, timestamp: 1001, dataJson: "{}" },
        ],
        { startLedger: 100, endLedger: 200 }
      );
      expect(countEventsInRange(100, 200)).toBe(2);
      expect(getSyncedRanges().length).toBe(1);

      const deleted = deleteEventsInRange(100, 200);

      expect(deleted).toBe(2);
      expect(countEventsInRange(100, 200)).toBe(0);
      expect(getSyncedRanges().length).toBe(0);
    });
  });

  describe("Transaction rollback on failure", () => {
    it("insertEventBatch rolls back BOTH event inserts and ledger update when a mid-operation error occurs", () => {
      const events: EventRow[] = [
        { contractId: "C1", eventType: "initialized", ledgerSequence: 100, timestamp: 1000, dataJson: "{}" },
        { contractId: "C1", eventType: "funded", ledgerSequence: 101, timestamp: 1001, dataJson: "{}" },
      ];

      const originalLedger = getLastIndexedLedger();
      const badEvents: EventRow[] = [
        ...events,
        { contractId: "C1", eventType: "bad-type", ledgerSequence: -1, timestamp: NaN, dataJson: "not-json".padEnd(10000, "x") },
      ];

      const sabotageStmt = testDb.prepare("INSERT INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json) VALUES (?, ?, ?, ?, ?)");
      const txSpy = jest.spyOn(testDb, "transaction").mockImplementationOnce(((fn: any) => {
        const wrappedTx = (...args: any[]) => {
          const wrapped = function (this: any) {
            sabotageStmt.run("C2", "sneaky", 999, 999, "{}");
            const result = fn.apply(this, args);
            throw new Error("simulated mid-transaction failure");
            return result;
          };
          const tx = testDb.transaction(wrapped);
          return tx();
        };
        Object.assign(wrappedTx, {
          default: () => wrappedTx(),
          deferred: () => wrappedTx(),
          immediate: () => wrappedTx(),
          exclusive: () => wrappedTx(),
        });
        return wrappedTx as any;
      }) as any);

      expect(() => insertEventBatch(badEvents, 102)).toThrow("simulated mid-transaction failure");
      txSpy.mockRestore();

      const eventCount = testDb.prepare("SELECT COUNT(*) AS cnt FROM events").get() as { cnt: number };
      expect(eventCount.cnt).toBe(0);
      expect(getLastIndexedLedger()).toBe(originalLedger);
    });

    it("insertEventsWithDedup rolls back events and sync_ranges when an error is thrown mid-way", () => {
      initializeSyncRangesTable();
      const events = [
        { contractId: "C1", eventType: "initialized", ledgerSequence: 100, timestamp: 1000, dataJson: "{}" },
        { contractId: "C1", eventType: "funded", ledgerSequence: 101, timestamp: 1001, dataJson: "{}" },
      ];

      const txSpy = jest.spyOn(testDb, "transaction").mockImplementationOnce(((fn: any) => {
        const wrappedTx = (...args: any[]) => {
          const wrapped = function (this: any) {
            const result = fn.apply(this, args);
            throw new Error("simulated failure after partial work");
            return result;
          };
          const tx = testDb.transaction(wrapped);
          return tx();
        };
        Object.assign(wrappedTx, {
          default: () => wrappedTx(),
          deferred: () => wrappedTx(),
          immediate: () => wrappedTx(),
          exclusive: () => wrappedTx(),
        });
        return wrappedTx as any;
      }) as any);

      expect(() => insertEventsWithDedup(events, { startLedger: 100, endLedger: 101 })).toThrow(
        "simulated failure after partial work"
      );
      txSpy.mockRestore();

      expect(countEventsInRange(100, 101)).toBe(0);
      expect(getSyncedRanges().length).toBe(0);
    });

    it("deleteEventsInRange rolls back both table deletes when an error occurs between them", () => {
      initializeSyncRangesTable();
      insertEventsWithDedup(
        [
          { contractId: "C1", eventType: "initialized", ledgerSequence: 100, timestamp: 1000, dataJson: "{}" },
          { contractId: "C1", eventType: "funded", ledgerSequence: 101, timestamp: 1001, dataJson: "{}" },
        ],
        { startLedger: 100, endLedger: 200 }
      );
      expect(countEventsInRange(100, 200)).toBe(2);
      expect(getSyncedRanges().length).toBe(1);

      const txSpy = jest.spyOn(testDb, "transaction").mockImplementationOnce(((fn: any) => {
        const wrappedTx = (...args: any[]) => {
          const wrapped = function (this: any) {
            const result = fn.apply(this, args);
            throw new Error("simulated failure between deletes");
            return result;
          };
          const tx = testDb.transaction(wrapped);
          return tx();
        };
        Object.assign(wrappedTx, {
          default: () => wrappedTx(),
          deferred: () => wrappedTx(),
          immediate: () => wrappedTx(),
          exclusive: () => wrappedTx(),
        });
        return wrappedTx as any;
      }) as any);

      expect(() => deleteEventsInRange(100, 200)).toThrow("simulated failure between deletes");
      txSpy.mockRestore();

      expect(countEventsInRange(100, 200)).toBe(2);
      expect(getSyncedRanges().length).toBe(1);
    });

    it("addSubscription rolls back INSERT if subsequent SELECT throws (no partial row)", () => {
      const dbPrepareSpy = jest.spyOn(testDb, "prepare").mockImplementation((sql: string) => {
        const stmt = (testDb as any).constructor.prototype.prepare.call(testDb, sql);
        if (sql.includes("SELECT * FROM webhook_subscriptions WHERE contract_id = ? AND webhook_url = ?")) {
          stmt.get = (...params: any[]) => {
            throw new Error("simulated SELECT failure after INSERT");
          };
        }
        return stmt;
      });

      expect(() => addSubscription("C1", "https://rollback.test/hook", ["*"])).toThrow(
        "simulated SELECT failure after INSERT"
      );
      dbPrepareSpy.mockRestore();

      const subs = testDb.prepare("SELECT COUNT(*) AS cnt FROM webhook_subscriptions").get() as { cnt: number };
      expect(subs.cnt).toBe(0);
    });
  });
});
