import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";

const VALID_CONTRACT = "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";
const VALID_ADDRESS = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";

const mockGetAccount = jest.fn<() => Promise<unknown>>();
const mockPrepareTransaction = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getAccount = mockGetAccount;
    prepareTransaction = mockPrepareTransaction;
  },
}));

const { default: router } = await import("../src/routes/jobs.js");
const { resetPartialReleaseRateLimitBuckets } = await import(
  "../src/middleware/job-contract-rate-limit.js"
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", router);
  return app;
}

const ENDPOINT = `/api/jobs/${VALID_CONTRACT}/milestones/0/partial-release`;
const VALID_BODY = { amount: "100", sourceAddress: VALID_ADDRESS };

describe("POST /api/jobs/:contractId/milestones/:index/partial-release", () => {
  beforeEach(() => {
    mockGetAccount.mockReset();
    mockPrepareTransaction.mockReset();
    resetPartialReleaseRateLimitBuckets();

    mockGetAccount.mockResolvedValue({
      accountId: () => VALID_ADDRESS,
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    });
  });

  // ── params validation ──────────────────────────────────────────────────────

  it("returns 400 for an invalid contractId", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/not-a-valid-contract/milestones/0/partial-release")
      .send(VALID_BODY)
      .expect(400);
    expect(res.body).toMatchObject({ success: false, error: expect.any(String) });
  });

  it("returns 400 when contractId is a G... account address", async () => {
    const res = await request(buildApp())
      .post(`/api/jobs/${VALID_ADDRESS}/milestones/0/partial-release`)
      .send(VALID_BODY)
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/valid Stellar contract address/i);
  });

  it("returns 400 for a non-numeric index", async () => {
    const res = await request(buildApp())
      .post(`/api/jobs/${VALID_CONTRACT}/milestones/abc/partial-release`)
      .send(VALID_BODY)
      .expect(400);
    expect(res.body).toEqual({
      success: false,
      error: "index must be a non-negative integer",
    });
  });

  it("returns 400 for a decimal index", async () => {
    const res = await request(buildApp())
      .post(`/api/jobs/${VALID_CONTRACT}/milestones/1.5/partial-release`)
      .send(VALID_BODY)
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  // ── body validation ────────────────────────────────────────────────────────

  it("returns 400 when amount is missing", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ sourceAddress: VALID_ADDRESS })
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 when amount is zero", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ amount: "0", sourceAddress: VALID_ADDRESS })
      .expect(400);
    expect(res.body).toEqual({
      success: false,
      error: "amount must be a positive integer",
    });
  });

  it("returns 400 when amount is negative", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ amount: "-10", sourceAddress: VALID_ADDRESS })
      .expect(400);
    expect(res.body).toEqual({
      success: false,
      error: "amount must be a positive integer",
    });
  });

  it("returns 400 when amount is a non-numeric string", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ amount: "abc", sourceAddress: VALID_ADDRESS })
      .expect(400);
    expect(res.body).toEqual({
      success: false,
      error: "amount must be a positive integer",
    });
  });

  it("returns 400 when amount is a decimal", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ amount: "1.5", sourceAddress: VALID_ADDRESS })
      .expect(400);
    expect(res.body).toEqual({
      success: false,
      error: "amount must be a positive integer",
    });
  });

  it("returns 400 when sourceAddress is missing", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ amount: "100" })
      .expect(400);
    expect(res.body).toEqual({
      success: false,
      error: "sourceAddress is required",
    });
  });

  it("returns 400 when sourceAddress is not a valid Stellar account address", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ amount: "100", sourceAddress: "not-a-stellar-address" })
      .expect(400);
    expect(res.body).toEqual({
      success: false,
      error: "sourceAddress must be a valid Stellar account address (G...)",
    });
  });

  it("returns 400 when sourceAddress is a contract address (C...)", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ amount: "100", sourceAddress: VALID_CONTRACT })
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/valid Stellar account address/i);
  });

  // ── success path ──────────────────────────────────────────────────────────

  it("returns 200 with XDR on valid input", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send(VALID_BODY)
      .expect(200);
    expect(res.body).toEqual({ success: true, xdr: "AAAAAQ==" });
  });

  it("accepts amount provided as a JSON number", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ amount: 100, sourceAddress: VALID_ADDRESS })
      .expect(200);
    expect(res.body.success).toBe(true);
  });

  // ── error path ────────────────────────────────────────────────────────────

  it("returns 500 when getAccount throws", async () => {
    mockGetAccount.mockRejectedValue(new Error("account not found"));
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send(VALID_BODY)
      .expect(500);
    expect(res.body.success).toBe(false);
  });

  it("returns 500 when prepareTransaction throws", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("RPC failure"));
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send(VALID_BODY)
      .expect(500);
    expect(res.body.success).toBe(false);
  });

  // ── rate limiting ─────────────────────────────────────────────────────────

  describe("rate limiting", () => {
    const originalMax = process.env.PARTIAL_RELEASE_RATE_MAX;
    const originalWindow = process.env.PARTIAL_RELEASE_RATE_WINDOW_MS;

    beforeEach(() => {
      resetPartialReleaseRateLimitBuckets();
      process.env.PARTIAL_RELEASE_RATE_MAX = "3";
      process.env.PARTIAL_RELEASE_RATE_WINDOW_MS = "60000";
      mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });
    });

    afterEach(() => {
      resetPartialReleaseRateLimitBuckets();
      if (originalMax === undefined) {
        delete process.env.PARTIAL_RELEASE_RATE_MAX;
      } else {
        process.env.PARTIAL_RELEASE_RATE_MAX = originalMax;
      }
      if (originalWindow === undefined) {
        delete process.env.PARTIAL_RELEASE_RATE_WINDOW_MS;
      } else {
        process.env.PARTIAL_RELEASE_RATE_WINDOW_MS = originalWindow;
      }
    });

    it("allows requests up to the configured threshold", async () => {
      const app = buildApp();
      for (let i = 0; i < 3; i++) {
        const res = await request(app).post(ENDPOINT).send(VALID_BODY);
        expect(res.status).not.toBe(429);
        expect(res.headers["x-ratelimit-limit"]).toBe("3");
      }
    });

    it("returns 429 once the threshold is exceeded", async () => {
      const app = buildApp();
      for (let i = 0; i < 3; i++) {
        await request(app).post(ENDPOINT).send(VALID_BODY);
      }
      const res = await request(app).post(ENDPOINT).send(VALID_BODY).expect(429);
      expect(res.body).toEqual({
        success: false,
        error: "Too many requests, please try again later",
      });
      expect(res.headers["x-ratelimit-remaining"]).toBe("0");
    });

    it("sets rate limit headers on each response", async () => {
      const app = buildApp();
      const res = await request(app).post(ENDPOINT).send(VALID_BODY);
      expect(res.headers["x-ratelimit-limit"]).toBeDefined();
      expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
      expect(res.headers["x-ratelimit-reset"]).toBeDefined();
    });
  });
});
