import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import {
  setDb,
  initSchema,
  registerContract,
  updateContractPointer,
  addSubscription,
  insertEvent,
} from "../src/indexer/db.js";

/**
 * Issue #885: Webhook delivery deduplication and scoped range delivery.
 * When a contract with an historical startLedger is backfilled, subscribers
 * for already caught-up contracts must receive zero duplicate deliveries for
 * the overlapping ledger range, while caught-up contracts' events and failed
 * deliveries with expired backoff are retried correctly.
 */

const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetEvents = jest.fn<(params: any) => Promise<{ events: unknown[] }>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getLatestLedger = mockGetLatestLedger;
    getEvents = mockGetEvents;
  },
}));

jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  scValToNative: (value: unknown) => value,
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  pollEvents,
  resetFailureState,
  flushWebhookDeliveryQueueForTests,
  resetWebhookDeliveryQueueForTests,
} = await import("../src/indexer/poller.js");

const { deliverWebhooks } = await import("../src/indexer/webhook-delivery.js");

const CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CONTRACT_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const HOOK_A = "https://93.184.215.14/hook-a";
const HOOK_B = "https://93.184.215.14/hook-b";

let testDb: Database.Database;
const deliveredA: Array<{ ledger_sequence: number; event_type: string }> = [];
const deliveredB: Array<{ ledger_sequence: number; event_type: string }> = [];

let fetchHandler: (url: string, init: { body: string }) => Promise<{ ok: boolean; status: number }>;

beforeAll(() => {
  testDb = new Database(":memory:");
  setDb(testDb);
  initSchema();
});

afterAll(() => {
  testDb.close();
});

beforeEach(() => {
  testDb.exec("DELETE FROM webhook_deliveries");
  testDb.exec("DELETE FROM webhook_subscriptions");
  testDb.exec("DELETE FROM events");
  testDb.exec("DELETE FROM monitored_contracts");
  resetFailureState();
  resetWebhookDeliveryQueueForTests();
  mockGetLatestLedger.mockReset();
  mockGetEvents.mockReset();
  deliveredA.length = 0;
  deliveredB.length = 0;

  fetchHandler = async (url: string, init: { body: string }) => {
    const payload = JSON.parse(init.body) as { ledger_sequence: number; event_type: string };
    if (url === HOOK_A) {
      deliveredA.push({
        ledger_sequence: payload.ledger_sequence,
        event_type: payload.event_type,
      });
    } else if (url === HOOK_B) {
      deliveredB.push({
        ledger_sequence: payload.ledger_sequence,
        event_type: payload.event_type,
      });
    }
    return { ok: true, status: 200 };
  };

  (globalThis as any).fetch = jest.fn(
    (url: string, init: { body: string }) => fetchHandler(url, init),
  );
});

afterEach(() => {
  delete (globalThis as any).fetch;
});

