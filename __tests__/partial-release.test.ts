import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { autoAuth, TEST_API_KEY } from "./helpers/api-key-helper.js";

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

const { default: router, resetPartialReleaseCache } = await import("../src/routes/jobs.js");
const { resetPartialReleaseRateLimitBuckets } = await import(
  "../src/middleware/job-contract-rate-limit.js"
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(autoAuth);
  app.use("/api/jobs", router);
  return app;
}

const ENDPOINT = `/api/jobs/${VALID_CONTRACT}/milestones/0/partial-release`;
const VALID_BODY = { amount: "100", sourceAddress: VALID_ADDRESS };

describe("POST /api/jobs/:contractId/milestones/:index/partial-release – CORS and security headers", () => {
  it("rejects requests from unauthorized origins", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .set("Origin", "http://malicious.com")
      .send(VALID_BODY)
      .expect(403);

    expect(res.body).toEqual({
      success: false,
      error: "Origin not allowed by CORS policy",
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows trusted origins and sets CORS response headers", async () => {
    mockGetAccount.mockResolvedValue({
      accountId: () => VALID_ADDRESS,
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    });
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    const res = await request(buildApp())
      .post(ENDPOINT)
      .set("Origin", "http://localhost:3000")
      .send(VALID_BODY)
      .expect(200);

    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    expect(res.headers["access-control-allow-methods"]).toContain("OPTIONS");
    expect(res.body.success).toBe(true);
  });

  it("sets required security headers on the response", async () => {
    mockGetAccount.mockResolvedValue({
      accountId: () => VALID_ADDRESS,
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    });
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    const res = await request(buildApp())
      .post(ENDPOINT)
      .set("Origin", "http://localhost:3000")
      .send(VALID_BODY)
      .expect(200);

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-xss-protection"]).toBe("0");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'");
    expect(res.headers["permissions-policy"]).toContain("camera=()");
  });
});

