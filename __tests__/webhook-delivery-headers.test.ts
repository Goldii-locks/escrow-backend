import { jest } from "@jest/globals";
import http from "http";
import type { AddressInfo } from "net";
import Database from "better-sqlite3";
import {
  initSchema,
  setDb,
  addSubscription,
  insertEvent,
  getSubscriptions,
  getActiveSubscriptions,
  getSubscriptionsForContract,
} from "../src/indexer/db.js";
import {
  deliverToUrl,
  deliverWebhooks,
  retryFailedDeliveries,
  webhookEventId,
} from "../src/indexer/webhook-delivery.js";
import { verifySignedRequest } from "../src/utils/webhook_signature_verifier.js";

/**
 * #676: subscribers dedupe on X-Milesto-Event-Id / X-Milesto-Delivery-Id.
 * A real capturing HTTP server records each POST so the headers are checked
 * exactly as they go over the wire.
 */

jest.setTimeout(20_000);

const CONTRACT_A = "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Captured {
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
  /** The body exactly as received on the wire. */
  raw: string;
}

/** Expire the backoff of every failed delivery so the sweep retries it. */
function makeFailedDeliveriesDue(): void {
  testDb.exec("UPDATE webhook_deliveries SET next_attempt_at = 0 WHERE status = 'failed'");
}

let testDb: Database.Database;
let server: http.Server;
let hookUrl: string;
let captured: Captured[];
/** Status codes to answer with, in order; 200 once exhausted. */
let responses: number[];

beforeAll(async () => {
  // The receiver below listens on loopback, which the #605 URL guard rejects
  // unless this test-only override is set (honoured only under NODE_ENV=test).
  process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS = "1";
  testDb = new Database(":memory:");
  setDb(testDb);
  initSchema();

  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      captured.push({ headers: req.headers, body: JSON.parse(raw), raw });
      res.statusCode = responses.shift() ?? 200;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
});

afterAll(async () => {
  delete process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  testDb.close();
});

beforeEach(() => {
  testDb.exec("DELETE FROM webhook_subscriptions");
  testDb.exec("DELETE FROM events");
  captured = [];
  responses = [];
});

describe("webhook idempotency headers (#676)", () => {
  it("sends event_id in the body and the three X-Milesto headers", async () => {
    addSubscription(CONTRACT_A, hookUrl, ["funded"]);
    insertEvent(CONTRACT_A, "funded", 100, 1000, JSON.stringify({ client: "GCLIENT" }));

    const results = await deliverWebhooks(100, 100);

    expect(results).toHaveLength(1);
    expect(captured).toHaveLength(1);
    const [{ headers, body }] = captured;
    const expectedEventId = `${CONTRACT_A}:100:funded`;

    expect(body.event_id).toBe(expectedEventId);
    expect(headers["x-milesto-event-id"]).toBe(expectedEventId);
    expect(headers["x-milesto-delivery-id"]).toMatch(UUID);
    expect(headers["x-milesto-delivery-attempt"]).toBe("1");
    expect(results[0].deliveryId).toBe(headers["x-milesto-delivery-id"]);
  });

  it("keeps the same delivery id across retries and increments the attempt", async () => {
    responses = [500, 503];
    addSubscription(CONTRACT_A, hookUrl, ["funded"]);
    insertEvent(CONTRACT_A, "funded", 100, 1000, JSON.stringify({ client: "GCLIENT" }));

    // Attempt 1 is inline; attempts 2 and 3 come from the retry sweep (#851).
    const results = await deliverWebhooks(100, 100);
    expect(results[0].success).toBe(false);
    expect(results[0].attempts).toBe(1);

    makeFailedDeliveriesDue();
    await expect(retryFailedDeliveries()).resolves.toBe(0);
    makeFailedDeliveriesDue();
    await expect(retryFailedDeliveries()).resolves.toBe(1);

    expect(captured).toHaveLength(3);

    const deliveryIds = new Set(captured.map((c) => c.headers["x-milesto-delivery-id"]));
    expect(deliveryIds.size).toBe(1);
    expect(captured.map((c) => c.headers["x-milesto-delivery-attempt"])).toEqual(["1", "2", "3"]);
    expect(new Set(captured.map((c) => c.headers["x-milesto-event-id"])).size).toBe(1);
    expect(new Set(captured.map((c) => c.body.event_id)).size).toBe(1);
  });

  it("gives distinct events distinct event ids and delivery ids", async () => {
    addSubscription(CONTRACT_A, hookUrl, ["funded", "approved"]);
    insertEvent(CONTRACT_A, "funded", 100, 1000, JSON.stringify({ n: 1 }));
    insertEvent(CONTRACT_A, "approved", 101, 1001, JSON.stringify({ n: 2 }));

    await deliverWebhooks(100, 101);

    expect(captured).toHaveLength(2);
    const [first, second] = captured;
    expect(first.headers["x-milesto-event-id"]).not.toBe(second.headers["x-milesto-event-id"]);
    expect(first.headers["x-milesto-delivery-id"]).not.toBe(
      second.headers["x-milesto-delivery-id"],
    );
  });

  it("delivers the same event to two subscribers under different delivery ids", async () => {
    addSubscription(CONTRACT_A, hookUrl, ["funded"]);
    addSubscription(CONTRACT_A, `${hookUrl}?second=1`, ["funded"]);
    insertEvent(CONTRACT_A, "funded", 100, 1000, JSON.stringify({ n: 1 }));

    await deliverWebhooks(100, 100);

    expect(captured).toHaveLength(2);
    expect(captured[0].headers["x-milesto-event-id"]).toBe(
      captured[1].headers["x-milesto-event-id"],
    );
    expect(captured[0].headers["x-milesto-delivery-id"]).not.toBe(
      captured[1].headers["x-milesto-delivery-id"],
    );
  });

  it("uses an explicit delivery id and attempt when deliverToUrl is called directly", async () => {
    const event = {
      id: 7,
      contract_id: CONTRACT_A,
      event_type: "claim",
      ledger_sequence: 555,
      timestamp: 1,
      data_json: "{}",
      created_at: "",
    };

    await deliverToUrl(hookUrl, event, { deliveryId: "fixed-delivery", attempt: 2 });

    expect(captured[0].headers["x-milesto-delivery-id"]).toBe("fixed-delivery");
    expect(captured[0].headers["x-milesto-delivery-attempt"]).toBe("2");
    expect(captured[0].headers["x-milesto-event-id"]).toBe(webhookEventId(event));
  });
});

