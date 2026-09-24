import Database from "better-sqlite3";
import {
  setDb,
  runMigrations,
  closeDb,
  insertEvent,
  type EventRow,
} from "../src/indexer/db.js";
import {
  WriterPoolEventQueue,
  WriterPoolEventQueueOverflowError,
  DEFAULT_WRITER_POOL_EVENT_QUEUE_MAX_SIZE,
  writerPoolEventIdentityKey,
  submitEventNotifications,
  getWriterPoolEventQueue,
  resetWriterPoolStartState,
  queueWrite,
  flushWriteQueue,
  type WriteOperation,
} from "../src/indexer/database-writer-pool.js";

const CONTRACT_ID = "CTEST0000000000000000000000000000000000000000000000000001";
const EVENT_TYPES = ["initialized", "funded", "approved"];

function row(
  ledgerSequence: number,
  eventType = "funded",
  contractId = CONTRACT_ID,
): EventRow {
  return {
    contractId,
    eventType,
    ledgerSequence,
    timestamp: 1_700_000_000 + ledgerSequence,
    dataJson: JSON.stringify({ ledger: ledgerSequence, eventType }),
  };
}

function rows(start: number, end: number, perLedger = 1): EventRow[] {
  const out: EventRow[] = [];
  for (let ledger = start; ledger <= end; ledger++) {
    for (let i = 0; i < perLedger; i++) {
      out.push(row(ledger, EVENT_TYPES[i % EVENT_TYPES.length]));
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("database_writer_pool – concurrent event insert locks (#327)", () => {
  afterEach(async () => {
    await flushWriteQueue();
    resetWriterPoolStartState();
  });

  describe("writerPoolEventIdentityKey", () => {
    it("keys on the events table's uniqueness triple", () => {
      expect(writerPoolEventIdentityKey(row(7, "funded"))).toBe(
        `${CONTRACT_ID}|7|funded`,
      );
    });

    it("distinguishes ledger, type and contract", () => {
      const base = writerPoolEventIdentityKey(row(7, "funded"));
      expect(writerPoolEventIdentityKey(row(8, "funded"))).not.toBe(base);
      expect(writerPoolEventIdentityKey(row(7, "approved"))).not.toBe(base);
      expect(writerPoolEventIdentityKey(row(7, "funded", "COTHER"))).not.toBe(
        base,
      );
    });
  });

  describe("WriterPoolEventQueue", () => {
    it("persists a batch once and reports the counts", async () => {
      const persisted: EventRow[] = [];
      const queue = new WriterPoolEventQueue({
        persist: (event) => {
          persisted.push(event);
          return true;
        },
      });

      const result = await queue.submit(rows(1, 3));

      expect(result).toEqual({
        queuedCount: 3,
        insertedCount: 3,
        duplicateCount: 0,
      });
      expect(persisted).toHaveLength(3);
      expect(queue.size).toBe(0);
      expect(queue.heldLockCount).toBe(0);
      expect(queue.persistedKeyCount).toBe(3);
    });

    it("collapses duplicates inside a single batch", async () => {
      let persistCalls = 0;
      const queue = new WriterPoolEventQueue({
        persist: () => {
          persistCalls++;
          return true;
        },
      });

      const result = await queue.submit([row(5), row(5), row(5)]);

      expect(persistCalls).toBe(1);
      expect(result.queuedCount).toBe(1);
      expect(result.insertedCount).toBe(1);
      expect(result.duplicateCount).toBe(2);
    });

    it("persists each event exactly once under concurrent submits", async () => {
      const persistCounts = new Map<string, number>();
      const queue = new WriterPoolEventQueue({
        persist: async (event) => {
          const key = writerPoolEventIdentityKey(event);
          // Yield inside the critical section: without a lock this is exactly
          // where a second caller would slip in and insert the same row.
          await sleep(2);
          persistCounts.set(key, (persistCounts.get(key) ?? 0) + 1);
          return true;
        },
      });

      const batch = rows(1, 5);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => queue.submit(batch)),
      );

      expect(persistCounts.size).toBe(5);
      expect([...persistCounts.values()].every((n) => n === 1)).toBe(true);

      const inserted = results.reduce((sum, r) => sum + r.insertedCount, 0);
      const duplicates = results.reduce((sum, r) => sum + r.duplicateCount, 0);
      expect(inserted).toBe(5);
      expect(inserted + duplicates).toBe(8 * 5);
      expect(queue.size).toBe(0);
      expect(queue.heldLockCount).toBe(0);
    });

    it("never runs two persists for the same event at the same time", async () => {
      const inFlight = new Set<string>();
      let overlaps = 0;
      const queue = new WriterPoolEventQueue({
        persist: async (event) => {
          const key = writerPoolEventIdentityKey(event);
          if (inFlight.has(key)) overlaps++;
          inFlight.add(key);
          await sleep(2);
          inFlight.delete(key);
          return true;
        },
      });

      await Promise.all([
        queue.submit(rows(1, 4)),
        queue.submit(rows(1, 4)),
        queue.submit(rows(1, 4)),
      ]);

      expect(overlaps).toBe(0);
    });

    it("lets unrelated events persist concurrently", async () => {
      let active = 0;
      let peak = 0;
      const queue = new WriterPoolEventQueue({
        persist: async () => {
          active++;
          peak = Math.max(peak, active);
          await sleep(5);
          active--;
          return true;
        },
      });

      await Promise.all([
        queue.submit([row(1, "initialized")]),
        queue.submit([row(2, "initialized")]),
        queue.submit([row(3, "initialized")]),
      ]);

      expect(peak).toBeGreaterThan(1);
    });

    it("counts a persist that reports no write as a duplicate", async () => {
      const queue = new WriterPoolEventQueue({ persist: () => false });

      const result = await queue.submit([row(9)]);

      expect(result.insertedCount).toBe(0);
      expect(result.duplicateCount).toBe(1);
    });

    it("releases the lock when a persist throws", async () => {
      let calls = 0;
      const queue = new WriterPoolEventQueue({
        persist: () => {
          calls++;
          if (calls === 1) throw new Error("database is locked");
          return true;
        },
      });

      await expect(queue.submit([row(4)])).rejects.toThrow("database is locked");
      expect(queue.heldLockCount).toBe(0);

      const retry = await queue.submit([row(4)]);
      expect(retry.insertedCount).toBe(1);
      expect(queue.heldLockCount).toBe(0);
    });

    it("releases the lock after a successful persist", async () => {
      const queue = new WriterPoolEventQueue({ persist: () => true });

      await queue.submit([row(1), row(2)]);

      expect(queue.heldLockCount).toBe(0);
      expect(queue.size).toBe(0);
    });

    it("queues notifications before a flush and drains them once", async () => {
      const persisted: EventRow[] = [];
      const queue = new WriterPoolEventQueue({
        persist: (event) => {
          persisted.push(event);
          return true;
        },
      });

      const first = await queue.enqueue(rows(1, 3));
      const second = await queue.enqueue(rows(2, 4));

      // Ledgers 2 and 3 are already queued, so only ledger 4 is new.
      expect(first.queuedCount).toBe(3);
      expect(second.queuedCount).toBe(1);
      expect(second.duplicateCount).toBe(2);
      expect(queue.size).toBe(4);

      const flushed = await queue.flush();
      expect(flushed.processedCount).toBe(4);
      expect(flushed.insertedCount).toBe(4);
      expect(persisted).toHaveLength(4);
      expect(queue.size).toBe(0);
    });

    it("does not re-persist an event enqueued again after a flush", async () => {
      let persistCalls = 0;
      const queue = new WriterPoolEventQueue({
        persist: () => {
          persistCalls++;
          return true;
        },
      });

      await queue.submit([row(11)]);
      const again = await queue.enqueue([row(11)]);

      expect(again.queuedCount).toBe(0);
      expect(again.duplicateCount).toBe(1);
      expect(persistCalls).toBe(1);
      expect(queue.hasPersisted(row(11))).toBe(true);
    });

    it("drains safely when flushes run concurrently", async () => {
      let persistCalls = 0;
      const queue = new WriterPoolEventQueue({
        persist: async () => {
          persistCalls++;
          await sleep(1);
          return true;
        },
      });

      await queue.enqueue(rows(1, 20));
      await Promise.all([queue.flush(), queue.flush(), queue.flush()]);

      expect(persistCalls).toBe(20);
      expect(queue.size).toBe(0);
      expect(queue.persistedKeyCount).toBe(20);
    });

    it("rejects an enqueue past maxQueueSize", async () => {
      const queue = new WriterPoolEventQueue({
        persist: () => true,
        maxQueueSize: 3,
      });

      await expect(queue.enqueue(rows(1, 5))).rejects.toThrow(
        WriterPoolEventQueueOverflowError,
      );
      expect(queue.size).toBe(3);
    });

    it("rejects an invalid maxQueueSize", () => {
      expect(() => new WriterPoolEventQueue({ maxQueueSize: 0 })).toThrow(
        /maxQueueSize must be a positive integer/,
      );
    });

    it("clears all state on reset", async () => {
      const queue = new WriterPoolEventQueue({ persist: () => true });
      await queue.submit(rows(1, 3));

      queue.reset();

      expect(queue.size).toBe(0);
      expect(queue.persistedKeyCount).toBe(0);
      expect(queue.hasPersisted(row(1, "initialized"))).toBe(false);
      expect(queue.heldLockCount).toBe(0);
    });

    it("exposes the default queue ceiling", () => {
      expect(DEFAULT_WRITER_POOL_EVENT_QUEUE_MAX_SIZE).toBe(10_000);
    });

    it("survives repeated waves of concurrent identical batches", async () => {
      const persistCounts = new Map<string, number>();
      const queue = new WriterPoolEventQueue({
        persist: async (event) => {
          const key = writerPoolEventIdentityKey(event);
          await sleep(1);
          persistCounts.set(key, (persistCounts.get(key) ?? 0) + 1);
          return true;
        },
      });

      const batch = rows(1, 6, 2);
      for (let wave = 0; wave < 4; wave++) {
        await Promise.all(Array.from({ length: 5 }, () => queue.submit(batch)));
      }

      expect(persistCounts.size).toBe(12);
      expect([...persistCounts.values()].every((n) => n === 1)).toBe(true);
      expect(queue.heldLockCount).toBe(0);
    });
  });

  describe("queueWrite lock release", () => {
    it("releases the write-queue lock after a failed operation so later writes proceed", async () => {
      const failOp: WriteOperation<void> = {
        name: "failing-lock-release",
        execute: () => {
          throw new Error("intentional writer failure");
        },
      };

      const failed = await queueWrite(failOp);
      expect(failed.success).toBe(false);

      const recovered = await queueWrite({
        name: "after-failure",
        execute: () => 1,
      });
      expect(recovered.success).toBe(true);
      expect(recovered.data).toBe(1);
    });

    it("does not serialize unrelated event identities through the event lock", async () => {
      let active = 0;
      let peak = 0;
      const queue = new WriterPoolEventQueue({
        persist: async () => {
          active++;
          peak = Math.max(peak, active);
          await sleep(8);
          active--;
          return true;
        },
      });

      await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          queue.submit([row(100 + i, "funded")]),
        ),
      );

      expect(peak).toBeGreaterThan(1);
      expect(queue.heldLockCount).toBe(0);
    });
  });

  describe("with a real SQLite store", () => {
    let testDb: Database.Database;

    beforeEach(async () => {
      testDb = new Database(":memory:");
      setDb(testDb);
      runMigrations();
      resetWriterPoolStartState();
      await flushWriteQueue();
    });

    afterEach(async () => {
      await flushWriteQueue();
      resetWriterPoolStartState();
      closeDb();
    });

    function eventCount(): number {
      return (testDb.prepare("SELECT COUNT(*) AS c FROM events").get() as any).c;
    }

    it("does not duplicate entries when the same notifications arrive concurrently", async () => {
      const batch = rows(1, 10, 2);

      const results = await Promise.all(
        Array.from({ length: 6 }, () => submitEventNotifications(batch)),
      );

      expect(eventCount()).toBe(20);
      expect(results.reduce((sum, r) => sum + r.insertedCount, 0)).toBe(20);

      const perLedger = testDb
        .prepare(
          `SELECT ledger_sequence AS ledger, COUNT(*) AS c FROM events
           GROUP BY ledger_sequence ORDER BY ledger_sequence`,
        )
        .all() as Array<{ ledger: number; c: number }>;
      expect(perLedger).toHaveLength(10);
      expect(perLedger.every((r) => r.c === 2)).toBe(true);
    });

    it("keeps concurrent event notifications free of duplicate rows", async () => {
      const batch = rows(1, 8, 3);

      await Promise.all([
        submitEventNotifications(batch),
        submitEventNotifications(batch),
        submitEventNotifications(batch),
        submitEventNotifications(batch),
      ]);

      expect(eventCount()).toBe(24);
      expect(getWriterPoolEventQueue().heldLockCount).toBe(0);
    });

    it("is idempotent across sequential submissions of the same window", async () => {
      const batch = rows(100, 104, 3);

      const first = await submitEventNotifications(batch);
      const second = await submitEventNotifications(batch);

      expect(first.insertedCount).toBe(15);
      expect(second.insertedCount).toBe(0);
      expect(second.duplicateCount).toBe(15);
      expect(eventCount()).toBe(15);
    });

    it("still de-duplicates after a state reset, because the store rejects the row", async () => {
      const batch = rows(200, 202, 2);

      await submitEventNotifications(batch);
      resetWriterPoolStartState();
      const second = await submitEventNotifications(batch);

      expect(second.insertedCount).toBe(0);
      expect(second.duplicateCount).toBe(6);
      expect(eventCount()).toBe(6);
    });

    it("does not double-count rows written outside the queue", async () => {
      insertEvent(CONTRACT_ID, "funded", 1, 1_700_000_001, "{}");

      const result = await submitEventNotifications([row(1, "funded")]);

      expect(result.insertedCount).toBe(0);
      expect(result.duplicateCount).toBe(1);
      expect(eventCount()).toBe(1);
    });

    it("does not duplicate when notifications race queueWrite inserts", async () => {
      const batch = rows(50, 54, 2);

      await Promise.all([
        submitEventNotifications(batch),
        submitEventNotifications(batch),
        queueWrite({
          name: "direct-insert-event",
          execute: () =>
            insertEvent(
              CONTRACT_ID,
              "funded",
              52,
              1_700_000_052,
              JSON.stringify({ ledger: 52, eventType: "funded" }),
            ),
        }),
      ]);

      expect(eventCount()).toBe(10);
    });

    it("survives repeated concurrent submissions of the same window", async () => {
      const batch = rows(300, 304, 2);

      for (let wave = 0; wave < 3; wave++) {
        await Promise.all(
          Array.from({ length: 8 }, () => submitEventNotifications(batch)),
        );
      }

      expect(eventCount()).toBe(10);
      expect(getWriterPoolEventQueue().heldLockCount).toBe(0);
      expect(getWriterPoolEventQueue().size).toBe(0);
    });

    it("propagates persist failures and still allows a later retry", async () => {
      const queue = new WriterPoolEventQueue({
        persist: async (event) => {
          const result = await queueWrite({
            name: "insert-event-may-fail",
            execute: () => {
              if (event.ledgerSequence === 1 && event.eventType === "boom") {
                throw new Error("constraint boom");
              }
              return insertEvent(
                event.contractId,
                event.eventType,
                event.ledgerSequence,
                event.timestamp,
                event.dataJson,
              );
            },
          });
          if (!result.success) {
            throw result.error ?? new Error("insert failed");
          }
          return Boolean(result.data);
        },
      });

      await expect(
        queue.submit([
          {
            ...row(1, "boom"),
            eventType: "boom",
          },
        ]),
      ).rejects.toThrow("constraint boom");
      expect(queue.heldLockCount).toBe(0);

      const retry = await queue.submit([row(2, "funded")]);
      expect(retry.insertedCount).toBe(1);
      expect(eventCount()).toBe(1);
    });
  });
});
