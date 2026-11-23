import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import request from "supertest";
import express from "express";
import { initSchema, setDb } from "../src/indexer/db.js";
import { markIndexerStarted } from "../src/indexer/status.js";

process.env.ADMIN_API_KEY = "test-admin-key";

let testDb: Database.Database;

jest.unstable_mockModule("../src/indexer/poller.js", () => {
  let failureCount = 0;
  return {
    getConsecutiveFailures: jest.fn(() => failureCount),
    getLastSuccessfulPollAt: jest.fn(() => Date.now()),
    getCurrentPollIntervalMs: jest.fn(() => 15000),
    getLatestLedgerSequence: jest.fn(async () => 1050),
    // Other admin routes import these; the status route never calls them.
    fetchHistoricalEvents: jest.fn(),
    validateHistoricalRange: jest.fn(),
    simulatePollFailure: jest.fn(() => {
      failureCount += 1;
    }),
  };
});

describe("GET /api/admin/indexer-status", () => {
  let app: express.Express;
  let simulatePollFailure: () => void;

  beforeAll(async () => {
    testDb = new Database(":memory:");
    setDb(testDb);
    markIndexerStarted();
    initSchema();
    const pollerMod = (await import("../src/indexer/poller.js")) as unknown as {
      simulatePollFailure: () => void;
    };
    simulatePollFailure = pollerMod.simulatePollFailure;
    const { default: router } = await import("../src/routes/admin.js");
    app = express();
    app.use(express.json());
    app.use("/api/admin", router);
  });

  afterAll(() => {
    testDb.close();
  });

  beforeEach(() => {
    testDb.exec("DELETE FROM events");
    testDb.exec("DELETE FROM indexer_state");
    testDb.exec("DELETE FROM reconciliation_results");
    testDb.exec("DELETE FROM monitored_contracts");
  });

  it("returns the standard envelope with poller health fields", async () => {
    const res = await request(app)
      .get("/api/admin/indexer-status")
      .set("x-api-key", "test-admin-key")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();

    const d = res.body.data;
    expect(typeof d.lastIndexedLedger).toBe("number");
    expect(typeof d.totalEvents).toBe("number");
    expect(typeof d.uptimeSeconds).toBe("number");
    expect(typeof d.consecutiveFailures).toBe("number");
    expect(typeof d.lastSuccessfulPollAt).toBe("number");
    expect(typeof d.pollIntervalMs).toBe("number");
    expect(typeof d.ledgerLag).toBe("number");
    // ledgerLag = chain head (1050) - lastIndexedLedger (0)
    expect(d.ledgerLag).toBe(1050);
  });

  it("consecutiveFailures increases after a mocked poll failure", async () => {
    const res1 = await request(app)
      .get("/api/admin/indexer-status")
      .set("x-api-key", "test-admin-key")
      .expect(200);
    expect(res1.body.data.consecutiveFailures).toBe(0);

    // Simulate a poll failure.
    simulatePollFailure();

    const res2 = await request(app)
      .get("/api/admin/indexer-status")
      .set("x-api-key", "test-admin-key")
      .expect(200);
    expect(res2.body.data.consecutiveFailures).toBe(1);
  });
});
