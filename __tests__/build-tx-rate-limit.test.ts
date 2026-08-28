import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";

const mockGetAccount = jest.fn<() => Promise<unknown>>();
const mockPrepareTransaction = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getAccount = mockGetAccount;
    prepareTransaction = mockPrepareTransaction;
  },
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { resetBuildTxRateLimitBuckets } = await import("../src/middleware/job-contract-rate-limit.js");
const { default: router } = await import("../src/routes/jobs.js");

const app = express();
app.use(express.json());
app.use("/api/jobs", router);

const VALID_BODY = {
  contractId: "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH",
  method: "fund_job",
  args: [],
  sourceAddress: "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
};

describe("POST /api/jobs/build-tx – rate limiting", () => {
  const originalMax = process.env.BUILD_TX_RATE_MAX;
  const originalWindow = process.env.BUILD_TX_RATE_WINDOW_MS;

  beforeEach(() => {
    resetBuildTxRateLimitBuckets();
    process.env.BUILD_TX_RATE_MAX = "3";
    process.env.BUILD_TX_RATE_WINDOW_MS = "60000";
    
    mockGetAccount.mockReset();
    mockPrepareTransaction.mockReset();

    mockGetAccount.mockResolvedValue({
      accountId: () => VALID_BODY.sourceAddress,
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    });
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });
  });

  afterEach(() => {
    resetBuildTxRateLimitBuckets();
    if (originalMax === undefined) {
      delete process.env.BUILD_TX_RATE_MAX;
    } else {
      process.env.BUILD_TX_RATE_MAX = originalMax;
    }
    if (originalWindow === undefined) {
      delete process.env.BUILD_TX_RATE_WINDOW_MS;
    } else {
      process.env.BUILD_TX_RATE_WINDOW_MS = originalWindow;
    }
  });

  it("allows requests up to the configured threshold", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post("/api/jobs/build-tx").send(VALID_BODY);
      expect(res.status).toBe(200);
      expect(res.headers["x-ratelimit-limit"]).toBe("3");
    }
  });

  it("returns 429 once the threshold is exceeded", async () => {
    for (let i = 0; i < 3; i++) {
      await request(app).post("/api/jobs/build-tx").send(VALID_BODY);
    }

    const res = await request(app).post("/api/jobs/build-tx").send(VALID_BODY).expect(429);

    expect(res.body).toEqual({
      success: false,
      error: "Too many requests, please try again later",
    });
    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
  });
});
