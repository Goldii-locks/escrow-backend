import { jest } from "@jest/globals";
import http from "http";
import type { AddressInfo } from "net";
import Database from "better-sqlite3";
import { initSchema, setDb, addSubscription, insertEvent } from "../src/indexer/db.js";
import {
  deliverToUrl,
  deliverWebhooks,
  webhookEventId,
} from "../src/indexer/webhook-delivery.js";

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
}

let testDb: Database.Database;
let server: http.Server;
let hookUrl: string;
let captured: Captured[];
/** Status codes to answer with, in order; 200 once exhausted. */
let responses: number[];

beforeAll(async () => {
  testDb = new Database(":memory:");
  setDb(testDb);
  initSchema();

  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      captured.push({ headers: req.headers, body: JSON.parse(raw) });
      res.statusCode = responses.shift() ?? 200;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
});

afterAll(async () => {
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

    const results = await deliverWebhooks(100, 100);

    expect(results[0].success).toBe(true);
    expect(results[0].attempts).toBe(3);
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
