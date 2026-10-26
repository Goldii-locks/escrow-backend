import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import request from "supertest";
import express from "express";
import {
  initSchema,
  setDb,
  addSubscription,
  removeSubscription,
  registerContract,
  getSubscriptions,
  insertEvent,
} from "../src/indexer/db.js";

let testDb: Database.Database;

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
});

describe("Subscription management – unit", () => {
  const CONTRACT_A = "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";
  const WEBHOOK_URL = "https://example.com/webhook";

  it("adds a subscription", () => {
    const sub = addSubscription(CONTRACT_A, WEBHOOK_URL, ["funded", "approved"]);
    expect(sub.contract_id).toBe(CONTRACT_A);
    expect(sub.webhook_url).toBe(WEBHOOK_URL);
    expect(sub.event_types).toBe(JSON.stringify(["funded", "approved"]));
    expect(sub.id).toBeGreaterThan(0);
  });

  it("prevents duplicate subscriptions", () => {
    addSubscription(CONTRACT_A, WEBHOOK_URL, ["funded"]);
    addSubscription(CONTRACT_A, WEBHOOK_URL, ["approved"]);
    const subs = getSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0].event_types).toBe(JSON.stringify(["funded"]));
  });

  it("removes a subscription", () => {
    addSubscription(CONTRACT_A, WEBHOOK_URL, ["funded"]);
    const removed = removeSubscription(CONTRACT_A, WEBHOOK_URL);
    expect(removed).toBe(true);
    expect(getSubscriptions()).toHaveLength(0);
  });

  it("returns false when removing non-existent subscription", () => {
    const removed = removeSubscription(CONTRACT_A, WEBHOOK_URL);
    expect(removed).toBe(false);
  });

  it("lists subscriptions", () => {
    addSubscription(CONTRACT_A, WEBHOOK_URL, ["funded"]);
    addSubscription("CONTRACT_B", "https://other.com/hook", ["approved"]);
    expect(getSubscriptions()).toHaveLength(2);
  });
});

