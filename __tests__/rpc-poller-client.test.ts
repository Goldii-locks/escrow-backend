import {
  computeBackoffMs,
  withRetry,
  parseRetryAfterMs,
  getRetryAfterMs,
  getErrorStatusCode,
  isRetryableError,
  RpcPollerClient,
  mapRpcEventToRow,
  RpcEventQueue,
} from "../src/indexer/rpc-poller-client.js";
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

    it("asserts the backoff sequence never exceeds maxBackoffMs across a full sequence", () => {
      const maxBackoffMs = 5000;
      const testConfig = { initialBackoffMs: 200, backoffMultiplier: 2, maxBackoffMs };
      for (let attempt = 0; attempt < 50; attempt++) {
        const delay = computeBackoffMs(attempt, testConfig);
        expect(delay).toBeLessThanOrEqual(maxBackoffMs);
      }
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

    it("retries 429 and 503 status errors (#688)", async () => {
      for (const status of [429, 503]) {
        let calls = 0;
        const fn = async () => {
          calls++;
          if (calls === 1) {
            const err = new Error(`Request failed with status code ${status}`) as any;
            err.status = status;
            throw err;
          }
          return "recovered";
        };
        const result = await withRetry(
          fn,
          { maxRetries: 3, initialBackoffMs: 1, maxBackoffMs: 5 },
          "test"
        );
        expect(result).toBe("recovered");
        expect(calls).toBe(2);
      }
    });

    it("honours Retry-After without exceeding maxBackoffMs (#688)", () => {
      expect(parseRetryAfterMs("2")).toBe(2000);
      expect(parseRetryAfterMs(0)).toBe(0);
      expect(parseRetryAfterMs("not-a-date")).toBeNull();
      expect(
        getRetryAfterMs({ response: { headers: { "Retry-After": "3" } } })
      ).toBe(3000);
      expect(
        getRetryAfterMs({ response: { headers: { "retry-after": "1" } } })
      ).toBe(1000);
      expect(getErrorStatusCode({ status: 429 })).toBe(429);
      expect(isRetryableError(new Error("Request failed with status code 429"))).toBe(true);
      expect(isRetryableError(new Error("Request failed with status code 503"))).toBe(true);
    });

    it("recovers through RpcPollerClient.getEvents after two 429s (#688)", async () => {
      let calls = 0;
      const server = {
        getLatestLedger: async () => ({ sequence: 1 }),
        getEvents: async () => {
          calls++;
          if (calls <= 2) {
            const err = new Error("Request failed with status code 429") as any;
            err.status = 429;
            err.response = { status: 429, headers: { "Retry-After": "0" } };
            throw err;
          }
          return { events: [], cursor: undefined };
        },
      };
      const client = new RpcPollerClient("http://localhost", {
        server: server as any,
        maxRetries: 5,
        initialBackoffMs: 1,
        maxBackoffMs: 5,
      });
      const result = await client.getEvents({ startLedger: 1, limit: 10 });
      expect(result.events).toEqual([]);
      expect(calls).toBe(3);
    });

    it("resets backoff progression after a success", async () => {
      // First operation fails once then succeeds
      let firstOpCalls = 0;
      await withRetry(
        async () => {
          firstOpCalls++;
          if (firstOpCalls === 1) throw new Error("ETIMEDOUT");
          return "ok1";
        },
        { maxRetries: 3, initialBackoffMs: 10 },
        "test"
      );
      expect(firstOpCalls).toBe(2);

      // Second operation should start fresh from attempt 0
      let secondOpCalls = 0;
      await withRetry(
        async () => {
          secondOpCalls++;
          return "ok2";
        },
        { maxRetries: 3, initialBackoffMs: 10 },
        "test"
      );
      expect(secondOpCalls).toBe(1);
    });
  });

  describe("isRetryableError error classifier (#674)", () => {
    it("returns false for falsy errors", () => {
      expect(isRetryableError(null)).toBe(false);
      expect(isRetryableError(undefined)).toBe(false);
      expect(isRetryableError("")).toBe(false);
    });

    it("classifies network errors (ECONNRESET, ETIMEDOUT, ECONNREFUSED) as retryable", () => {
      expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
      expect(isRetryableError({ code: "ECONNRESET" })).toBe(true);
      expect(isRetryableError(new Error("ETIMEDOUT"))).toBe(true);
      expect(isRetryableError({ code: "ETIMEDOUT" })).toBe(true);
      expect(isRetryableError(new Error("connect ECONNREFUSED 127.0.0.1:8000"))).toBe(true);
      expect(isRetryableError({ code: "ECONNREFUSED" })).toBe(true);
    });

    it("classifies AbortError as retryable", () => {
      const abortErr = new Error("The user aborted a request.");
      abortErr.name = "AbortError";
      expect(isRetryableError(abortErr)).toBe(true);
      expect(isRetryableError({ name: "AbortError" })).toBe(true);
    });

    it("classifies HTTP 429, 500, 502, 503 as retryable", () => {
      expect(isRetryableError(new Error("Request failed with status 429"))).toBe(true);
      expect(isRetryableError({ status: 429 })).toBe(true);
      expect(isRetryableError({ statusCode: 429 })).toBe(true);
      expect(isRetryableError(new Error("Internal Server Error status 500"))).toBe(true);
      expect(isRetryableError({ status: 500 })).toBe(true);
      expect(isRetryableError({ statusCode: 502 })).toBe(true);
      expect(isRetryableError(new Error("Service Unavailable status 503"))).toBe(true);
      expect(isRetryableError({ status: 503 })).toBe(true);
      expect(isRetryableError({ response: { status: 504 } })).toBe(true);
    });

    it("classifies HTTP 400 and other 4xx client errors as NOT retryable", () => {
      expect(isRetryableError(new Error("Request failed with status 400"))).toBe(false);
      expect(isRetryableError({ status: 400 })).toBe(false);
      expect(isRetryableError({ statusCode: 404 })).toBe(false);
      expect(isRetryableError({ status: 422 })).toBe(false);
    });

    it("does NOT retry JSON-RPC -32602 invalid params errors", () => {
      expect(isRetryableError(new Error('JSON-RPC error -32602: "invalid params"'))).toBe(false);
      expect(isRetryableError(new Error('Rpc error: invalid parameters ... illegal base64 data'))).toBe(false);
      expect(isRetryableError({ code: -32602, message: "Invalid params" })).toBe(false);
      expect(isRetryableError({ error: { code: -32602, message: "Invalid params" } })).toBe(false);
    });
  });

  describe("RpcPollerClient branch coverage additions (#674)", () => {
    it("readContractId handles contractId object throwing in contractId() method", () => {
      const badContractObj = {
        contractId: () => {
          throw new Error("fail");
        },
      };
      const row = mapRpcEventToRow({ contractId: badContractObj, ledger: 10 });
      expect(row.contractId).toBe("");
    });

    it("readEventType handles undefined, null, and scValToNative errors", () => {
      const rowUndefined = mapRpcEventToRow({ topic: [undefined], ledger: 10 });
      expect(rowUndefined.eventType).toBe("unknown");

      const rowNull = mapRpcEventToRow({ topic: [null], ledger: 10 });
      expect(rowNull.eventType).toBe("unknown");

      const rowInvalidScVal = mapRpcEventToRow({ topic: [{ invalid: "scval" }], ledger: 10 });
      expect(rowInvalidScVal.eventType).toBe("unknown");
    });

    it("handles pagingToken and raw string topics in event key generation during fetchEventRange", async () => {
      const server = {
        calls: [],
        getLatestLedger: async () => ({ sequence: 100 }),
        getEvents: async () => ({
          events: [
            {
              pagingToken: "token-abc",
              contractId: "C1",
              topic: ["funded"],
              ledger: 10,
              ledgerClosedAt: new Date().toISOString(),
            },
            {
              // neither id nor pagingToken
              contractId: "C1",
              topic: ["funded"],
              ledger: 10,
              ledgerClosedAt: new Date().toISOString(),
            },
          ],
          latestLedger: 100,
        }),
      };
      const client = new RpcPollerClient("https://rpc.invalid", { server: server as any });
      const res = await client.fetchEventRange({ startLedger: 10, endLedger: 10 });
      expect(res.eventCount).toBe(2);
    });

    it("underlyingServer returns the wrapped RPC server", () => {
      const stub = {
        getLatestLedger: async () => ({ sequence: 100 }),
        getEvents: async () => ({ events: [] }),
      };
      const client = new RpcPollerClient("https://rpc.invalid", { server: stub });
      expect(client.underlyingServer).toBe(stub);
      expect(client.rpcServer).toBe(stub);
    });

    it("delegates getLatestLedger and getEvents to the server with retry", async () => {
      const stub = {
        getLatestLedger: async () => ({ sequence: 12345 }),
        getEvents: async (params: any) => ({ events: [], latestLedger: 12345, params }),
      };
      const client = new RpcPollerClient("https://rpc.invalid", { server: stub });
      const ledgerRes = await client.getLatestLedger();
      expect(ledgerRes.sequence).toBe(12345);

      const eventsRes = await client.getEvents({ startLedger: 100 });
      expect(eventsRes.latestLedger).toBe(12345);
    });

    it("covers previous lock rejection in withEventLock", async () => {
      const queue = new RpcEventQueue({
        persist: async () => true,
      });

      const row1 = {
        contractId: "C1",
        eventType: "funded",
        ledgerSequence: 100,
        timestamp: 1000,
        dataJson: "{}",
      };

      // Run two parallel operations on the same event lock key where the first rejects
      const key = "C1:funded:100";
      const p1 = (queue as any).withEventLock(key, async () => {
        throw new Error("first lock failed");
      });
      const p2 = (queue as any).withEventLock(key, async () => {
        return "second lock succeeded";
      });

      await expect(p1).rejects.toThrow("first lock failed");
      const res2 = await p2;
      expect(res2).toBe("second lock succeeded");
    });

    it("RpcEventQueue flush handles already persisted keys and duplicates", async () => {
      const queue = new RpcEventQueue({
        persist: async () => true,
      });

      const row1 = {
        contractId: "C1",
        eventType: "funded",
        ledgerSequence: 100,
        timestamp: 1000,
        dataJson: "{}",
      };

      // Enqueue and flush first time so it is in persistedKeys
      await queue.submit([row1]);

      // Manually add row1 into (queue as any).pending without deduplicating via enqueue
      (queue as any).pending.push(row1);
      const flushRes = await queue.flush();
      expect(flushRes.duplicateCount).toBe(1);
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
