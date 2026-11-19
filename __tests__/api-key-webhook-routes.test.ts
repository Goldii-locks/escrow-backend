import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { requireApiKey } from "../src/middleware/apiKeyAuth.js";

const dispatchSubscribe = jest.fn((_input: unknown, _traceId: string) => subscribeResult);
const dispatchUnsubscribe = jest.fn((_input: unknown, _traceId: string) => unsubscribeResult);

let subscribeResult: any = { ok: true, subscription: { id: 1 }, traceId: "trace-1" };
let unsubscribeResult: any = { ok: true, traceId: "trace-2" };

jest.unstable_mockModule("../src/utils/webhook_dispatcher.js", () => ({
  dispatchSubscribe,
  dispatchUnsubscribe,
}));

const CONTRACT = "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";

describe("requireApiKey (#949)", () => {
  const originalKeys = process.env.API_KEYS;
  const originalKey = process.env.API_KEY;
  const app = express();
  app.get("/protected", requireApiKey, (_req, res) => res.json({ ok: true }));

  beforeEach(() => {
    delete process.env.API_KEY;
    process.env.API_KEYS = "first-key, second-key,third-key";
  });

  afterAll(() => {
    if (originalKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = originalKeys;
    if (originalKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = originalKey;
  });

  it("rejects a request with no key", async () => {
    const res = await request(app).get("/protected").expect(401);
    expect(res.body).toEqual({ success: false, error: "Unauthorized" });
  });

  it("rejects a wrong key", async () => {
    await request(app).get("/protected").set("x-api-key", "wrong").expect(401);
  });

  it("accepts an x-api-key header", async () => {
    const res = await request(app).get("/protected").set("x-api-key", "first-key").expect(200);
    expect(res.body.ok).toBe(true);
  });

  it("accepts an Authorization: Bearer token", async () => {
    await request(app)
      .get("/protected")
      .set("Authorization", "Bearer second-key")
      .expect(200);
  });

  it("accepts every key in a comma-separated API_KEYS list", async () => {
    for (const key of ["first-key", "second-key", "third-key"]) {
      await request(app).get("/protected").set("x-api-key", key).expect(200);
    }
    await request(app)
      .get("/protected")
      .set("x-api-key", " first-key ")
      .expect(200);
  });
});

describe("GET /api/webhooks/subscriptions and mutation failure paths (#949)", () => {
  let app: express.Express;
  let testDb: Database.Database;
  const originalKeys = process.env.API_KEYS;
  const originalKey = process.env.API_KEY;
  const originalAdminKey = process.env.ADMIN_API_KEY;

  beforeAll(async () => {
    process.env.API_KEYS = "listing-key";
    process.env.ADMIN_API_KEY = "mutation-key";
    testDb = new Database(":memory:");
    const { setDb, runMigrations } = await import("../src/indexer/db.js");
    setDb(testDb);
    runMigrations();
    const { default: webhookRoutes } = await import("../src/routes/webhooks.js");
    app = express();
    app.use(express.json());
    app.use("/api/webhooks", webhookRoutes);
  });

  afterAll(() => {
    testDb.close();
    if (originalKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = originalKeys;
    if (originalKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = originalKey;
    if (originalAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalAdminKey;
  });

  beforeEach(async () => {
    testDb.exec("DELETE FROM webhook_subscriptions");
    dispatchSubscribe.mockClear();
    dispatchUnsubscribe.mockClear();
    subscribeResult = { ok: true, subscription: { id: 1 }, traceId: "trace-1" };
    unsubscribeResult = { ok: true, traceId: "trace-2" };
  });

  function insertSubscription(webhookUrl: string, eventTypes: string): void {
    testDb
      .prepare(
        `INSERT INTO webhook_subscriptions (contract_id, webhook_url, event_types)
         VALUES (?, ?, ?)`
      )
      .run(CONTRACT, webhookUrl, eventTypes);
  }

  it("requires the API key for the listing route", async () => {
    await request(app).get("/api/webhooks/subscriptions").expect(401);
    await request(app)
      .get("/api/webhooks/subscriptions")
      .set("x-api-key", "wrong")
      .expect(401);
  });

  it("masks secrets in the query string of a stored URL", async () => {
    insertSubscription("https://example.com/hook?token=secret&x=1", '["fund"]');
    const res = await request(app)
      .get("/api/webhooks/subscriptions")
      .query({ contract_id: CONTRACT })
      .set("x-api-key", "listing-key")
      .expect(200);

    const url = res.body.data.subscriptions[0].webhook_url;
    expect(url).not.toContain("token");
    expect(url).not.toContain("secret");
    expect(url).toContain("https://example.com/hook");
  });

  it("falls back to string stripping for an unparsable stored URL", async () => {
    insertSubscription("not a url?token=secret", '["fund"]');
    const res = await request(app)
      .get("/api/webhooks/subscriptions")
      .query({ contract_id: CONTRACT })
      .set("x-api-key", "listing-key")
      .expect(200);

    expect(res.body.data.subscriptions[0].webhook_url).toBe("not a url");
  });

  it("parses a '*' wildcard and malformed event_types", async () => {
    insertSubscription("https://example.com/wildcard", "*");
    insertSubscription("https://example.com/broken", "{not json");

    const res = await request(app)
      .get("/api/webhooks/subscriptions")
      .query({ contract_id: CONTRACT })
      .set("x-api-key", "listing-key")
      .expect(200);

    const byUrl = new Map(
      res.body.data.subscriptions.map((s: { webhook_url: string; event_types: unknown }) => [
        s.webhook_url,
        s.event_types,
      ])
    );
    expect(byUrl.get("https://example.com/wildcard")).toEqual(["*"]);
    expect(byUrl.get("https://example.com/broken")).toEqual([]);
  });

  it("requires contract_id on the listing route", async () => {
    const res = await request(app)
      .get("/api/webhooks/subscriptions")
      .set("x-api-key", "listing-key")
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  it("forwards a dispatchSubscribe failure", async () => {
    subscribeResult = { ok: false, status: 422, error: "subscription rejected", traceId: "t" };
    const res = await request(app)
      .post("/api/webhooks/subscribe")
      .set("x-api-key", "mutation-key")
      .send({ contract_id: CONTRACT, webhook_url: "https://example.com/hook" })
      .expect(422);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("subscription rejected");
    expect(dispatchSubscribe).toHaveBeenCalledTimes(1);
  });

  it("forwards a dispatchUnsubscribe failure", async () => {
    unsubscribeResult = { ok: false, status: 404, error: "not subscribed", traceId: "t" };
    const res = await request(app)
      .post("/api/webhooks/unsubscribe")
      .set("x-api-key", "mutation-key")
      .send({ contract_id: CONTRACT, webhook_url: "https://example.com/hook" })
      .expect(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("not subscribed");
    expect(dispatchUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
