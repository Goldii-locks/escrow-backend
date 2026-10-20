import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";

// ---------------------------------------------------------------------------
// Mocks — installed before importing the route so the admin router picks up
// the mocked poller/db modules.
// ---------------------------------------------------------------------------

const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetEvents = jest.fn<() => Promise<{ events: unknown[] }>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getLatestLedger = mockGetLatestLedger;
    getEvents = mockGetEvents;
  },
}));

jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  scValToNative: (value: unknown) => value,
}));

const { dbModuleMock } = await import("./helpers/db-module-mock.js");
const mockGetIndexerStatusData = dbModuleMock.getIndexerStatusData as jest.Mock<
  () => {
    lastIndexedLedger: number | null;
    totalEvents: number;
    lastEventAt: string | null;
    eventsByType: Record<string, number>;
  }
>;

// The admin route only needs `getIndexerStatusData` from the db module, but
// the module is imported wholesale, so every export the route's import graph
// touches has to be present.
jest.unstable_mockModule("../src/indexer/db.js", () => dbModuleMock);

jest.unstable_mockModule("../src/indexer/reconciliation.js", () => ({
  getLatestReconciliationResults: () => ({ checkedAt: "2026-01-01T00:00:00.000Z" }),
}));

jest.unstable_mockModule("../src/indexer/status.js", () => ({
  getIndexerUptimeSeconds: () => 120,
  markIndexerStarted: jest.fn(),
}));

const adminRoutes = (await import("../src/routes/admin.js")).default;
const { resetChainHeadCache } = await import("../src/indexer/poller.js");

const KEY = "s3cret-admin-key";

function buildApp() {
  const app = express();
  app.use("/api/admin", adminRoutes);
  return app;
}

describe("GET /api/admin/indexer-status (#644)", () => {
  const originalKey = process.env.ADMIN_API_KEY;

  beforeEach(() => {
    process.env.ADMIN_API_KEY = KEY;
    resetChainHeadCache();
    mockGetLatestLedger.mockReset();
    mockGetLatestLedger.mockResolvedValue({ sequence: 150 });
    mockGetIndexerStatusData.mockClear();
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalKey;
  });

  it("responds with the standard { success, data } envelope", async () => {
    const res = await request(buildApp())
      .get("/api/admin/indexer-status")
      .set("x-api-key", KEY);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    // The old flat shape put these at the top level; they now live under data.
    expect(res.body.lastIndexedLedger).toBeUndefined();
    expect(res.body.data.lastIndexedLedger).toBe(100);
  });

  it("reports the poll-loop health signals", async () => {
    const res = await request(buildApp())
      .get("/api/admin/indexer-status")
      .set("x-api-key", KEY);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("consecutiveFailures");
    expect(res.body.data).toHaveProperty("lastSuccessfulPollAt");
    expect(res.body.data).toHaveProperty("pollIntervalMs");
    expect(res.body.data).toHaveProperty("ledgerLag");
    expect(typeof res.body.data.consecutiveFailures).toBe("number");
    expect(typeof res.body.data.pollIntervalMs).toBe("number");
  });

  it("computes ledgerLag as chain head minus last indexed ledger", async () => {
    const res = await request(buildApp())
      .get("/api/admin/indexer-status")
      .set("x-api-key", KEY);

    expect(res.status).toBe(200);
    expect(res.body.data.ledgerLag).toBe(50);
  });

  it("reports a null ledgerLag when the chain head cannot be read", async () => {
    mockGetLatestLedger.mockRejectedValue(new Error("RPC unreachable"));

    const res = await request(buildApp())
      .get("/api/admin/indexer-status")
      .set("x-api-key", KEY);

    expect(res.status).toBe(200);
    expect(res.body.data.ledgerLag).toBeNull();
  });

  it("still requires the admin key", async () => {
    const res = await request(buildApp()).get("/api/admin/indexer-status");
    expect(res.status).toBe(401);
  });
});
