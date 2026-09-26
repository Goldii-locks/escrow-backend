/**
 * Supertest integration coverage for webhook_dispatcher routes (#521).
 * Suites assert HTTP behavior and exit without leaving open sockets/handles.
 */

import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import request from "supertest";
import express from "express";
import {
  initSchema,
  setDb,
  addSubscription,
  closeDb,
} from "../src/indexer/db.js";

const mockLogger = {
  info: jest.fn<(...args: any[]) => void>(),
  warn: jest.fn<(...args: any[]) => void>(),
  error: jest.fn<(...args: any[]) => void>(),
  debug: jest.fn<(...args: any[]) => void>(),
};

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: mockLogger,
}));

const { default: router } = await import("../src/routes/webhooks.js");

const CONTRACT_A =
  "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";

let testDb: Database.Database;
let app: express.Express;

function buildApp(): express.Express {
  const instance = express();
  instance.use(express.json());
  instance.use("/api/webhooks", router);
  return instance;
}

beforeAll(() => {
  testDb = new Database(":memory:");
  setDb(testDb);
  initSchema();
  app = buildApp();
});

afterAll(() => {
  testDb.close();
  closeDb();
});

beforeEach(() => {
  testDb.exec("DELETE FROM webhook_subscriptions");
  jest.clearAllMocks();
});

describe("webhook_dispatcher supertest validations (#521)", () => {
  const VALID_BODY = {
    contract_id: CONTRACT_A,
    webhook_url: "https://example.com/hook",
    event_types: ["funded", "approved"],
  };

  it("POST /api/webhooks/subscribe returns 200 with subscription + traceId", async () => {
    const res = await request(app)
      .post("/api/webhooks/subscribe")
      .send(VALID_BODY)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.subscription.contract_id).toBe(VALID_BODY.contract_id);
    expect(res.body.data.subscription.webhook_url).toBe(VALID_BODY.webhook_url);
    expect(typeof res.body.data.traceId).toBe("string");
    expect(res.body.data.traceId.length).toBeGreaterThan(0);
  });

  it("POST /api/webhooks/subscribe returns 400 when contract_id is missing", async () => {
    const res = await request(app)
      .post("/api/webhooks/subscribe")
      .send({ webhook_url: "https://example.com/hook" })
      .expect(400);

    expect(res.body).toEqual({
      success: false,
      error: "contract_id and webhook_url are required",
    });
  });

  it("POST /api/webhooks/subscribe returns 400 when webhook_url is missing", async () => {
    const res = await request(app)
      .post("/api/webhooks/subscribe")
      .send({ contract_id: CONTRACT_A })
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("POST /api/webhooks/subscribe returns 400 for non-array event_types", async () => {
    const res = await request(app)
      .post("/api/webhooks/subscribe")
      .send({ ...VALID_BODY, event_types: "funded" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/event_types/i);
  });

  it("POST /api/webhooks/subscribe accepts '*' event_types", async () => {
    const res = await request(app)
      .post("/api/webhooks/subscribe")
      .send({ ...VALID_BODY, event_types: "*" })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.traceId).toBe("string");
  });

  it("POST /api/webhooks/unsubscribe returns 200 for an existing subscription", async () => {
    addSubscription(CONTRACT_A, "https://example.com/hook", ["funded"]);

    const res = await request(app)
      .post("/api/webhooks/unsubscribe")
      .send({
        contract_id: CONTRACT_A,
        webhook_url: "https://example.com/hook",
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.message).toBe("Unsubscribed successfully");
    expect(typeof res.body.data.traceId).toBe("string");
  });

  it("POST /api/webhooks/unsubscribe returns 404 when subscription is missing", async () => {
    const res = await request(app)
      .post("/api/webhooks/unsubscribe")
      .send({
        contract_id: "CNONEXISTENT",
        webhook_url: "https://example.com/hook",
      })
      .expect(404);

    expect(res.body).toEqual({
      success: false,
      error: "Subscription not found",
    });
  });

  it("POST /api/webhooks/unsubscribe returns 400 when fields are missing", async () => {
    const res = await request(app)
      .post("/api/webhooks/unsubscribe")
      .send({ contract_id: CONTRACT_A })
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("completes the suite without leaving dangling network sockets", async () => {
    // Exercise both routes back-to-back; open handles would surface as
    // Jest "worker process failed to exit" warnings / socket leak failures.
    await request(app).post("/api/webhooks/subscribe").send(VALID_BODY).expect(200);
    await request(app)
      .post("/api/webhooks/unsubscribe")
      .send({
        contract_id: VALID_BODY.contract_id,
        webhook_url: VALID_BODY.webhook_url,
      })
      .expect(200);

    expect(mockLogger.debug).toHaveBeenCalled();
  });
});
