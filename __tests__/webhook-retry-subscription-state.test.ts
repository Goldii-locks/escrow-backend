import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import {
  setDb,
  runMigrations,
  addSubscription,
  insertEvent,
  getSubscriptions,
  recordSubscriptionFailure,
  parseSqliteUtcTimestamp,
} from "../src/indexer/db.js";
import {
  deliverWebhooks,
  retryFailedDeliveries,
  WEBHOOK_DISABLE_AFTER,
  WEBHOOK_RETRY_MAX_AGE_MS,
} from "../src/indexer/webhook-delivery.js";
import { maskWebhookUrlQuery } from "../src/utils/log-redaction.js";
import logger from "../src/utils/logger.js";

const CONTRACT = "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";
const URL = "https://example.com/hook";
const SECRET_URL = "https://example.com/hook?token=abc";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_TZ = process.env.TZ;

let testDb: Database.Database;
let mockFetch: jest.Mock<(...args: any[]) => any>;

/** Insert an event whose created_at is `ageSeconds` old, in SQLite's UTC format. */
function seedEvent(ageSeconds = 0, ledger = 100): number {
  insertEvent(CONTRACT, "fund", ledger, 1_700_000_000, JSON.stringify({ client: "GCLIENT" }));
  const row = testDb
    .prepare("SELECT id FROM events WHERE contract_id = ? AND ledger_sequence = ?")
    .get(CONTRACT, ledger) as { id: number };
  testDb
    .prepare("UPDATE events SET created_at = datetime('now', ?) WHERE id = ?")
    .run(`-${ageSeconds} seconds`, row.id);
  return row.id;
}

function seedFailedDelivery(subscriptionId: number, eventId: number, attempts = 1): void {
  testDb
    .prepare(
      `INSERT INTO webhook_deliveries
         (subscription_id, event_id, status, attempts, last_error, next_attempt_at)
       VALUES (?, ?, 'failed', ?, 'HTTP_500', ?)`
    )
    .run(subscriptionId, eventId, attempts, Date.now() - 1000);
}

function deliveryRow(subscriptionId: number, eventId: number) {
  return testDb
    .prepare(
      "SELECT status, last_error FROM webhook_deliveries WHERE subscription_id = ? AND event_id = ?"
    )
    .get(subscriptionId, eventId) as { status: string; last_error: string | null };
}

beforeAll(() => {
  testDb = new Database(":memory:");
  setDb(testDb);
  runMigrations();
});

afterAll(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  testDb.close();
});

beforeEach(() => {
  mockFetch = jest.fn();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  testDb.exec("DELETE FROM webhook_deliveries");
  testDb.exec("DELETE FROM webhook_subscriptions");
  testDb.exec("DELETE FROM events");
});

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("retry sweep honours subscription state (#852)", () => {
  it("makes no HTTP request to a disabled subscription and dead-letters its rows", async () => {
    const sub = addSubscription(CONTRACT, URL, ["fund"]);
    const eventId = seedEvent();
    seedFailedDelivery(sub.id, eventId);
    for (let i = 0; i < WEBHOOK_DISABLE_AFTER; i++) {
      recordSubscriptionFailure(sub.id, "HTTP_500", WEBHOOK_DISABLE_AFTER);
    }

    expect(await retryFailedDeliveries()).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(deliveryRow(sub.id, eventId)).toEqual({
      status: "dead",
      last_error: "subscription disabled",
    });
  });

  it("resets consecutive_failures after a successful retry", async () => {
    const sub = addSubscription(CONTRACT, URL, ["fund"]);
    const eventId = seedEvent();
    seedFailedDelivery(sub.id, eventId);
    recordSubscriptionFailure(sub.id, "HTTP_500", WEBHOOK_DISABLE_AFTER);
    recordSubscriptionFailure(sub.id, "HTTP_500", WEBHOOK_DISABLE_AFTER);
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    expect(await retryFailedDeliveries()).toBe(1);
    const row = getSubscriptions().find((s) => s.id === sub.id);
    expect(row?.consecutive_failures).toBe(0);
    expect(row?.last_error).toBeNull();
  });

  it("counts a failed retry toward the subscription's consecutive failures", async () => {
    const sub = addSubscription(CONTRACT, URL, ["fund"]);
    const eventId = seedEvent();
    seedFailedDelivery(sub.id, eventId);
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    expect(await retryFailedDeliveries()).toBe(0);
    const row = getSubscriptions().find((s) => s.id === sub.id);
    expect(row?.consecutive_failures).toBe(1);
    expect(row?.last_error).toBe("HTTP_500");
  });
});

