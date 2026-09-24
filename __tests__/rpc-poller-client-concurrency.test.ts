import Database from "better-sqlite3";
import { setDb, runMigrations, closeDb, type EventRow } from "../src/indexer/db.js";
import {
  RpcEventQueue,
  RpcEventQueueOverflowError,
  RpcPollerClient,
  DEFAULT_RPC_EVENT_QUEUE_MAX_SIZE,
  type RpcServerLike,
} from "../src/indexer/rpc-poller-client.js";

const CONTRACT_ID = "CTEST0000000000000000000000000000000000000000000000000001";
const EVENT_TYPES = ["initialized", "funded", "approved"];

function row(
  ledgerSequence: number,
  eventType = "funded",
  contractId = CONTRACT_ID
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

/** Serves the same fixed event window on every call, cursor ignored. */
class StubRpcServer implements RpcServerLike {
  callCount = 0;

  constructor(private readonly events: any[]) {}

  async getLatestLedger(): Promise<{ sequence: number }> {
    return { sequence: 10_000 };
  }

  async getEvents(params: any): Promise<any> {
    this.callCount++;
    await sleep(1);
    const from = params.cursor
      ? this.events.findIndex((e) => e.pagingToken === params.cursor) + 1
      : this.events.findIndex((e) => e.ledger >= params.startLedger);
    if (from === -1) return { events: [], latestLedger: 10_000 };
    const page = this.events.slice(from, from + (params.limit ?? 100));
    return {
      events: page,
      latestLedger: 10_000,
      cursor: page.length > 0 ? page[page.length - 1].pagingToken : undefined,
    };
  }
}

function rpcEvents(start: number, end: number, perLedger = 1): any[] {
  const out: any[] = [];
  for (let ledger = start; ledger <= end; ledger++) {
    for (let i = 0; i < perLedger; i++) {
      out.push({
        id: `${ledger}-${i}`,
        pagingToken: `${ledger}-${i}`,
        contractId: CONTRACT_ID,
        topic: [EVENT_TYPES[i % EVENT_TYPES.length]],
        ledger,
        ledgerClosedAt: new Date(1_700_000_000_000 + ledger * 5000).toISOString(),
        value: { ledger, i },
      });
    }
  }
  return out;
}

describe("RpcPollerClient – concurrent event insert locks (#269)", () => {
  describe("RpcEventQueue", () => {
    it("persists a batch once and reports the counts", async () => {
      const persisted: EventRow[] = [];
      const queue = new RpcEventQueue({
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
      const queue = new RpcEventQueue({
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
      const queue = new RpcEventQueue({
        persist: async (event) => {
          const key = `${event.contractId}|${event.ledgerSequence}|${event.eventType}`;
          // Yield inside the critical section: without a lock this is exactly
          // where a second caller would slip in and insert the same row.
          await sleep(2);
          persistCounts.set(key, (persistCounts.get(key) ?? 0) + 1);
          return true;
        },
      });

      const batch = rows(1, 5);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => queue.submit(batch))
      );

      expect([...persistCounts.values()].every((n) => n === 1)).toBe(true);
      expect(persistCounts.size).toBe(5);

      const inserted = results.reduce((sum, r) => sum + r.insertedCount, 0);
      const duplicates = results.reduce((sum, r) => sum + r.duplicateCount, 0);
      expect(inserted).toBe(5);
      expect(inserted + duplicates).toBe(8 * 5);
      expect(queue.size).toBe(0);
      expect(queue.heldLockCount).toBe(0);
    });

    it("never runs two persists for the same event at the same time", async () => {
      const inFlight = new Set<string>();
      let maxConcurrentForKey = 0;
      const queue = new RpcEventQueue({
        persist: async (event) => {
          const key = `${event.ledgerSequence}|${event.eventType}`;
          if (inFlight.has(key)) maxConcurrentForKey++;
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

      expect(maxConcurrentForKey).toBe(0);
    });

    it("lets unrelated events persist concurrently", async () => {
      let active = 0;
      let peak = 0;
      const queue = new RpcEventQueue({
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
      const queue = new RpcEventQueue({ persist: () => false });

      const result = await queue.submit([row(9)]);

      expect(result.insertedCount).toBe(0);
      expect(result.duplicateCount).toBe(1);
    });

    it("releases the lock when a persist throws", async () => {
      let calls = 0;
      const queue = new RpcEventQueue({
        persist: () => {
          calls++;
          if (calls === 1) throw new Error("db is locked");
          return true;
        },
      });

      await expect(queue.submit([row(4)])).rejects.toThrow("db is locked");
      expect(queue.heldLockCount).toBe(0);

      const retry = await queue.submit([row(4)]);
      expect(retry.insertedCount).toBe(1);
    });

    it("queues rows before a flush and drains them once", async () => {
      const persisted: EventRow[] = [];
      const queue = new RpcEventQueue({
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
      const queue = new RpcEventQueue({
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
      const queue = new RpcEventQueue({
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
      const queue = new RpcEventQueue({ persist: () => true, maxQueueSize: 3 });

      await expect(queue.enqueue(rows(1, 5))).rejects.toThrow(
        RpcEventQueueOverflowError
      );
      expect(queue.size).toBe(3);
    });

    it("rejects an invalid maxQueueSize", () => {
      expect(() => new RpcEventQueue({ maxQueueSize: 0 })).toThrow(
        /maxQueueSize must be a positive integer/
      );
    });

    it("clears all state on reset", async () => {
      const queue = new RpcEventQueue({ persist: () => true });
      await queue.submit(rows(1, 3));

      queue.reset();

      expect(queue.size).toBe(0);
      expect(queue.persistedKeyCount).toBe(0);
      expect(queue.hasPersisted(row(1, "initialized"))).toBe(false);
    });

    it("exposes the default queue ceiling", () => {
      expect(DEFAULT_RPC_EVENT_QUEUE_MAX_SIZE).toBe(10_000);
    });
  });

  describe("with a real SQLite store", () => {
    let testDb: Database.Database;

    beforeEach(() => {
      testDb = new Database(":memory:");
      setDb(testDb);
      runMigrations();
    });

    afterEach(() => {
      closeDb();
    });

    function eventCount(): number {
      return (testDb.prepare("SELECT COUNT(*) AS c FROM events").get() as any).c;
    }

    it("does not duplicate entries when the same notifications arrive concurrently", async () => {
      const client = new RpcPollerClient("https://rpc.invalid", {
        server: new StubRpcServer([]),
      });
      const batch = rows(1, 10, 2);

      const results = await Promise.all(
        Array.from({ length: 6 }, () => client.submitEventNotifications(batch))
      );

      expect(eventCount()).toBe(20);
      expect(results.reduce((sum, r) => sum + r.insertedCount, 0)).toBe(20);

      const perLedger = testDb
        .prepare(
          `SELECT ledger_sequence AS ledger, COUNT(*) AS c FROM events
           GROUP BY ledger_sequence ORDER BY ledger_sequence`
        )
        .all() as Array<{ ledger: number; c: number }>;
      expect(perLedger).toHaveLength(10);
      expect(perLedger.every((r) => r.c === 2)).toBe(true);
    });

    it("maps and de-duplicates raw RPC notifications", async () => {
      const client = new RpcPollerClient("https://rpc.invalid", {
        server: new StubRpcServer([]),
      });
      const raw = rpcEvents(1, 4, 2);

      await Promise.all([
        client.submitEventNotifications(raw),
        client.submitEventNotifications(raw),
      ]);

      expect(eventCount()).toBe(8);
    });

    it("keeps overlapping concurrent historical syncs free of duplicates", async () => {
      const client = new RpcPollerClient("https://rpc.invalid", {
        server: new StubRpcServer(rpcEvents(1, 30, 2)),
        historicalPageSize: 5,
        eventsLimit: 10,
      });

      const results = await Promise.all([
        client.syncHistoricalRange({ startLedger: 1, endLedger: 15 }),
        client.syncHistoricalRange({ startLedger: 10, endLedger: 25 }),
        client.syncHistoricalRange({ startLedger: 1, endLedger: 25 }),
      ]);

      // Ledgers 1..25 × 2 events, inserted exactly once across all three syncs.
      expect(eventCount()).toBe(50);
      expect(results.reduce((sum, r) => sum + r.insertedCount, 0)).toBe(50);
      expect(client.eventQueue.size).toBe(0);
      expect(client.eventQueue.heldLockCount).toBe(0);
    });

    it("does not duplicate when a live notification races a historical sync", async () => {
      const client = new RpcPollerClient("https://rpc.invalid", {
        server: new StubRpcServer(rpcEvents(1, 12, 2)),
        historicalPageSize: 4,
        eventsLimit: 8,
      });

      const [sync] = await Promise.all([
        client.syncHistoricalRange({ startLedger: 1, endLedger: 12 }),
        client.submitEventNotifications(rows(5, 8, 2)),
        client.submitEventNotifications(rows(5, 8, 2)),
      ]);

      expect(eventCount()).toBe(24);
      expect(sync.eventCount).toBe(24);
      expect(client.eventQueue.persistedKeyCount).toBe(24);
    });

    it("survives repeated sequential submissions of the same window", async () => {
      const client = new RpcPollerClient("https://rpc.invalid", {
        server: new StubRpcServer([]),
      });
      const batch = rows(100, 104, 3);

      const first = await client.submitEventNotifications(batch);
      const second = await client.submitEventNotifications(batch);

      expect(first.insertedCount).toBe(15);
      expect(second.insertedCount).toBe(0);
      expect(second.duplicateCount).toBe(15);
      expect(eventCount()).toBe(15);
    });

    it("still de-duplicates after a queue reset, because the store rejects the row", async () => {
      const client = new RpcPollerClient("https://rpc.invalid", {
        server: new StubRpcServer([]),
      });
      const batch = rows(200, 202, 2);

      await client.submitEventNotifications(batch);
      client.eventQueue.reset();
      const second = await client.submitEventNotifications(batch);

      expect(second.insertedCount).toBe(0);
      expect(second.duplicateCount).toBe(6);
      expect(eventCount()).toBe(6);
    });
  });
});
