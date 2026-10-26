/**
 * HTTP coverage for the subscribe-time SSRF guard (#605).
 *
 * A subscriber-supplied URL is stored and later POSTed to from wherever the
 * poller runs, so subscribe has to refuse internal targets before the record
 * exists. Delivery re-checks the resolved address; that half is covered in
 * webhook-ssrf-delivery.test.ts and webhook-url-guard.test.ts.
 */

import Database from "better-sqlite3";
import request from "supertest";
import express from "express";
import {
  initSchema,
  registerContract,
  setDb,
  getSubscriptions,
} from "../src/indexer/db.js";

const KEY = "webhook-ssrf-test-admin-key";
// A valid contract id: subscribe now rejects malformed ids and contracts the
// indexer does not monitor (#641), so the tests register it first.
const CONTRACT =
  "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";

let testDb: Database.Database;
let app: express.Express;

const originalAdminKey = process.env.ADMIN_API_KEY;

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
  if (originalAdminKey === undefined) delete process.env.ADMIN_API_KEY;
  else process.env.ADMIN_API_KEY = originalAdminKey;
  testDb.close();
});

beforeEach(() => {
  process.env.ADMIN_API_KEY = KEY;
  testDb.exec("DELETE FROM webhook_subscriptions");
  registerContract(CONTRACT, "test contract");
});

afterEach(() => {
  if (originalAdminKey === undefined) delete process.env.ADMIN_API_KEY;
  else process.env.ADMIN_API_KEY = originalAdminKey;
});

function subscribe(webhookUrl: string) {
  return request(app)
    .post("/api/webhooks/subscribe")
    .set("x-api-key", KEY)
    .send({
      contract_id: CONTRACT,
      webhook_url: webhookUrl,
      event_types: ["funded"],
    });
}

describe("POST /api/webhooks/subscribe - SSRF guard (#605)", () => {
  it("rejects the cloud metadata address", async () => {
    const res = await subscribe("http://169.254.169.254/latest/meta-data/").expect(
      400
    );

    expect(res.body.success).toBe(false);
    expect(getSubscriptions()).toHaveLength(0);
  });

  it("rejects loopback, private and link-local hosts", async () => {
    for (const url of [
      "http://127.0.0.1:3001/hook",
      "https://10.0.0.5/hook",
      "https://172.16.4.4/hook",
      "https://192.168.1.20/hook",
      "https://[::1]/hook",
      "https://[fe80::1]/hook",
      "http://localhost/hook",
    ]) {
      await subscribe(url).expect(400);
    }

    expect(getSubscriptions()).toHaveLength(0);
  });

  it("rejects non-http schemes", async () => {
    const res = await subscribe("file:///etc/passwd").expect(400);
    expect(res.body.success).toBe(false);
    expect(getSubscriptions()).toHaveLength(0);
  });

  it("still accepts a public https URL", async () => {
    const res = await subscribe("https://example.com/hook").expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.subscription.webhook_url).toBe(
      "https://example.com/hook"
    );
    expect(getSubscriptions()).toHaveLength(1);
  });
});
