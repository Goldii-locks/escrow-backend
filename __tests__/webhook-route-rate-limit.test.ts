/**
 * Dedicated rate limit for the webhook subscription mutations (#604).
 *
 * The shared general limiter is one bucket for every client, so it neither
 * caps abuse of these two routes nor protects them from a caller who burns
 * the shared budget. Both routes therefore mount `webhookLimiter`, whose
 * budget is configured with WEBHOOK_RATE_LIMIT_MAX.
 *
 * The limiter reads its configuration at import time, so this suite sets the
 * environment before its first dynamic import of the module graph and never
 * imports routes/webhooks.js statically. NODE_ENV is lifted from "test"
 * (where the limiters are disabled so suites are not throttled) to exercise
 * the real limiting path.
 */

import Database from "better-sqlite3";
import request from "supertest";
import express from "express";

// A valid contract id: subscribe now rejects malformed ids and contracts the
// indexer does not monitor (#641), so the tests register it first.
const CONTRACT =
  "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";
const ADMIN_KEY = "webhook-rate-limit-admin-key";

const ORIGINAL_ENV = { ...process.env };

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("webhook mutation rate limit (#604)", () => {
  it("caps subscribe and unsubscribe with the dedicated limiter", async () => {
    process.env.NODE_ENV = "development";
    process.env.WEBHOOK_RATE_LIMIT_MAX = "2";
    process.env.ADMIN_API_KEY = ADMIN_KEY;

    const testDb = new Database(":memory:");
    const db = await import("../src/indexer/db.js");
    db.setDb(testDb);
    db.initSchema();
    db.registerContract(CONTRACT, "test contract");

    const { default: router } = await import("../src/routes/webhooks.js");

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.headers["x-api-key"] = ADMIN_KEY;
      next();
    });
    app.use("/api/webhooks", router);

    const subscribeBody = {
      contract_id: CONTRACT,
      webhook_url: "https://example.com/hook",
      event_types: ["fund"],
    };

    // First two requests fit the budget.
    await request(app).post("/api/webhooks/subscribe").send(subscribeBody).expect(200);
    await request(app)
      .post("/api/webhooks/unsubscribe")
      .send({
        contract_id: subscribeBody.contract_id,
        webhook_url: subscribeBody.webhook_url,
      })
      .expect(200);

    // Third request is over the dedicated budget, even though it would
    // otherwise be a perfectly valid unsubscribe.
    const limited = await request(app)
      .post("/api/webhooks/unsubscribe")
      .send({
        contract_id: subscribeBody.contract_id,
        webhook_url: subscribeBody.webhook_url,
      })
      .expect(429);

    expect(limited.body).toEqual({
      success: false,
      error: "Too many requests, please try again later",
    });

    // And subscribe shares the same dedicated budget.
    await request(app).post("/api/webhooks/subscribe").send(subscribeBody).expect(429);

    testDb.close();
  });
});
