/**
 * Credential gate for the webhook subscription mutations (#604).
 *
 * POST /api/webhooks/subscribe and /unsubscribe used to be open to the
 * internet: anyone who could guess or enumerate a contract_id + webhook_url
 * pair could delete another integrator's subscription, or register
 * unlimited callback URLs and turn the backend into a request amplifier.
 * Both routes now sit behind requireAdmin, and an unauthorized request must
 * be rejected before any database read or write happens.
 */

import Database from "better-sqlite3";
import request from "supertest";
import express from "express";
import {
  initSchema,
  setDb,
  addSubscription,
  getSubscriptions,
} from "../src/indexer/db.js";

const KEY = "webhook-auth-test-admin-key";
const CONTRACT =
  "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";
const SUBSCRIBED_URL = "https://example.com/hook";
const ATTACKER_URL = "https://attacker.example/hook";

let testDb: Database.Database;
let app: express.Express;

const originalKey = process.env.ADMIN_API_KEY;

beforeAll(async () => {
  testDb = new Database(":memory:");
  setDb(testDb);
  initSchema();

  const { default: router } = await import("../src/routes/webhooks.js");
  app = express();
  app.use(express.json());
  app.use("/api/webhooks", router);
});

afterAll(() => {
  if (originalKey === undefined) delete process.env.ADMIN_API_KEY;
  else process.env.ADMIN_API_KEY = originalKey;
  testDb.close();
});

beforeEach(() => {
  process.env.ADMIN_API_KEY = KEY;
  testDb.exec("DELETE FROM webhook_subscriptions");
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.ADMIN_API_KEY;
  else process.env.ADMIN_API_KEY = originalKey;
});

describe("POST /api/webhooks/subscribe - credential required (#604)", () => {
  it("returns 401 without a credential and does not touch the database", async () => {
    const res = await request(app)
      .post("/api/webhooks/subscribe")
      .send({
        contract_id: CONTRACT,
        webhook_url: ATTACKER_URL,
        event_types: ["*"],
      })
      .expect(401);

    expect(res.body).toEqual({ success: false, error: "Unauthorized" });
    expect(getSubscriptions()).toHaveLength(0);
  });

  it("returns 401 for a wrong key and does not store the subscription", async () => {
    await request(app)
      .post("/api/webhooks/subscribe")
      .set("x-api-key", "not-the-key")
      .send({
        contract_id: CONTRACT,
        webhook_url: ATTACKER_URL,
        event_types: ["*"],
      })
      .expect(401);

    expect(getSubscriptions()).toHaveLength(0);
  });

  it("returns 401 when no admin key is configured, even if one is sent (fails closed)", async () => {
    delete process.env.ADMIN_API_KEY;

    await request(app)
      .post("/api/webhooks/subscribe")
      .set("x-api-key", KEY)
      .send({
        contract_id: CONTRACT,
        webhook_url: ATTACKER_URL,
        event_types: ["*"],
      })
      .expect(401);

    expect(getSubscriptions()).toHaveLength(0);
  });

  it("creates the subscription when the key is sent via x-api-key", async () => {
    const res = await request(app)
      .post("/api/webhooks/subscribe")
      .set("x-api-key", KEY)
      .send({
        contract_id: CONTRACT,
        webhook_url: SUBSCRIBED_URL,
        event_types: ["funded"],
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.subscription.webhook_url).toBe(SUBSCRIBED_URL);

    const subs = getSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0].contract_id).toBe(CONTRACT);
  });

  it("creates the subscription when the key is sent as a Bearer token", async () => {
    await request(app)
      .post("/api/webhooks/subscribe")
      .set("authorization", `Bearer ${KEY}`)
      .send({
        contract_id: CONTRACT,
        webhook_url: SUBSCRIBED_URL,
        event_types: ["*"],
      })
      .expect(200);

    expect(getSubscriptions()).toHaveLength(1);
  });
});

describe("POST /api/webhooks/unsubscribe - credential required (#604)", () => {
  beforeEach(() => {
    addSubscription(CONTRACT, SUBSCRIBED_URL, ["funded"]);
    expect(getSubscriptions()).toHaveLength(1);
  });

  it("returns 401 without a credential and leaves the subscription in place", async () => {
    const res = await request(app)
      .post("/api/webhooks/unsubscribe")
      .send({ contract_id: CONTRACT, webhook_url: SUBSCRIBED_URL })
      .expect(401);

    expect(res.body).toEqual({ success: false, error: "Unauthorized" });

    const subs = getSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0].webhook_url).toBe(SUBSCRIBED_URL);
  });

  it("returns 401 for a wrong key and leaves the subscription in place", async () => {
    await request(app)
      .post("/api/webhooks/unsubscribe")
      .set("x-api-key", "wrong-key")
      .send({ contract_id: CONTRACT, webhook_url: SUBSCRIBED_URL })
      .expect(401);

    expect(getSubscriptions()).toHaveLength(1);
  });

  it("removes the subscription when the key is sent via x-api-key", async () => {
    const res = await request(app)
      .post("/api/webhooks/unsubscribe")
      .set("x-api-key", KEY)
      .send({ contract_id: CONTRACT, webhook_url: SUBSCRIBED_URL })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(getSubscriptions()).toHaveLength(0);
  });

  it("removes the subscription when the key is sent as a Bearer token", async () => {
    await request(app)
      .post("/api/webhooks/unsubscribe")
      .set("authorization", `Bearer ${KEY}`)
      .send({ contract_id: CONTRACT, webhook_url: SUBSCRIBED_URL })
      .expect(200);

    expect(getSubscriptions()).toHaveLength(0);
  });
});
