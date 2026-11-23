import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import request from "supertest";
import express from "express";
import { runMigrations, setDb, addSubscription, insertEvent } from "../src/indexer/db.js";
import { webhookDeliveryId } from "../src/indexer/webhook-delivery.js";

process.env.ADMIN_API_KEY = "test-admin-key";

jest.unstable_mockModule("../src/indexer/poller.js", () => ({
  getConsecutiveFailures: jest.fn(() => 0),
  getLastSuccessfulPollAt: jest.fn(() => Date.now()),
  getCurrentPollIntervalMs: jest.fn(() => 15000),
  getLatestLedgerSequence: jest.fn(async () => 1),
  fetchHistoricalEvents: jest.fn(),
  validateHistoricalRange: jest.fn(),
}));

const CONTRACT = "CARZQMYKDGA4TTIE2XBDJ42EX27VYLLJGGG4WGUIXXWIVHPDTX3UCLJA";

describe("GET /api/admin/webhook-subscriptions/:id/deliveries (#941)", () => {
  let db: Database.Database;
  let app: express.Express;
  let subId: number;
  let otherSubId: number;
  const statuses = ["delivered", "failed", "dead", "delivered", "failed"];

  const get = (path: string) =>
    request(app).get(path).set("x-api-key", "test-admin-key");

  beforeAll(async () => {
    db = new Database(":memory:");
    setDb(db);
    runMigrations();
    subId = addSubscription(CONTRACT, "https://hooks.example.com/in?token=secret", ["funded"]).id;
    otherSubId = addSubscription(CONTRACT, "https://other.example.com/in", ["funded"]).id;

    statuses.forEach((status, i) => {
      insertEvent(CONTRACT, "funded", 100 + i, 1000 + i, "{}", `evt-${i}`);
      const eventRowId = (db.prepare("SELECT id FROM events WHERE event_id = ?").get(`evt-${i}`) as { id: number }).id;
      db.prepare(
        "INSERT INTO webhook_deliveries (subscription_id, event_id, status, attempts, last_error) VALUES (?, ?, ?, ?, ?)"
      ).run(subId, eventRowId, status, i + 1, status === "delivered" ? null : "boom");
    });
    db.prepare(
      "INSERT INTO webhook_deliveries (subscription_id, event_id, status) VALUES (?, 1, 'dead')"
    ).run(otherSubId);

    const { default: router } = await import("../src/routes/admin.js");
    app = express();
    app.use(express.json());
    app.use("/api/admin", router);
  });

  afterAll(() => db.close());

  it("returns 404 for an unknown subscription", async () => {
    await get("/api/admin/webhook-subscriptions/9999/deliveries").expect(404);
    await get("/api/admin/webhook-subscriptions/abc/deliveries").expect(404);
  });

  it("requires admin auth", async () => {
    await request(app).get(`/api/admin/webhook-subscriptions/${subId}/deliveries`).expect(401);
  });

  it("lists only this subscription's deliveries, newest first, with event join and delivery id", async () => {
    const res = await get(`/api/admin/webhook-subscriptions/${subId}/deliveries`).expect(200);
    const ids = res.body.deliveries.map((d: { id: number }) => d.id);
    expect(ids).toHaveLength(5);
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);

    const newest = res.body.deliveries[0];
    expect(newest).toMatchObject({
      status: "failed",
      eventType: "funded",
      ledgerSequence: 104,
      eventId: "evt-4",
    });
    const eventRowId = (db.prepare("SELECT id FROM events WHERE event_id = 'evt-4'").get() as { id: number }).id;
    expect(newest.deliveryId).toBe(webhookDeliveryId(subId, eventRowId));
    expect(res.body.nextBefore).toBeNull();
  });

  it("masks the webhook URL query string", async () => {
    const res = await get(`/api/admin/webhook-subscriptions/${subId}/deliveries`).expect(200);
    expect(res.body.subscription.webhook_url).toBe("https://hooks.example.com/in?***");
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });

  it("filters by status and rejects an unknown status", async () => {
    const res = await get(`/api/admin/webhook-subscriptions/${subId}/deliveries?status=delivered`).expect(200);
    expect(res.body.deliveries).toHaveLength(2);
    expect(res.body.deliveries.every((d: { status: string }) => d.status === "delivered")).toBe(true);
    await get(`/api/admin/webhook-subscriptions/${subId}/deliveries?status=nope`).expect(400);
  });

  it("paginates with keyset cursor via limit and before", async () => {
    const page1 = await get(`/api/admin/webhook-subscriptions/${subId}/deliveries?limit=2`).expect(200);
    expect(page1.body.deliveries).toHaveLength(2);
    expect(page1.body.nextBefore).toBe(page1.body.deliveries[1].id);

    const page2 = await get(
      `/api/admin/webhook-subscriptions/${subId}/deliveries?limit=2&before=${page1.body.nextBefore}`
    ).expect(200);
    expect(page2.body.deliveries).toHaveLength(2);
    expect(page2.body.deliveries[0].id).toBeLessThan(page1.body.deliveries[1].id);

    const page3 = await get(
      `/api/admin/webhook-subscriptions/${subId}/deliveries?limit=2&before=${page2.body.nextBefore}`
    ).expect(200);
    expect(page3.body.deliveries).toHaveLength(1);
    expect(page3.body.nextBefore).toBeNull();
  });

  it("rejects invalid limit and before", async () => {
    await get(`/api/admin/webhook-subscriptions/${subId}/deliveries?limit=0`).expect(400);
    await get(`/api/admin/webhook-subscriptions/${subId}/deliveries?limit=201`).expect(400);
    await get(`/api/admin/webhook-subscriptions/${subId}/deliveries?before=x`).expect(400);
  });
});