describe("webhook delivery signatures (#849)", () => {
  it("signs a captured delivery so verifySignedRequest accepts it with the subscription's secret", async () => {
    const sub = addSubscription(CONTRACT_A, hookUrl, ["funded"]);
    expect(sub.signing_secret).toMatch(/^[0-9a-f]{64}$/);
    insertEvent(CONTRACT_A, "funded", 100, 1000, JSON.stringify({ client: "GCLIENT" }));

    await deliverWebhooks(100, 100);

    expect(captured).toHaveLength(1);
    const [{ raw, headers }] = captured;
    expect(headers["x-webhook-timestamp"]).toMatch(/^\d+$/);
    expect(headers["x-webhook-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);

    const verified = verifySignedRequest(raw, headers, sub.signing_secret);
    expect(verified.ok).toBe(true);

    // A different secret, or a tampered body, is rejected.
    expect(verifySignedRequest(raw, headers, "x".repeat(64)).ok).toBe(false);
    expect(verifySignedRequest(raw.replace("GCLIENT", "GOTHER"), headers, sub.signing_secret).ok).toBe(false);
  });

  it("signs every retry from retryFailedDeliveries with a fresh timestamp", async () => {
    responses = [500];
    const sub = addSubscription(CONTRACT_A, hookUrl, ["funded"]);
    insertEvent(CONTRACT_A, "funded", 100, 1000, JSON.stringify({ client: "GCLIENT" }));

    // Pin the clock so the two attempts get distinct, known timestamps. It
    // stays close to real time so the retry sweep does not expire the row.
    const baseSeconds = Math.floor(Date.now() / 1000);
    const nowSpy = jest.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(baseSeconds * 1000);
      await deliverWebhooks(100, 100);

      makeFailedDeliveriesDue();
      nowSpy.mockReturnValue((baseSeconds + 120) * 1000);
      await expect(retryFailedDeliveries()).resolves.toBe(1);
    } finally {
      nowSpy.mockRestore();
    }

    expect(captured).toHaveLength(2);
    expect(captured.map((c) => c.headers["x-webhook-timestamp"])).toEqual([
      String(baseSeconds),
      String(baseSeconds + 120),
    ]);
    for (const [i, c] of captured.entries()) {
      const verified = verifySignedRequest(c.raw, c.headers, sub.signing_secret, {
        now: baseSeconds + (i === 0 ? 0 : 120),
      });
      expect(verified.ok).toBe(true);
    }
  });

  it("rotates the secret on re-subscribe; deliveries use the new one", async () => {
    const first = addSubscription(CONTRACT_A, hookUrl, ["funded"]);
    const second = addSubscription(CONTRACT_A, hookUrl, ["funded"]);
    expect(second.id).toBe(first.id);
    expect(second.signing_secret).not.toBe(first.signing_secret);

    insertEvent(CONTRACT_A, "funded", 100, 1000, JSON.stringify({ client: "GCLIENT" }));
    await deliverWebhooks(100, 100);

    const [{ raw, headers }] = captured;
    expect(verifySignedRequest(raw, headers, second.signing_secret).ok).toBe(true);
    expect(verifySignedRequest(raw, headers, first.signing_secret).ok).toBe(false);
  });

  it("never returns the secret from subscription listings", () => {
    const sub = addSubscription(CONTRACT_A, hookUrl, ["funded"]);
    const listings = [
      getSubscriptions(),
      getActiveSubscriptions(),
      getSubscriptionsForContract(CONTRACT_A),
    ];
    for (const list of listings) {
      expect(list).toHaveLength(1);
      expect(list[0]).not.toHaveProperty("signing_secret");
      expect(JSON.stringify(list)).not.toContain(sub.signing_secret as string);
    }
  });
});