describe("Webhook delivery deduplication and scoped range delivery (#885)", () => {
  it("prevents duplicate deliveries for caught-up contracts when backfilling a new contract, and retries eligible failed deliveries", async () => {
    // 1. Register Contract A with an active webhook subscription, index and deliver up to ledger 1000
    registerContract(CONTRACT_A, "contract_a", 100);
    const subA = addSubscription(CONTRACT_A, HOOK_A, ["*"]);

    // Insert Contract A events in [500, 1000] and one prior event
    insertEvent(CONTRACT_A, "fund", 200, 200, JSON.stringify({ amount: 100 }));
    insertEvent(CONTRACT_A, "fund", 600, 600, JSON.stringify({ amount: 200 }));
    insertEvent(CONTRACT_A, "dispute", 700, 700, JSON.stringify({ reason: "delay" }));
    insertEvent(CONTRACT_A, "approve", 800, 800, JSON.stringify({ milestone: 1 }));
    insertEvent(CONTRACT_A, "complete", 1000, 1000, JSON.stringify({ status: "done" }));

    // Deliver Contract A events initially, but simulate ledger 700 failing on first pass
    const event700 = testDb
      .prepare("SELECT id FROM events WHERE contract_id = ? AND ledger_sequence = 700")
      .get(CONTRACT_A) as { id: number };

    // Initially mark 200, 600, 800, 1000 as delivered
    for (const seq of [200, 600, 800, 1000]) {
      const ev = testDb
        .prepare("SELECT id FROM events WHERE contract_id = ? AND ledger_sequence = ?")
        .get(CONTRACT_A, seq) as { id: number };
      testDb
        .prepare(
          `INSERT INTO webhook_deliveries
             (subscription_id, event_id, status, attempts, next_attempt_at)
           VALUES (?, ?, 'delivered', 1, NULL)`,
        )
        .run(subA.id, ev.id);
      deliveredA.push({ ledger_sequence: seq, event_type: "initial" });
    }

    // Seed ledger 700 as 'failed' with expired next_attempt_at (retries expected)
    testDb
      .prepare(
        `INSERT INTO webhook_deliveries
           (subscription_id, event_id, status, attempts, last_error, next_attempt_at)
         VALUES (?, ?, 'failed', 1, 'HTTP_500', ?)`,
      )
      .run(subA.id, event700.id, Date.now() - 5000);

    // Contract A pointer is at 1000 (caught up)
    updateContractPointer(CONTRACT_A, 1000);

    // Reset delivered tracking before pollEvents
    deliveredA.length = 0;
    deliveredB.length = 0;

    // 2. Register Contract B with startLedger = 500 and active webhook subscription
    registerContract(CONTRACT_B, "contract_b", 500);
    addSubscription(CONTRACT_B, HOOK_B, ["*"]);

    // Events for both A and B are present in [500, 1000]
    // Mock RPC returning Contract B events in [500, 1000]
    mockGetLatestLedger.mockResolvedValue({ sequence: 1000 });
    mockGetEvents.mockImplementation(async (params: any) => {
      const contractIds =
        params.filters?.[0]?.contractIds ?? params.contractIds ?? [];
      if (contractIds.includes(CONTRACT_B)) {
        return {
          events: [
            {
              contractId: { contractId: () => CONTRACT_B },
              topic: ["fund"],
              ledger: 550,
              ledgerClosedAt: new Date(550 * 1000).toISOString(),
              value: { amount: 50 },
            },
            {
              contractId: { contractId: () => CONTRACT_B },
              topic: ["approve"],
              ledger: 750,
              ledgerClosedAt: new Date(750 * 1000).toISOString(),
              value: { milestone: 1 },
            },
          ],
        };
      }
      return { events: [] };
    });

    // 3. Trigger pollEvents and webhook delivery
    const polled = await pollEvents();
    expect(polled).toBe(true);

    await flushWebhookDeliveryQueueForTests();

    // 4. Assertions:
    // Contract A subscriber must receive ZERO duplicate deliveries for already-delivered [500, 1000] events (600, 800, 1000)
    const duplicateA = deliveredA.filter((d) => d.ledger_sequence !== 700);
    expect(duplicateA).toHaveLength(0);

    // Contract B subscriber receives Contract B's events from [500, 1000]
    expect(deliveredB).toHaveLength(2);
    expect(deliveredB.map((d) => d.ledger_sequence).sort()).toEqual([550, 750]);

    // Previously failed delivery (ledger 700) in that range is NOT improperly skipped because retries were expected
    const retryA = deliveredA.filter((d) => d.ledger_sequence === 700);
    expect(retryA).toHaveLength(1);
    expect(retryA[0].event_type).toBe("dispute");

    // The retried delivery is now marked delivered in webhook_deliveries
    const delivery700 = testDb
      .prepare(
        "SELECT status FROM webhook_deliveries WHERE subscription_id = ? AND event_id = ?",
      )
      .get(subA.id, event700.id) as { status: string };
    expect(delivery700.status).toBe("delivered");
  });

  it("guarantees idempotency on manual overlapping deliverWebhooks backfills", async () => {
    registerContract(CONTRACT_A, "contract_a", 100);
    addSubscription(CONTRACT_A, HOOK_A, ["*"]);

    insertEvent(CONTRACT_A, "fund", 500, 500, "{}");
    insertEvent(CONTRACT_A, "approve", 600, 600, "{}");

    // First delivery
    const firstResults = await deliverWebhooks(500, 600);
    expect(firstResults).toHaveLength(2);
    expect(firstResults.every((r) => r.success)).toBe(true);
    expect(deliveredA).toHaveLength(2);

    // Second delivery of identical overlapping range: should deliver 0 duplicates
    deliveredA.length = 0;
    const secondResults = await deliverWebhooks(400, 700);
    expect(secondResults).toHaveLength(0);
    expect(deliveredA).toHaveLength(0);
  });

  it("does not prematurely retry failed deliveries during a poll until backoff expires, then retries successfully", async () => {
    registerContract(CONTRACT_A, "contract_a", 100);
    const sub = addSubscription(CONTRACT_A, HOOK_A, ["*"]);

    insertEvent(CONTRACT_A, "fund", 600, 600, "{}");
    const ev = testDb
      .prepare("SELECT id FROM events WHERE contract_id = ? AND ledger_sequence = 600")
      .get(CONTRACT_A) as { id: number };

    // Record as failed with future next_attempt_at (1 minute in the future)
    testDb
      .prepare(
        `INSERT INTO webhook_deliveries
           (subscription_id, event_id, status, attempts, last_error, next_attempt_at)
         VALUES (?, ?, 'failed', 1, 'HTTP_500', ?)`,
      )
      .run(sub.id, ev.id, Date.now() + 60000);

    updateContractPointer(CONTRACT_A, 1000);

    // Register Contract B at 500 and trigger a poll
    registerContract(CONTRACT_B, "contract_b", 500);
    addSubscription(CONTRACT_B, HOOK_B, ["*"]);

    mockGetLatestLedger.mockResolvedValue({ sequence: 1000 });
    mockGetEvents.mockResolvedValue({ events: [] });

    await pollEvents();
    await flushWebhookDeliveryQueueForTests();

    // Contract A should NOT have been delivered because it is in backoff
    expect(deliveredA).toHaveLength(0);

    const deliveryBefore = testDb
      .prepare("SELECT status FROM webhook_deliveries WHERE subscription_id = ? AND event_id = ?")
      .get(sub.id, ev.id) as { status: string };
    expect(deliveryBefore.status).toBe("failed");

    // Now simulate backoff expiring and a new ledger closing
    testDb
      .prepare("UPDATE webhook_deliveries SET next_attempt_at = ? WHERE subscription_id = ? AND event_id = ?")
      .run(Date.now() - 1000, sub.id, ev.id);

    mockGetLatestLedger.mockResolvedValue({ sequence: 1001 });

    // Next poll or delivery sweep should deliver it
    await pollEvents();
    await flushWebhookDeliveryQueueForTests();

    expect(deliveredA).toHaveLength(1);
    expect(deliveredA[0].ledger_sequence).toBe(600);

    const deliveryAfter = testDb
      .prepare("SELECT status FROM webhook_deliveries WHERE subscription_id = ? AND event_id = ?")
      .get(sub.id, ev.id) as { status: string };
    expect(deliveryAfter.status).toBe("delivered");
  });
});
