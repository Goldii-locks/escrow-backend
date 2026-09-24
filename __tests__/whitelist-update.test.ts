import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { autoAuth, TEST_API_KEY } from "./helpers/api-key-helper.js";
import {
  resetJobWhitelistRateLimitBuckets,
  resetWhitelistUpdateRateLimitBuckets,
} from "../src/middleware/job-contract-rate-limit.js";

const VALID_CONTRACT =
  "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";

// Valid Stellar account addresses (G...) and contract address (C...)
const VALID_STELLAR_ADDRESS_1 =
  "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";
const VALID_STELLAR_ADDRESS_2 =
  "GABNCQRZNTG6MMITD33VHFITKJZ5PSYW2XVEXMP52BSMTPLU7WORDQNT";

const mockGetAccount = jest.fn<() => Promise<unknown>>();
const mockSimulateTransaction = jest.fn<() => Promise<unknown>>();

const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: {
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
  },
}));

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getAccount = mockGetAccount;
    simulateTransaction = mockSimulateTransaction;
  },
}));

const { default: router, resetWhitelistCache } = await import(
  "../src/routes/jobs.js"
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(autoAuth);
  app.use("/api/jobs", router);
  return app;
}

describe("POST /api/jobs/:contractId/whitelist/update", () => {
  beforeEach(() => {
    mockGetAccount.mockReset();
    mockSimulateTransaction.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerError.mockReset();
    resetJobWhitelistRateLimitBuckets();
    resetWhitelistUpdateRateLimitBuckets();
    resetWhitelistCache();

    delete process.env.JOB_WHITELIST_RATE_MAX;
    delete process.env.JOB_WHITELIST_RATE_WINDOW_MS;
    delete process.env.JOB_WHITELIST_UPDATE_RATE_MAX;
    delete process.env.JOB_WHITELIST_UPDATE_RATE_WINDOW_MS;
    delete process.env.ALLOWED_ORIGINS;

    mockGetAccount.mockResolvedValue({
      accountId: () =>
        "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
      sequenceNumber: () => "123456789",
      incrementSequenceNumber: () => {},
    });

    mockSimulateTransaction.mockResolvedValue({
      result: {
        retval: {
          forEach: (fn: (item: unknown) => void) => {
            fn({ toString: () => "TOKEN1" });
          },
        },
      },
    });
  });

  it("Test 1 — Valid Stellar address accepted", async () => {
    const res = await request(buildApp())
      .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
      .send({
        addresses: [VALID_STELLAR_ADDRESS_1],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.addresses).toEqual([VALID_STELLAR_ADDRESS_1]);
    expect(res.body.data.contractId).toBe(VALID_CONTRACT);
    expect(res.body.data.updated).toBe(true);
  });

  it("Test 2 — Clearly invalid address returns 400 Bad Request", async () => {
    const res = await request(buildApp())
      .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
      .send({
        addresses: ["invalid-address"],
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details).toBeDefined();
    expect(res.body.details[0].message).toMatch(/Invalid Stellar address/i);
  });

  it("Test 3 — Malformed Stellar-looking address returns 400 Bad Request", async () => {
    const malformedAddress = "G" + "A".repeat(55);

    const res = await request(buildApp())
      .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
      .send({
        addresses: [malformedAddress],
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/Invalid Stellar address/i);
  });

  it("Test 4 — Multiple addresses with one invalid address rejects the entire request with 400 Bad Request", async () => {
    const res = await request(buildApp())
      .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
      .send({
        addresses: [
          VALID_STELLAR_ADDRESS_1,
          "invalid-address",
          VALID_STELLAR_ADDRESS_2,
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/Invalid Stellar address/i);
  });

  it("Test 5 — Multiple valid addresses accepted", async () => {
    const res = await request(buildApp())
      .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
      .send({
        addresses: [
          VALID_STELLAR_ADDRESS_1,
          VALID_STELLAR_ADDRESS_2,
          VALID_CONTRACT,
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.addresses).toHaveLength(3);
  });

  it("Test 6 — Missing or empty address input returns 400 Bad Request", async () => {
    const resMissing = await request(buildApp())
      .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
      .send({});

    expect(resMissing.status).toBe(400);
    expect(resMissing.body.success).toBe(false);

    const resEmpty = await request(buildApp())
      .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
      .send({ addresses: [] });

    expect(resEmpty.status).toBe(400);
    expect(resEmpty.body.success).toBe(false);
  });

  it("returns 400 if contractId in URL path is invalid", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/invalid-contract-id/whitelist/update")
      .send({
        addresses: [VALID_STELLAR_ADDRESS_1],
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Issue #241 additions: 404, 401, 500 & standard response format checks
  // ─────────────────────────────────────────────────────────────────────────

  describe("Contract not found: returns 404", () => {
    it("returns 404 when simulation reports contract not found", async () => {
      mockSimulateTransaction.mockResolvedValue({
        error: "contract not found on network",
      });

      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send({ addresses: [VALID_STELLAR_ADDRESS_1] })
        .expect(404);

      expect(res.body).toEqual({
        success: false,
        error: "Job not found",
      });
    });

    it("returns 404 when simulation reports contract error #1", async () => {
      mockSimulateTransaction.mockResolvedValue({
        error: "contract error #1",
      });

      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send({ addresses: [VALID_STELLAR_ADDRESS_1] })
        .expect(404);

      expect(res.body).toEqual({
        success: false,
        error: "Job not found",
      });
    });
  });

  describe("Authorization and 401 handling", () => {
    it("returns 401 when API key is required but missing", async () => {
      process.env.API_KEY = "secret-key";

      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send({ addresses: [VALID_STELLAR_ADDRESS_1] })
        .expect(401);

      expect(res.body).toEqual({
        success: false,
        error: "Unauthorized",
      });
    });

    it("returns 401 when provided API key is invalid", async () => {
      process.env.API_KEY = "secret-key";

      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .set("x-api-key", "wrong-key")
        .send({ addresses: [VALID_STELLAR_ADDRESS_1] })
        .expect(401);

      expect(res.body).toEqual({
        success: false,
        error: "Unauthorized",
      });
    });

    it("returns 401 (fails closed) when API_KEY is not set", async () => {
      delete process.env.API_KEY;

      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send({ addresses: [VALID_STELLAR_ADDRESS_1] })
        .expect(401);

      expect(res.body).toEqual({
        success: false,
        error: "Unauthorized",
      });
    });

    it("accepts request when valid API key is provided", async () => {
      process.env.API_KEY = "secret-key";

      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .set("x-api-key", "secret-key")
        .send({ addresses: [VALID_STELLAR_ADDRESS_1] })
        .expect(200);

      expect(res.body.success).toBe(true);
    });
  });

  describe("Unexpected internal server error: returns 500", () => {
    it("returns 500 when RPC simulation throws an unexpected error", async () => {
      mockSimulateTransaction.mockRejectedValue(
        new Error("RPC connection refused - server at 10.0.0.5:8000")
      );

      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send({ addresses: [VALID_STELLAR_ADDRESS_1] })
        .expect(500);

      expect(res.body).toEqual({
        success: false,
        error: "Internal server error",
      });
      expect(JSON.stringify(res.body)).not.toContain("10.0.0.5");
      expect(JSON.stringify(res.body)).not.toContain("connection refused");
    });

    it("logs error server-side on 500 failure", async () => {
      mockSimulateTransaction.mockRejectedValue(new Error("RPC internal failure"));

      await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send({ addresses: [VALID_STELLAR_ADDRESS_1] })
        .expect(500);

      expect(mockLoggerError).toHaveBeenCalledWith(
        "Failed to update whitelist",
        { contractId: VALID_CONTRACT, error: "RPC internal failure" }
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Issue #243 additions: Custom Rate Limiting
  // ─────────────────────────────────────────────────────────────────────────

  describe("Rate limiting (Issue #243)", () => {
    it("Test 1 — Requests under the configured limit succeed and set rate-limit headers", async () => {
      process.env.JOB_WHITELIST_UPDATE_RATE_MAX = "3";
      const app = buildApp();

      for (let i = 0; i < 3; i++) {
        const res = await request(app)
          .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
          .send({ addresses: [VALID_STELLAR_ADDRESS_1] });

        expect(res.status).toBe(200);
        expect(res.headers["x-ratelimit-limit"]).toBe("3");
        expect(res.headers["x-ratelimit-remaining"]).toBe(String(2 - i));
        expect(res.headers["x-ratelimit-reset"]).toBeDefined();
      }
    });

    it("Test 2 — Request exceeding the limit returns HTTP 429 Too Many Requests", async () => {
      process.env.JOB_WHITELIST_UPDATE_RATE_MAX = "2";
      const app = buildApp();

      // First 2 requests succeed
      await request(app)
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send({ addresses: [VALID_STELLAR_ADDRESS_1] })
        .expect(200);

      await request(app)
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send({ addresses: [VALID_STELLAR_ADDRESS_1] })
        .expect(200);

      // 3rd request exceeds limit
      const res = await request(app)
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send({ addresses: [VALID_STELLAR_ADDRESS_1] })
        .expect(429);

      expect(res.body).toEqual({
        success: false,
        error: "Too many requests, please try again later",
      });
      expect(res.headers["x-ratelimit-remaining"]).toBe("0");
      expect(res.headers["x-ratelimit-reset"]).toBeDefined();
    });

    it("Test 3 — Rate limiting is scoped specifically to whitelist update endpoint", async () => {
      process.env.JOB_WHITELIST_UPDATE_RATE_MAX = "1";
      process.env.JOB_WHITELIST_RATE_MAX = "10";
      const app = buildApp();

      // Consume whitelist update limit
      await request(app)
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send({ addresses: [VALID_STELLAR_ADDRESS_1] })
        .expect(200);

      // Next whitelist update request is rate limited
      await request(app)
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send({ addresses: [VALID_STELLAR_ADDRESS_1] })
        .expect(429);

      // GET /api/jobs/:contractId/whitelist should still succeed under its own quota
      const getRes = await request(app)
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(200);

      expect(getRes.headers["x-ratelimit-limit"]).toBe("10");
    });

    it("Test 4 — Rate-limit state is isolated between test runs", async () => {
      process.env.JOB_WHITELIST_UPDATE_RATE_MAX = "1";
      const app = buildApp();

      // First request uses up the 1 allowed request
      await request(app)
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send({ addresses: [VALID_STELLAR_ADDRESS_1] })
        .expect(200);

      // Reset buckets explicitly (simulating beforeEach behavior)
      resetWhitelistUpdateRateLimitBuckets();

      // Next request should succeed again because buckets were cleared
      const res = await request(app)
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send({ addresses: [VALID_STELLAR_ADDRESS_1] })
        .expect(200);

      expect(res.headers["x-ratelimit-remaining"]).toBe("0");
    });
  });
});