describe("retry age check parses SQLite timestamps as UTC (#853)", () => {
  it("parses CURRENT_TIMESTAMP values the same in every timezone", () => {
    const expected = Date.UTC(2026, 0, 1, 0, 0, 0);
    for (const tz of ["America/Los_Angeles", "Asia/Tokyo", "UTC"]) {
      process.env.TZ = tz;
      expect(parseSqliteUtcTimestamp("2026-01-01 00:00:00")).toBe(expected);
      expect(parseSqliteUtcTimestamp("2026-01-01T00:00:00Z")).toBe(expected);
    }
    expect(Number.isNaN(parseSqliteUtcTimestamp(""))).toBe(true);
    expect(Number.isNaN(parseSqliteUtcTimestamp("not a date"))).toBe(true);
  });

  it("gives the same retry decision under America/Los_Angeles and Asia/Tokyo", async () => {
    // Just inside the max age: a local-time parse would push it over the
    // limit in Asia/Tokyo (UTC+9) and keep it in America/Los_Angeles.
    const ageSeconds = Math.floor(WEBHOOK_RETRY_MAX_AGE_MS / 1000) - 2 * 60 * 60;
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const results: Record<string, { redelivered: number; status: string }> = {};
    for (const tz of ["America/Los_Angeles", "Asia/Tokyo"]) {
      process.env.TZ = tz;
      testDb.exec("DELETE FROM webhook_deliveries");
      testDb.exec("DELETE FROM webhook_subscriptions");
      testDb.exec("DELETE FROM events");
      const sub = addSubscription(CONTRACT, URL, ["fund"]);
      const eventId = seedEvent(ageSeconds);
      seedFailedDelivery(sub.id, eventId);

      const redelivered = await retryFailedDeliveries();
      results[tz] = { redelivered, status: deliveryRow(sub.id, eventId).status };
    }

    expect(results["America/Los_Angeles"]).toEqual({ redelivered: 1, status: "delivered" });
    expect(results["Asia/Tokyo"]).toEqual(results["America/Los_Angeles"]);
  });
});

describe("re-subscribing replaces the event filter (#854)", () => {
  it("stores and returns the new event_types", () => {
    const first = addSubscription(CONTRACT, URL, ["Funded"]);
    const second = addSubscription(CONTRACT, URL, ["*"]);

    expect(second.id).toBe(first.id);
    expect(JSON.parse(second.event_types)).toEqual(["*"]);
    const stored = getSubscriptions().filter((s) => s.contract_id === CONTRACT);
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0].event_types)).toEqual(["*"]);
  });
});

describe("delivery logs never include webhook URL query strings (#855)", () => {
  function captureLogs() {
    const spies = [
      jest.spyOn(logger, "info").mockImplementation(() => logger),
      jest.spyOn(logger, "warn").mockImplementation(() => logger),
      jest.spyOn(logger, "error").mockImplementation(() => logger),
      jest.spyOn(logger, "debug").mockImplementation(() => logger),
    ];
    return {
      output: () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls)),
      restore: () => spies.forEach((spy) => spy.mockRestore()),
    };
  }

  it("masks the query string", () => {
    expect(maskWebhookUrlQuery(SECRET_URL)).toBe(URL);
    expect(maskWebhookUrlQuery("not a url?token=abc")).toBe("not a url");
  });

  it("does not log the token for a successful delivery", async () => {
    addSubscription(CONTRACT, SECRET_URL, ["*"]);
    seedEvent(0, 200);
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const logs = captureLogs();
    try {
      const results = await deliverWebhooks(200, 200);
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(logs.output()).toContain("Webhook delivered");
      expect(logs.output()).not.toContain("abc");
    } finally {
      logs.restore();
    }
  });

  it("does not log the token for a failing delivery", async () => {
    addSubscription(CONTRACT, SECRET_URL, ["*"]);
    seedEvent(0, 300);
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const logs = captureLogs();
    try {
      const results = await deliverWebhooks(300, 300);
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(logs.output()).toContain("Webhook delivery failed after all attempts");
      expect(logs.output()).not.toContain("abc");
    } finally {
      logs.restore();
    }
  }, 15000);
});