describe("POST /api/jobs/:contractId/milestones/:index/partial-release", () => {
  beforeEach(() => {
    mockGetAccount.mockReset();
    mockPrepareTransaction.mockReset();
    resetPartialReleaseRateLimitBuckets();
    resetPartialReleaseCache();

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
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/valid Stellar contract address/i);
  });

  it("returns 400 for a non-numeric index", async () => {
    const res = await request(buildApp())
      .post(`/api/jobs/${VALID_CONTRACT}/milestones/abc/partial-release`)
      .send(VALID_BODY)
      .expect(400);
    expect(res.body).toEqual({
      success: false,
      error: "ValidationError",
      message: "Invalid request parameters",
      details: [
        {
          field: "index",
          message: "index must be a non-negative integer",
        },
      ],
      fields: {
        index: "index must be a non-negative integer",
      },
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
      error: "ValidationError",
      message: "Invalid request parameters",
      details: [
        {
          field: "amount",
          message: "amount must be a positive integer",
        },
      ],
      fields: {
        amount: "amount must be a positive integer",
      },
    });
  });

  it("returns 400 when amount is negative", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ amount: "-10", sourceAddress: VALID_ADDRESS })
      .expect(400);
    expect(res.body).toEqual({
      success: false,
      error: "ValidationError",
      message: "Invalid request parameters",
      details: [
        {
          field: "amount",
          message: "amount must be a positive integer",
        },
      ],
      fields: {
        amount: "amount must be a positive integer",
      },
    });
  });

  it("returns 400 when amount is a non-numeric string", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ amount: "abc", sourceAddress: VALID_ADDRESS })
      .expect(400);
    expect(res.body).toEqual({
      success: false,
      error: "ValidationError",
      message: "Invalid request parameters",
      details: [
        {
          field: "amount",
          message: "amount must be a positive integer",
        },
      ],
      fields: {
        amount: "amount must be a positive integer",
      },
    });
  });

  it("returns 400 when amount is a decimal", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ amount: "1.5", sourceAddress: VALID_ADDRESS })
      .expect(400);
    expect(res.body).toEqual({
      success: false,
      error: "ValidationError",
      message: "Invalid request parameters",
      details: [
        {
          field: "amount",
          message: "amount must be a positive integer",
        },
      ],
      fields: {
        amount: "amount must be a positive integer",
      },
    });
  });

  it("returns 400 when sourceAddress is missing", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ amount: "100" })
      .expect(400);
    expect(res.body).toEqual({
      success: false,
      error: "ValidationError",
      message: "Invalid request parameters",
      details: [
        {
          field: "sourceAddress",
          message: "sourceAddress is required",
        },
      ],
      fields: {
        sourceAddress: "sourceAddress is required",
      },
    });
  });

  it("returns 400 when sourceAddress is not a valid Stellar account address", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ amount: "100", sourceAddress: "not-a-stellar-address" })
      .expect(400);
    expect(res.body).toEqual({
      success: false,
      error: "ValidationError",
      message: "Invalid request parameters",
      details: [
        {
          field: "sourceAddress",
          message: "sourceAddress must be a valid Stellar account address (G...)",
        },
      ],
      fields: {
        sourceAddress: "sourceAddress must be a valid Stellar account address (G...)",
      },
    });
  });

  it("returns 400 when sourceAddress is a contract address (C...)", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ amount: "100", sourceAddress: VALID_CONTRACT })
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/valid Stellar account address/i);
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

  it("returns 404 when getAccount throws account not found", async () => {
    mockGetAccount.mockRejectedValue(new Error("account not found"));
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send(VALID_BODY)
      .expect(404);
    expect(res.body).toEqual({
      success: false,
      error: "Source account not found on network",
    });
  });

  it("returns 500 when getAccount throws a generic internal error", async () => {
    mockGetAccount.mockRejectedValue(new Error("Database connection timeout"));
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send(VALID_BODY)
      .expect(500);
    expect(res.body).toEqual({
      success: false,
      error: "Internal server error",
    });
  });

  it("returns 422 when prepareTransaction throws contract execution reverted", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("contract error #101"));
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send(VALID_BODY)
      .expect(422);
    expect(res.body).toEqual({
      success: false,
      error: "Contract execution reverted (error code 101)",
    });
  });

  it("returns 500 when prepareTransaction throws a generic internal error", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("Database connection timeout"));
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send(VALID_BODY)
      .expect(500);
    expect(res.body).toEqual({
      success: false,
      error: "Internal server error",
    });
  });

  // ── API_KEY gate ──────────────────────────────────────────────────────────

  describe("API_KEY gate", () => {
    const originalApiKey = process.env.API_KEY;

    beforeEach(() => {
      process.env.API_KEY = "secret-test-key";
      mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });
    });

    afterEach(() => {
      if (originalApiKey === undefined) {
        delete process.env.API_KEY;
      } else {
        process.env.API_KEY = originalApiKey;
      }
    });

    it("returns 401 when API_KEY is set and no key is provided", async () => {
      const res = await request(buildApp())
        .post(ENDPOINT)
        .send(VALID_BODY)
        .expect(401);
      expect(res.body).toEqual({ success: false, error: "Unauthorized" });
    });

    it("returns 401 when API_KEY is set and wrong key is provided", async () => {
      const res = await request(buildApp())
        .post(ENDPOINT)
        .set("x-api-key", "wrong-key")
        .send(VALID_BODY)
        .expect(401);
      expect(res.body).toEqual({ success: false, error: "Unauthorized" });
    });

    it("returns 200 when API_KEY is set and correct key is provided", async () => {
      const res = await request(buildApp())
        .post(ENDPOINT)
        .set("x-api-key", "secret-test-key")
        .send(VALID_BODY)
        .expect(200);
      expect(res.body.success).toBe(true);
    });

    it("returns 401 (fails closed) when API_KEY is not set", async () => {
      delete process.env.API_KEY;
      const res = await request(buildApp())
        .post(ENDPOINT)
        .send(VALID_BODY)
        .expect(401);
      expect(res.body).toEqual({ success: false, error: "Unauthorized" });
    });
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

  // --- ISSUE #116: Node-Cache in-memory caching ---
  describe("Node-Cache in-memory caching (Issue #116)", () => {
    beforeEach(() => {
      mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });
    });

    it("serves concurrent requests from the in-flight cache, hitting Soroban only once", async () => {
      const app = buildApp();
      
      let resolvePrepare: (val: any) => void;
      mockPrepareTransaction.mockReturnValue(
        new Promise((resolve) => {
          resolvePrepare = resolve;
        })
      );

      const req1 = request(app).post(ENDPOINT).send(VALID_BODY);
      const req2 = request(app).post(ENDPOINT).send(VALID_BODY);

      await new Promise((r) => setTimeout(r, 50));
      resolvePrepare!({ toXDR: () => "AAAAAQ==" });

      const [res1, res2] = await Promise.all([req1, req2]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res1.body).toEqual({ success: true, xdr: "AAAAAQ==" });
      expect(res2.body).toEqual({ success: true, xdr: "AAAAAQ==" });
      expect(mockPrepareTransaction).toHaveBeenCalledTimes(1);
    });

    it("serves subsequent requests from NodeCache, hitting Soroban only once", async () => {
      const app = buildApp();
      
      const res1 = await request(app).post(ENDPOINT).send(VALID_BODY);
      const res2 = await request(app).post(ENDPOINT).send(VALID_BODY);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(mockPrepareTransaction).toHaveBeenCalledTimes(1);
    });
  });
});
