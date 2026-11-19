import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import {
  setDb,
  runMigrations,
  addSubscription,
  insertEvent,
  getSubscriptions,
  recordSubscriptionFailure,
  type EventDbRow,
} from "../src/indexer/db.js";
import {
  getFetchErrorCode,
  deliverToUrl,
  retryFailedDeliveries,
  getDeadDeliveries,
  WEBHOOK_MAX_DELIVERY_ATTEMPTS,
  WEBHOOK_RETRY_MAX_AGE_MS,
  WEBHOOK_DISABLE_AFTER,
} from "../src/indexer/webhook-delivery.js";
import logger from "../src/utils/logger.js";

const CONTRACT = "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";
const URL = "https://example.com/hook";

const ORIGINAL_FETCH = globalThis.fetch;

let testDb: Database.Database;
let mockFetch: jest.Mock<(...args: any[]) => any>;

function eventRow(overrides: Partial<EventDbRow> = {}): EventDbRow {
  return {
    id: 1,
    contract_id: CONTRACT,
    event_type: "fund",
    ledger_sequence: 100,
    timestamp: 1_700_000_000,
    data_json: JSON.stringify({ client: "GCLIENT" }),
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as EventDbRow;
}

function seedEvent(createdAt: string = "2026-01-01T00:00:00Z"): number {
  insertEvent(CONTRACT, "fund", 100, 1_700_000_000, JSON.stringify({ client: "GCLIENT" }));
  testDb.prepare("UPDATE events SET created_at = ? WHERE contract_id = ?").run(createdAt, CONTRACT);
  return (testDb.prepare("SELECT id FROM events WHERE contract_id = ?").get(CONTRACT) as { id: number }).id;
}

function seedFailedDelivery(subscriptionId: number, eventId: number, attempts = 1): void {
  testDb
    .prepare(
      `INSERT INTO webhook_deliveries
         (subscription_id, event_id, status, attempts, last_error, next_attempt_at)
       VALUES (?, ?, 'failed', ?, 'HTTP_500', ?)
       ON CONFLICT(subscription_id, event_id) DO UPDATE SET
         status = 'failed', attempts = excluded.attempts,
         last_error = excluded.last_error,
         next_attempt_at = excluded.next_attempt_at`
    )
    .run(subscriptionId, eventId, attempts, Date.now() - 1000);
}

describe("webhook retry, dead-lettering and error outcomes (#952)", () => {
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

  describe("getFetchErrorCode", () => {
    it("prefers cause.code", () => {
      const err = Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" }),
      });
      expect(getFetchErrorCode(err)).toBe("ENOTFOUND");
    });

    it("falls back to cause.name", () => {
      const err = Object.assign(new Error("fetch failed"), {
        cause: { name: "TimeoutError" },
      });
      expect(getFetchErrorCode(err)).toBe("TimeoutError");
    });

    it("uses the error name for a bare Error and a top-level DOMException name", () => {
      expect(getFetchErrorCode(new Error("boom"))).toBe("Error");
      expect(getFetchErrorCode({ name: "AbortError" })).toBe("AbortError");
      expect(getFetchErrorCode("mystery")).toBe("UNKNOWN_ERROR");
    });
  });

  describe("deliverToUrl outcomes", () => {
    it("reports REDIRECT_3xx without following the redirect", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 302 });
      const outcome = await deliverToUrl(URL, eventRow(), { deliveryId: "d", attempt: 1 });
      expect(outcome.ok).toBe(false);
      expect(outcome.status).toBe(302);
      expect(outcome.errorCode).toBe("REDIRECT_302");
      expect(mockFetch.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
    });

    it("reports PAYLOAD_PARSE_ERROR for a malformed stored event", async () => {
      const outcome = await deliverToUrl(
        URL,
        eventRow({ data_json: "{not json" }),
        { deliveryId: "d", attempt: 1 }
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.errorCode).toBe("PAYLOAD_PARSE_ERROR");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("retryFailedDeliveries dead-lettering", () => {
    it("marks a row dead when the event or subscription is gone", async () => {
      const sub = addSubscription(CONTRACT, URL, ["fund"]);
      seedFailedDelivery(sub.id, 99999);

      expect(await retryFailedDeliveries()).toBe(0);
      expect(getDeadDeliveries()).toEqual([
        expect.objectContaining({ subscription_id: sub.id, event_id: 99999 }),
      ]);
    });

    it("marks a row dead once attempts reach the configured maximum", async () => {
      const sub = addSubscription(CONTRACT, URL, ["fund"]);
      const eventId = seedEvent();
      seedFailedDelivery(sub.id, eventId, WEBHOOK_MAX_DELIVERY_ATTEMPTS);

      expect(await retryFailedDeliveries()).toBe(0);
      expect(getDeadDeliveries()).toEqual([
        expect.objectContaining({ subscription_id: sub.id, event_id: eventId }),
      ]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("marks a row dead when the event is older than the retry max age", async () => {
      const sub = addSubscription(CONTRACT, URL, ["fund"]);
      const eventId = seedEvent("2000-01-01T00:00:00Z");
      seedFailedDelivery(sub.id, eventId, 1);
      expect(WEBHOOK_RETRY_MAX_AGE_MS).toBeGreaterThan(0);

      expect(await retryFailedDeliveries()).toBe(0);
      expect(getDeadDeliveries()).toEqual([
        expect.objectContaining({ subscription_id: sub.id, event_id: eventId }),
      ]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("redelivers a healthy row and records the new outcome", async () => {
      const sub = addSubscription(CONTRACT, URL, ["fund"]);
      const eventId = seedEvent();
      seedFailedDelivery(sub.id, eventId, 1);
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      expect(await retryFailedDeliveries()).toBe(1);
      const row = testDb
        .prepare("SELECT status, attempts FROM webhook_deliveries WHERE subscription_id = ? AND event_id = ?")
        .get(sub.id, eventId) as { status: string; attempts: number };
      expect(row).toEqual({ status: "delivered", attempts: 2 });
    });

    it("swallows a failure to record the delivery outcome", async () => {
      const sub = addSubscription(CONTRACT, URL, ["fund"]);
      const eventId = seedEvent();
      seedFailedDelivery(sub.id, eventId, 1);
      mockFetch.mockResolvedValue({ ok: false, status: 500 });

      const warn = jest.spyOn(logger, "warn").mockImplementation(() => logger);
      const prepare = jest.spyOn(testDb, "prepare").mockImplementation((sql: string) => {
        if (sql.includes("INSERT INTO webhook_deliveries") && sql.includes("'failed'")) {
          throw new Error("recording failed");
        }
        return testDb.constructor.prototype.prepare.call(testDb, sql) as any;
      });

      try {
        await expect(retryFailedDeliveries()).resolves.toBe(0);
        expect(warn).toHaveBeenCalledWith(
          "Failed to record webhook delivery outcome",
          expect.objectContaining({ error: "recording failed" })
        );
      } finally {
        prepare.mockRestore();
        warn.mockRestore();
      }
    });
  });

  describe("auto-disable after repeated failures", () => {
    it("disables a subscription after WEBHOOK_DISABLE_AFTER failures and removes it from active delivery", () => {
      const sub = addSubscription(CONTRACT, URL, ["fund"]);
      let state = { disabled: false, consecutiveFailures: 0 };
      for (let i = 0; i < WEBHOOK_DISABLE_AFTER; i++) {
        state = recordSubscriptionFailure(sub.id, "HTTP_500", WEBHOOK_DISABLE_AFTER);
      }
      expect(state.disabled).toBe(true);
      expect(getSubscriptions().find((s) => s.id === sub.id)?.disabled_at).not.toBeNull();
    });
  });
});
