import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import { initSchema, setDb, addSubscription, insertEvent } from "../src/indexer/db.js";

/**
 * #682: webhook delivery runs are queued, so a slow delivery for an earlier
 * ledger range always finishes before a later range starts, and subscribers
 * receive events in ledger order.
 */

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {},
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { enqueueWebhookDelivery, resetWebhookDeliveryQueueForTests } = await import(
  "../src/indexer/poller.js"
);
const { default: logger } = await import("../src/utils/logger.js");

const CONTRACT = "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";
// A public IP literal: the #605 delivery guard accepts it without a DNS
// lookup, so the timing assertions below never wait on a real resolver.
const HOOK = "https://93.184.215.14/hook";

let testDb: Database.Database;
/** Ledger of each event in the order the subscriber received it. */
let received: number[];
/** Per-ledger artificial latency of the subscriber's response, in ms. */
let latencyByLedger: Map<number, number>;
let mockFetch: jest.Mock<(url: string, init: { body: string }) => Promise<unknown>>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(() => {
  testDb = new Database(":memory:");
  setDb(testDb);
  initSchema();
});

afterAll(() => {
  testDb.close();
});

beforeEach(() => {
  testDb.exec("DELETE FROM webhook_subscriptions");
  testDb.exec("DELETE FROM events");
  resetWebhookDeliveryQueueForTests();
  received = [];
  latencyByLedger = new Map();

  mockFetch = jest.fn(async (_url: string, init: { body: string }) => {
    const { ledger_sequence } = JSON.parse(init.body) as { ledger_sequence: number };
    await sleep(latencyByLedger.get(ledger_sequence) ?? 0);
    received.push(ledger_sequence);
    return { ok: true, status: 200 };
  });
  (global as any).fetch = mockFetch;

  addSubscription(CONTRACT, HOOK, ["funded"]);
});

afterEach(() => {
  delete (global as any).fetch;
});

describe("ordered webhook delivery queue (#682)", () => {
  it("delivers every event of a slow first range before a fast second range", async () => {
    for (const ledger of [100, 101, 102]) {
      insertEvent(CONTRACT, "funded", ledger, ledger, "{}");
      latencyByLedger.set(ledger, 40);
    }
    for (const ledger of [103, 104]) {
      insertEvent(CONTRACT, "funded", ledger, ledger, "{}");
    }

    // Two consecutive polls: range 1 is slow, range 2 is instant.
    const first = enqueueWebhookDelivery(100, 102);
    const second = enqueueWebhookDelivery(103, 104);
    await Promise.all([first, second]);

    expect(received).toEqual([100, 101, 102, 103, 104]);
  });

  it("does not start a later range while an earlier one is still delivering", async () => {
    insertEvent(CONTRACT, "funded", 100, 100, "{}");
    insertEvent(CONTRACT, "funded", 101, 101, "{}");
    latencyByLedger.set(100, 50);

    const first = enqueueWebhookDelivery(100, 100);
    const second = enqueueWebhookDelivery(101, 101);

    await sleep(20);
    // Range 1 is mid-delivery: range 2 must not have been attempted yet.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(received).toEqual([]);

    await Promise.all([first, second]);
    expect(received).toEqual([100, 101]);
  });

  it("keeps delivering later ranges after a run fails", async () => {
    insertEvent(CONTRACT, "funded", 101, 101, "{}");

    // The first run throws (its database handle is closed); it must be
    // logged, not stall the queue.
    const closedDb = new Database(":memory:");
    closedDb.close();
    setDb(closedDb);
    const failed = enqueueWebhookDelivery(100, 100);
    await expect(failed).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      "Error delivering webhooks",
      expect.objectContaining({ startLedger: 100, endLedger: 100 }),
    );

    setDb(testDb);
    await enqueueWebhookDelivery(101, 101);
    expect(received).toEqual([101]);
  });
});
