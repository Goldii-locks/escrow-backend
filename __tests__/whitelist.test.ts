import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { resetJobWhitelistRateLimitBuckets } from "../src/middleware/job-contract-rate-limit.js";

const VALID_CONTRACT =
  "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";

const mockGetAccount = jest.fn<() => Promise<unknown>>();
const mockSimulateTransaction = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getAccount = mockGetAccount;
    simulateTransaction = mockSimulateTransaction;
  },
}));

const { default: router } = await import("../src/routes/jobs.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", router);
  return app;
}

describe("GET /api/jobs/:contractId/whitelist", () => {
  const originalApiKey = process.env.API_KEY;
  const originalMax = process.env.JOB_WHITELIST_RATE_MAX;
  const originalWindow = process.env.JOB_WHITELIST_RATE_WINDOW_MS;
  const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;

  beforeEach(() => {
    mockGetAccount.mockReset();
    mockSimulateTransaction.mockReset();
    resetJobWhitelistRateLimitBuckets();

    delete process.env.API_KEY;
    delete process.env.JOB_WHITELIST_RATE_MAX;
    delete process.env.JOB_WHITELIST_RATE_WINDOW_MS;
    delete process.env.ALLOWED_ORIGINS;

    mockGetAccount.mockResolvedValue({
      accountId: () =>
        "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
      sequenceNumber: () => "123456789",
      incrementSequenceNumber: () => {},
    });
  });

  afterAll(() => {
    if (originalApiKey === undefined) {
      delete process.env.API_KEY;
    } else {
      process.env.API_KEY = originalApiKey;
    }
    if (originalMax === undefined) {
      delete process.env.JOB_WHITELIST_RATE_MAX;
    } else {
      process.env.JOB_WHITELIST_RATE_MAX = originalMax;
    }
    if (originalWindow === undefined) {
      delete process.env.JOB_WHITELIST_RATE_WINDOW_MS;
    } else {
      process.env.JOB_WHITELIST_RATE_WINDOW_MS = originalWindow;
    }
    if (originalAllowedOrigins === undefined) {
      delete process.env.ALLOWED_ORIGINS;
    } else {
      process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
    }
  });

  // --- ISSUE #44: Address Validation ---
  describe("Address Validation (Issue #44)", () => {
    it("returns 400 for an invalid contractId", async () => {
      const res = await request(buildApp())
        .get("/api/jobs/not-a-valid-contract/whitelist")
        .expect(400);

      expect(res.body).toEqual({
        success: false,
        error: "contractId must be a valid Stellar contract address (C...)",
      });
    });

    it("returns 400 for a Stellar account address used as contractId", async () => {
      const res = await request(buildApp())
        .get(
          "/api/jobs/GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX/whitelist"
        )
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/valid Stellar contract address/i);
    });
  });

  // --- ISSUE #45: Standardize Responses and HTTP Codes ---
  describe("Standard Responses and HTTP Codes (Issue #45)", () => {
    it("returns 401 when API_KEY is configured and the header is missing", async () => {
      process.env.API_KEY = "secret-key";

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(401);

      expect(res.body).toEqual({ success: false, error: "Unauthorized" });
      expect(mockGetAccount).not.toHaveBeenCalled();
    });

    it("returns 401 when API_KEY is configured and the header is wrong", async () => {
      process.env.API_KEY = "secret-key";

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .set("x-api-key", "wrong-key")
        .expect(401);

      expect(res.body).toEqual({ success: false, error: "Unauthorized" });
    });

    it("returns 404 when simulation reports the contract/job was not found", async () => {
      mockSimulateTransaction.mockResolvedValue({
        error: "contract not found on network",
      });

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(404);

      expect(res.body).toEqual({ success: false, error: "Job not found" });
    });

    it("returns empty tokens list (200 OK) for an uninitialized contract (contract error #2)", async () => {
      mockSimulateTransaction.mockResolvedValue({
        error: "contract error #2",
      });

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(200);

      expect(res.body).toEqual({ success: true, data: { tokens: [] } });
    });

    it("returns 200 with tokens list on success", async () => {
      const vec = {
        forEach: (fn: (item: unknown) => void) => {
          ["TOKEN1", "TOKEN2"].forEach(fn);
        },
      };
      mockSimulateTransaction.mockResolvedValue({
        result: { retval: vec },
      });

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(200);

      expect(res.body).toEqual({
        success: true,
        data: { tokens: ["TOKEN1", "TOKEN2"] },
      });
    });

    it("returns 500 for unexpected simulation failures", async () => {
      mockSimulateTransaction.mockResolvedValue({
        error: "host unreachable",
      });

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(res.body).toEqual({ success: false, error: "host unreachable" });
    });
  });

  // --- ISSUE #46: CORS and Security Headers ---
  describe("CORS and Security Headers (Issue #46)", () => {
    it("rejects requests from unauthorized origins with 403", async () => {
      process.env.ALLOWED_ORIGINS = "https://trusted.example.com";

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .set("Origin", "https://evil.example.com")
        .expect(403);

      expect(res.body).toEqual({
        success: false,
        error: "Origin not allowed by CORS policy",
      });
    });

    it("allows trusted origins and sets CORS response headers", async () => {
      process.env.ALLOWED_ORIGINS = "https://trusted.example.com";

      const vec = { forEach: () => {} };
      mockSimulateTransaction.mockResolvedValue({ result: { retval: vec } });

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .set("Origin", "https://trusted.example.com")
        .expect(200);

      expect(res.headers["access-control-allow-origin"]).toBe(
        "https://trusted.example.com"
      );
      expect(res.headers.vary).toContain("Origin");
    });

    it("applies security headers on whitelist response", async () => {
      const vec = { forEach: () => {} };
      mockSimulateTransaction.mockResolvedValue({ result: { retval: vec } });

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(200);

      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["content-security-policy"]).toBe("default-src 'none'");
    });
  });

  // --- ISSUE #47: Custom Rate Limiting ---
  describe("Custom Rate Limiting (Issue #47)", () => {
    it("allows requests up to the configured threshold", async () => {
      process.env.JOB_WHITELIST_RATE_MAX = "2";
      const vec = { forEach: () => {} };
      mockSimulateTransaction.mockResolvedValue({ result: { retval: vec } });

      const app = buildApp();
      for (let i = 0; i < 2; i++) {
        const res = await request(app).get(`/api/jobs/${VALID_CONTRACT}/whitelist`).expect(200);
        expect(res.headers["x-ratelimit-limit"]).toBe("2");
      }
    });

    it("returns 429 once the threshold is exceeded", async () => {
      process.env.JOB_WHITELIST_RATE_MAX = "2";
      const vec = { forEach: () => {} };
      mockSimulateTransaction.mockResolvedValue({ result: { retval: vec } });

      const app = buildApp();
      for (let i = 0; i < 2; i++) {
        await request(app).get(`/api/jobs/${VALID_CONTRACT}/whitelist`);
      }

      const res = await request(app)
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(429);

      expect(res.body).toEqual({
        success: false,
        error: "Too many requests, please try again later",
      });
      expect(res.headers["x-ratelimit-remaining"]).toBe("0");
    });
  });
});
