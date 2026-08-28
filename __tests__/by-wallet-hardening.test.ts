import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { resetByWalletRateLimitBuckets, walletLookupLimiter } from "../src/middleware/rateLimiter.js";

const mockGetJobsByWallet = jest.fn();
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.unstable_mockModule("../src/indexer/db.js", () => ({
  getJobsByWallet: mockGetJobsByWallet,
  getEventsByContract: jest.fn(),
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: mockLogger,
}));

process.env.NODE_ENV = "test";

const { default: router } = await import("../src/routes/jobs.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", router);
  return app;
}

describe("GET /api/jobs/by-wallet/:address – hardening", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetByWalletRateLimitBuckets();
    mockGetJobsByWallet.mockReset();
    mockGetJobsByWallet.mockReturnValue({ total: 1, jobs: [{ contract_id: "C1" }], page: 1, limit: 10 });
  });

  it("logs the address on success", async () => {
    await request(buildApp())
      .get("/api/jobs/by-wallet/GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX")
      .expect(200);

    // Cast mock.calls to the expected tuple type to satisfy TypeScript
    const infoEntries = mockLogger.info.mock.calls as unknown as [string, Record<string, unknown>][];
    expect(infoEntries.some(([message]) => message === "Jobs lookup completed")).toBe(true);
    expect(infoEntries.some(([, meta]) => (meta as any).address === "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX")).toBe(true);
  });

  it("logs the address on error", async () => {
    mockGetJobsByWallet.mockImplementation(() => {
      throw new Error("boom");
    });

    await request(buildApp())
      .get("/api/jobs/by-wallet/GB5CRPXUGXZCG6BESL4CM4F3VUAGQGFNYNBHPBRJAGLXXSRYJSEGZHUV")
      .expect(500);

    const errorEntries = mockLogger.error.mock.calls as unknown as [string, Record<string, unknown>][];
    expect(errorEntries.some(([message]) => message === "Jobs lookup failed")).toBe(true);
    expect(errorEntries.some(([, meta]) => (meta as any).address === "GB5CRPXUGXZCG6BESL4CM4F3VUAGQGFNYNBHPBRJAGLXXSRYJSEGZHUV")).toBe(true);
  });

  it("returns 429 after exceeding the request threshold", async () => {
    process.env.BY_WALLET_RATE_LIMIT_MAX = "1";

    const app = express();
    app.get("/test", walletLookupLimiter, (_req, res) => {
      res.json({ success: true });
    });

    const first = await request(app).get("/test");
    expect(first.status).toBe(200);

    const second = await request(app).get("/test");
    expect(second.status).toBe(429);
    expect(second.body).toEqual({ success: false, error: "Too many requests, please try again later" });
  });

  it("resets the rate limit window after the window elapses", async () => {
    process.env.BY_WALLET_RATE_LIMIT_MAX = "1";
    jest.useFakeTimers();
    try {
      const app = express();
      app.get("/test", walletLookupLimiter, (_req, res) => {
        res.json({ success: true });
      });

      const first = await request(app).get("/test");
      expect(first.status).toBe(200);

      jest.advanceTimersByTime(60_001);

      const second = await request(app).get("/test");
      expect(second.status).toBe(200);
    } finally {
      jest.useRealTimers();
    }
  });
});