describe("POST /api/webhooks/subscribe – HTTP", () => {
  let app: express.Express;
  const ADMIN_KEY = "webhooks-test-admin-key";
  const originalAdminKey = process.env.ADMIN_API_KEY;

  beforeAll(async () => {
    const { default: router } = await import("../src/routes/webhooks.js");
    app = express();
    app.use(express.json());
    // #604: both mutation routes now require the admin credential. This
    // suite's subject is validation, so attach the key centrally and let
    // requests through the gate (the dedicated auth suite in
    // webhook-subscribe-auth.test.ts asserts the 401 paths per request).
    app.use((req, _res, next) => {
      req.headers["x-api-key"] = ADMIN_KEY;
      next();
    });
    app.use("/api/webhooks", router);
  });

  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
  });

  afterEach(() => {
    if (originalAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalAdminKey;
  });

  const VALID_CONTRACT =
    "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";
  // Valid contract ID that is NOT registered in monitored_contracts.
  const UNMONITORED_CONTRACT =
    "CBQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCV5G";
  const WEBHOOK_URL = "https://example.com/hook";

  const VALID_BODY = {
    contract_id: VALID_CONTRACT,
    webhook_url: WEBHOOK_URL,
    event_types: ["funded", "approved"],
  };

  beforeEach(() => {
    registerContract(VALID_CONTRACT, "test contract");
  });

  it("returns 200 with subscription on valid request", async () => {
    const res = await request(app)
      .post("/api/webhooks/subscribe")
      .send(VALID_BODY)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.subscription.contract_id).toBe(VALID_BODY.contract_id);
    expect(res.body.data.subscription.webhook_url).toBe(VALID_BODY.webhook_url);
  });

  it("returns 400 when contract_id is missing", async () => {
    const res = await request(app)
      .post("/api/webhooks/subscribe")
      .send({ webhook_url: WEBHOOK_URL })
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("returns 400 when contract_id is not a valid Stellar contract ID", async () => {
    const res = await request(app)
      .post("/api/webhooks/subscribe")
      .send({ contract_id: "hello", webhook_url: WEBHOOK_URL })
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("returns 400 when webhook_url is missing", async () => {
    const res = await request(app)
      .post("/api/webhooks/subscribe")
      .send({ contract_id: VALID_CONTRACT })
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("returns 404 when contract is valid but not indexed", async () => {
    const res = await request(app)
      .post("/api/webhooks/subscribe")
      .send({ contract_id: UNMONITORED_CONTRACT, webhook_url: WEBHOOK_URL })
      .expect(404);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("Contract is not indexed");
  });

  it("accepts '*' event_types", async () => {
    const res = await request(app)
      .post("/api/webhooks/subscribe")
      .send({ ...VALID_BODY, event_types: "*" })
      .expect(200);

    expect(res.body.success).toBe(true);
  });

  it("accepts missing event_types (defaults to all)", async () => {
    const res = await request(app)
      .post("/api/webhooks/subscribe")
      .send({ contract_id: VALID_BODY.contract_id, webhook_url: WEBHOOK_URL })
      .expect(200);

    expect(res.body.success).toBe(true);
  });
});

describe("POST /api/webhooks/unsubscribe – HTTP", () => {
  let app: express.Express;
  const ADMIN_KEY = "webhooks-test-admin-key";
  const originalAdminKey = process.env.ADMIN_API_KEY;

  beforeAll(async () => {
    const { default: router } = await import("../src/routes/webhooks.js");
    app = express();
    app.use(express.json());
    // #604: credential attached centrally; the 401 paths live in
    // webhook-subscribe-auth.test.ts.
    app.use((req, _res, next) => {
      req.headers["x-api-key"] = ADMIN_KEY;
      next();
    });
    app.use("/api/webhooks", router);
  });

  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    testDb.exec("DELETE FROM webhook_subscriptions");
  });

  afterEach(() => {
    if (originalAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalAdminKey;
  });

  it("returns 200 on successful unsubscribe", async () => {
    addSubscription(
      "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901",
      "https://example.com/hook",
      ["funded"]
    );

    const res = await request(app)
      .post("/api/webhooks/unsubscribe")
      .send({
        contract_id: "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901",
        webhook_url: "https://example.com/hook",
      })
      .expect(200);

    expect(res.body.success).toBe(true);
  });

  it("returns 404 for non-existent subscription", async () => {
    const res = await request(app)
      .post("/api/webhooks/unsubscribe")
      .send({
        contract_id: "CNONEXISTENT",
        webhook_url: "https://example.com/hook",
      })
      .expect(404);

    expect(res.body.success).toBe(false);
  });
});

describe("Webhook delivery", () => {
  const CONTRACT_A = "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";
  const WEBHOOK_URL = "https://webhook-test.local/event";

  let mockFetch: jest.Mock<(...args: any[]) => any>;

  beforeAll(() => {
    mockFetch = jest.fn();
    (global as any).fetch = mockFetch;
  });

  beforeEach(() => {
    mockFetch.mockReset();
    testDb.exec("DELETE FROM webhook_subscriptions");
    testDb.exec("DELETE FROM events");
  });

  afterAll(() => {
    delete (global as any).fetch;
  });

  it("delivers webhooks for matching events", async () => {
    mockFetch.mockResolvedValue({ ok: true });

    addSubscription(CONTRACT_A, WEBHOOK_URL, ["funded"]);
    insertEvent(CONTRACT_A, "funded", 100, 1000, JSON.stringify({ client: "GCLIENT" }));
    insertEvent(CONTRACT_A, "approved", 101, 2000, JSON.stringify({ client: "GCLIENT" }));

    const { deliverWebhooks } = await import("../src/indexer/webhook-delivery.js");
    const results = await deliverWebhooks(100, 102);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].webhookUrl).toBe(WEBHOOK_URL);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.event_type).toBe("funded");
    expect(callBody.contract_id).toBe(CONTRACT_A);
  });

  it("does not deliver if no subscriptions match", async () => {
    mockFetch.mockResolvedValue({ ok: true });

    insertEvent(CONTRACT_A, "funded", 100, 1000, JSON.stringify({ client: "GCLIENT" }));

    const { deliverWebhooks } = await import("../src/indexer/webhook-delivery.js");
    const results = await deliverWebhooks(100, 100);

    expect(results).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("retries up to 3 times on failure", async () => {
    mockFetch.mockResolvedValue({ ok: false });

    addSubscription(CONTRACT_A, WEBHOOK_URL, ["funded"]);
    insertEvent(CONTRACT_A, "funded", 100, 1000, JSON.stringify({ client: "GCLIENT" }));

    const { deliverWebhooks } = await import("../src/indexer/webhook-delivery.js");
    const results = await deliverWebhooks(100, 100);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].attempts).toBe(3);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("succeeds on second attempt after first fails", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    addSubscription(CONTRACT_A, WEBHOOK_URL, ["funded"]);
    insertEvent(CONTRACT_A, "funded", 100, 1000, JSON.stringify({ client: "GCLIENT" }));

    const { deliverWebhooks } = await import("../src/indexer/webhook-delivery.js");
    const results = await deliverWebhooks(100, 100);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].attempts).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("delivers to multiple subscribers for same event", async () => {
    mockFetch.mockResolvedValue({ ok: true });

    const URL_A = "https://first.local/hook";
    const URL_B = "https://second.local/hook";

    addSubscription(CONTRACT_A, URL_A, ["funded"]);
    addSubscription(CONTRACT_A, URL_B, ["funded"]);
    insertEvent(CONTRACT_A, "funded", 100, 1000, JSON.stringify({ client: "GCLIENT" }));

    const { deliverWebhooks } = await import("../src/indexer/webhook-delivery.js");
    const results = await deliverWebhooks(100, 100);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.success)).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("includes payload version 1 in the envelope (#710)", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    addSubscription(CONTRACT_A, WEBHOOK_URL, ["funded"]);
    insertEvent(CONTRACT_A, "funded", 100, 1000, JSON.stringify({ client: "GCLIENT" }));

    const { deliverWebhooks, WEBHOOK_PAYLOAD_VERSION } = await import("../src/indexer/webhook-delivery.js");
    await deliverWebhooks(100, 100);

    expect(WEBHOOK_PAYLOAD_VERSION).toBe(1);
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.version).toBe(1);
    expect(callBody.data).toEqual({ client: "GCLIENT" });
  });

  it("reports HTTP status 503 from a failing attempt (#711)", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    addSubscription(CONTRACT_A, WEBHOOK_URL, ["funded"]);
    insertEvent(CONTRACT_A, "funded", 100, 1000, JSON.stringify({ client: "GCLIENT" }));

    const { deliverWebhooks } = await import("../src/indexer/webhook-delivery.js");
    const results = await deliverWebhooks(100, 100);

    expect(results[0].success).toBe(false);
    expect(results[0].status).toBe(503);
    expect(results[0].errorCode).toBe("HTTP_503");
    expect(typeof results[0].durationMs).toBe("number");
  });

  it("reports the DNS error code when fetch rejects with ENOTFOUND (#711)", async () => {
    const dnsErr = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND webhook-test.local"), {
        code: "ENOTFOUND",
      }),
    });
    mockFetch.mockRejectedValue(dnsErr);

    addSubscription(CONTRACT_A, WEBHOOK_URL, ["funded"]);
    insertEvent(CONTRACT_A, "funded", 100, 1000, JSON.stringify({ client: "GCLIENT" }));

    const { deliverWebhooks } = await import("../src/indexer/webhook-delivery.js");
    const results = await deliverWebhooks(100, 100);

    expect(results[0].success).toBe(false);
    expect(results[0].status).toBeUndefined();
    expect(results[0].errorCode).toBe("ENOTFOUND");
  });
});
