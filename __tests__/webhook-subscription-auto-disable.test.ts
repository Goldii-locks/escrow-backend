import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import {
  addSubscription,
  getActiveSubscriptions,
  getDisabledSubscriptions,
  getSubscriptions,
  initSchema,
  recordSubscriptionFailure,
  recordSubscriptionSuccess,
  setDb,
} from "../src/indexer/db.js";

let testDb: Database.Database;

const CONTRACT_ID = "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";
const WEBHOOK_URL = "https://example.com/hook";

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
});

describe("webhook subscription failure tracking (#701)", () => {
  it("adds the failure tracking columns to the subscriptions table", () => {
    const columns = testDb
      .prepare("PRAGMA table_info(webhook_subscriptions)")
      .all() as Array<{ name: string }>;

    const names = columns.map((column) => column.name);
    expect(names).toContain("consecutive_failures");
    expect(names).toContain("disabled_at");
    expect(names).toContain("last_error");
  });

  it("starts with an empty failure counter", () => {
    const sub = addSubscription(CONTRACT_ID, WEBHOOK_URL, ["fund"]);
    expect(sub.consecutive_failures).toBe(0);
    expect(sub.disabled_at).toBeNull();
    expect(sub.last_error).toBeNull();
  });

  it("increments the counter and stores the last error on failure", () => {
    const sub = addSubscription(CONTRACT_ID, WEBHOOK_URL, ["fund"]);

    const state = recordSubscriptionFailure(sub.id, "HTTP_500", 50);

    expect(state.consecutiveFailures).toBe(1);
    expect(state.disabled).toBe(false);

    const row = getSubscriptions()[0];
    expect(row.consecutive_failures).toBe(1);
    expect(row.last_error).toBe("HTTP_500");
    expect(row.disabled_at).toBeNull();
  });

  it("resets the counter after a successful delivery", () => {
    const sub = addSubscription(CONTRACT_ID, WEBHOOK_URL, ["fund"]);

    recordSubscriptionFailure(sub.id, "HTTP_500", 50);
    recordSubscriptionSuccess(sub.id);

    const row = getSubscriptions()[0];
    expect(row.consecutive_failures).toBe(0);
    expect(row.last_error).toBeNull();
    expect(row.disabled_at).toBeNull();
  });

  it("disables the subscription after the configured number of failures", () => {
    const sub = addSubscription(CONTRACT_ID, WEBHOOK_URL, ["fund"]);

    let state = recordSubscriptionFailure(sub.id, "HTTP_404", 3);
    expect(state.disabled).toBe(false);
    state = recordSubscriptionFailure(sub.id, "HTTP_404", 3);
    expect(state.disabled).toBe(false);
    state = recordSubscriptionFailure(sub.id, "HTTP_404", 3);
    expect(state.disabled).toBe(true);
    expect(state.consecutiveFailures).toBe(3);

    const row = getSubscriptions()[0];
    expect(row.disabled_at).not.toBeNull();
    expect(getActiveSubscriptions()).toHaveLength(0);
    expect(getDisabledSubscriptions()).toHaveLength(1);
  });

  it("re-enables the subscription and resets the counter on a fresh subscribe", () => {
    const sub = addSubscription(CONTRACT_ID, WEBHOOK_URL, ["fund"]);
    recordSubscriptionFailure(sub.id, "HTTP_404", 1);
    expect(getActiveSubscriptions()).toHaveLength(0);

    const reSubscribed = addSubscription(CONTRACT_ID, WEBHOOK_URL, ["fund"]);

    expect(reSubscribed.id).toBe(sub.id);
    expect(reSubscribed.disabled_at).toBeNull();
    expect(reSubscribed.consecutive_failures).toBe(0);
    expect(reSubscribed.last_error).toBeNull();
    expect(getActiveSubscriptions()).toHaveLength(1);
    expect(getDisabledSubscriptions()).toHaveLength(0);
  });
});

describe("webhook delivery skips disabled subscriptions (#701)", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("does not attempt delivery for a disabled subscription", async () => {
    const { deliverWebhooks } = await import("../src/indexer/webhook-delivery.js");

    const sub = addSubscription(CONTRACT_ID, WEBHOOK_URL, ["fund"]);
    recordSubscriptionFailure(sub.id, "HTTP_404", 1);

    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
    }) as unknown as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    testDb
      .prepare(
        `INSERT INTO events
           (contract_id, event_type, ledger_sequence, timestamp, data_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(CONTRACT_ID, "fund", 2000, 1700000000, "{}");

    const results = await deliverWebhooks(2000, 2000);

    expect(results).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts a failed delivery towards the disable threshold", async () => {
    const { deliverWebhooks } = await import("../src/indexer/webhook-delivery.js");

    addSubscription(CONTRACT_ID, WEBHOOK_URL, ["fund"]);

    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
    }) as unknown as Response) as unknown as typeof fetch;

    testDb
      .prepare(
        `INSERT INTO events
           (contract_id, event_type, ledger_sequence, timestamp, data_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(CONTRACT_ID, "fund", 2001, 1700000001, "{}");

    const results = await deliverWebhooks(2001, 2001);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);

    const row = getSubscriptions()[0];
    expect(row.consecutive_failures).toBe(1);
    expect(row.last_error).toBeTruthy();
  });
});
