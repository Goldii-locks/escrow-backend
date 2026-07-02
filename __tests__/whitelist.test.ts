import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { resetJobWhitelistRateLimitBuckets } from "../src/middleware/job-contract-rate-limit.js";

const VALID_CONTRACT =
  "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";

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

const { default: router, resetWhitelistCache } = await import("../src/routes/jobs.js");

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
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerError.mockReset();
    resetJobWhitelistRateLimitBuckets();
    resetWhitelistCache();

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

  // --- ISSUE #88 / #89: Schema validation and Stellar address format ---
  describe("Schema and Stellar address validation (Issues #88, #89)", () => {
    it("returns 400 for a garbage contractId", async () => {
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

    it("returns 400 for a contractId that is too short", async () => {
      const short = "C" + "A".repeat(40);
      const res = await request(buildApp())
        .get(`/api/jobs/${short}/whitelist`)
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/valid Stellar contract address/i);
    });

    it("returns 400 for a contractId that is too long", async () => {
      const long = "C" + "A".repeat(60);
      const res = await request(buildApp())
        .get(`/api/jobs/${long}/whitelist`)
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/valid Stellar contract address/i);
    });

    it("returns standardised error shape for all invalid contractId inputs", async () => {
      const res = await request(buildApp())
        .get("/api/jobs/bad/whitelist")
        .expect(400);

      expect(res.body).toMatchObject({ success: false, error: expect.any(String) });
    });

    it("does not return 400 for a syntactically valid contractId", async () => {
      mockSimulateTransaction.mockResolvedValue({
        error: "contract not found on network",
      });

      const res = await request(buildApp()).get(`/api/jobs/${VALID_CONTRACT}/whitelist`);
      expect(res.status).not.toBe(400);
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

      expect(res.body).toEqual({ success: false, error: "Internal server error" });
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

  // --- ISSUE #90: Custom Rate Limiting ---
  describe("Custom Rate Limiting (Issue #90)", () => {
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

    it("decrements X-RateLimit-Remaining with each request", async () => {
      process.env.JOB_WHITELIST_RATE_MAX = "3";
      const vec = { forEach: () => {} };
      mockSimulateTransaction.mockResolvedValue({ result: { retval: vec } });

      const app = buildApp();
      const r1 = await request(app).get(`/api/jobs/${VALID_CONTRACT}/whitelist`).expect(200);
      const r2 = await request(app).get(`/api/jobs/${VALID_CONTRACT}/whitelist`).expect(200);
      const r3 = await request(app).get(`/api/jobs/${VALID_CONTRACT}/whitelist`).expect(200);

      expect(r1.headers["x-ratelimit-remaining"]).toBe("2");
      expect(r2.headers["x-ratelimit-remaining"]).toBe("1");
      expect(r3.headers["x-ratelimit-remaining"]).toBe("0");
    });

    it("sets X-RateLimit-Reset as a Unix timestamp in the future", async () => {
      const vec = { forEach: () => {} };
      mockSimulateTransaction.mockResolvedValue({ result: { retval: vec } });

      const before = Math.floor(Date.now() / 1000);
      const res = await request(buildApp()).get(`/api/jobs/${VALID_CONTRACT}/whitelist`).expect(200);
      const reset = Number(res.headers["x-ratelimit-reset"]);

      expect(reset).toBeGreaterThanOrEqual(before);
    });
  });

  // --- ISSUE #33: Robust try-catch wrapper ---
  describe("Robust try-catch wrapper (Issue #33)", () => {
    it("returns generic 500 without leaking the raw RPC error string", async () => {
      mockSimulateTransaction.mockResolvedValue({
        error: "soroban rpc internal: secret host detail at 10.0.0.1",
      });

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(res.body).toEqual({ success: false, error: "Internal server error" });
      expect(JSON.stringify(res.body)).not.toContain("10.0.0.1");
      expect(JSON.stringify(res.body)).not.toContain("soroban rpc internal");
    });

    it("returns generic 500 without leaking the thrown exception message", async () => {
      mockSimulateTransaction.mockRejectedValue(
        new Error("DB connection string: postgres://admin:password@localhost/prod")
      );

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(res.body).toEqual({ success: false, error: "Internal server error" });
      expect(JSON.stringify(res.body)).not.toContain("postgres://");
      expect(JSON.stringify(res.body)).not.toContain("password");
    });

    it("does not include stack trace markers in the 500 response body", async () => {
      const errWithStack = new Error("some internal failure");
      mockSimulateTransaction.mockRejectedValue(errWithStack);

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/at Object\./);
      expect(body).not.toMatch(/\s+at\s+\w/);
      expect(body).not.toContain(".ts:");
      expect(body).not.toContain(".js:");
    });

    it("returns generic 500 when retval is missing from a successful simulation", async () => {
      mockSimulateTransaction.mockResolvedValue({ result: {} });

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(res.body).toEqual({ success: false, error: "Internal server error" });
    });

    it("catches errors thrown before the RPC call and returns clean 500", async () => {
      mockGetAccount.mockRejectedValue(new Error("account fetch failed: internal token expired"));

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(res.body).toEqual({ success: false, error: "Internal server error" });
      expect(JSON.stringify(res.body)).not.toContain("account fetch failed");
    });

    it("still returns 401 for auth errors thrown during RPC (not swallowed by outer catch)", async () => {
      mockSimulateTransaction.mockRejectedValue(new Error("unauthorized: invalid authentication"));

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(401);

      expect(res.body).toEqual({ success: false, error: "Unauthorized" });
    });

    it("still returns 404 for not-found errors thrown during RPC (not swallowed by outer catch)", async () => {
      mockSimulateTransaction.mockRejectedValue(new Error("contract not found on chain"));

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(404);

      expect(res.body).toEqual({ success: false, error: "Job not found" });
    });

    it("response body contains only success flag and error string — no stack or extra fields", async () => {
      mockSimulateTransaction.mockRejectedValue(new Error("unexpected"));

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(Object.keys(res.body)).toEqual(["success", "error"]);
      expect(res.body.success).toBe(false);
      expect(typeof res.body.error).toBe("string");
    });
  });

  // --- Error Interceptor: non-Error throwables ---
  describe("Error interceptor — non-Error throwables", () => {
    it("returns clean 500 when a string is thrown", async () => {
      mockSimulateTransaction.mockRejectedValue("raw string error: secret=abc123");

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(res.body).toEqual({ success: false, error: "Internal server error" });
      expect(JSON.stringify(res.body)).not.toContain("secret");
      expect(JSON.stringify(res.body)).not.toContain("abc123");
    });

    it("returns clean 500 when null is thrown", async () => {
      mockSimulateTransaction.mockRejectedValue(null);

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(res.body).toEqual({ success: false, error: "Internal server error" });
    });

    it("returns clean 500 when a plain object with sensitive data is thrown", async () => {
      mockSimulateTransaction.mockRejectedValue({
        code: 500,
        detail: "postgres://admin:password@db-host/prod",
        stack: "Error\n    at Object.<anonymous> (jobs.ts:99:5)",
      });

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(res.body).toEqual({ success: false, error: "Internal server error" });
      expect(JSON.stringify(res.body)).not.toContain("postgres://");
      expect(JSON.stringify(res.body)).not.toContain("password");
      expect(JSON.stringify(res.body)).not.toContain("db-host");
    });

    it("returns clean 500 when undefined is thrown", async () => {
      mockSimulateTransaction.mockRejectedValue(undefined);

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(res.body).toEqual({ success: false, error: "Internal server error" });
    });

    it("response body has exactly two keys (success, error) for all 500s from non-Error throws", async () => {
      mockSimulateTransaction.mockRejectedValue({ hidden: "secret-value" });

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(Object.keys(res.body)).toEqual(["success", "error"]);
      expect(JSON.stringify(res.body)).not.toContain("secret-value");
    });
  });

  // --- ISSUE #50: Node-Cache in-memory caching ---
  describe("Node-Cache in-memory caching (Issue #50)", () => {
    it("returns tokens from RPC on first request", async () => {
      const vec = {
        forEach: (fn: (item: unknown) => void) => ["TOKENA"].forEach(fn),
      };
      mockSimulateTransaction.mockResolvedValue({ result: { retval: vec } });

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(200);

      expect(res.body.data.tokens).toEqual(["TOKENA"]);
      expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
    });

    it("serves subsequent requests from cache without calling RPC again", async () => {
      const vec = {
        forEach: (fn: (item: unknown) => void) => ["TOKENA"].forEach(fn),
      };
      mockSimulateTransaction.mockResolvedValue({ result: { retval: vec } });

      const app = buildApp();
      await request(app).get(`/api/jobs/${VALID_CONTRACT}/whitelist`).expect(200);
      await request(app).get(`/api/jobs/${VALID_CONTRACT}/whitelist`).expect(200);

      // RPC only called once; second hit served from cache
      expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
    });

    it("returns cached tokens correctly on cache hit", async () => {
      const vec = {
        forEach: (fn: (item: unknown) => void) =>
          ["TOKEN1", "TOKEN2"].forEach(fn),
      };
      mockSimulateTransaction.mockResolvedValue({ result: { retval: vec } });

      const app = buildApp();
      await request(app).get(`/api/jobs/${VALID_CONTRACT}/whitelist`);
      const cached = await request(app)
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(200);

      expect(cached.body).toEqual({ success: true, data: { tokens: ["TOKEN1", "TOKEN2"] } });
    });

    it("deduplicates concurrent whitelist requests with one RPC call", async () => {
      const vec = {
        forEach: (fn: (item: unknown) => void) => ["TOKEN1", "TOKEN2"].forEach(fn),
      };
      mockSimulateTransaction.mockResolvedValue({ result: { retval: vec } });

      const app = buildApp();
      const requests = await Promise.all([
        request(app).get(`/api/jobs/${VALID_CONTRACT}/whitelist`),
        request(app).get(`/api/jobs/${VALID_CONTRACT}/whitelist`),
      ]);

      expect(requests[0].status).toBe(200);
      expect(requests[1].status).toBe(200);
      expect(requests[0].body).toEqual({ success: true, data: { tokens: ["TOKEN1", "TOKEN2"] } });
      expect(requests[1].body).toEqual({ success: true, data: { tokens: ["TOKEN1", "TOKEN2"] } });
      expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
    });

    it("caches different contractIds independently", async () => {
      const SECOND_CONTRACT =
        "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

      const vec1 = { forEach: (fn: (item: unknown) => void) => ["A"].forEach(fn) };
      const vec2 = { forEach: (fn: (item: unknown) => void) => ["B"].forEach(fn) };
      mockSimulateTransaction
        .mockResolvedValueOnce({ result: { retval: vec1 } })
        .mockResolvedValueOnce({ result: { retval: vec2 } });

      const app = buildApp();
      const r1 = await request(app).get(`/api/jobs/${VALID_CONTRACT}/whitelist`).expect(200);
      const r2 = await request(app).get(`/api/jobs/${SECOND_CONTRACT}/whitelist`).expect(200);

      expect(r1.body.data.tokens).toEqual(["A"]);
      expect(r2.body.data.tokens).toEqual(["B"]);
      expect(mockSimulateTransaction).toHaveBeenCalledTimes(2);
    });

    it("caches empty token list for uninitialized contracts", async () => {
      mockSimulateTransaction.mockResolvedValue({ error: "contract error #2" });

      const app = buildApp();
      await request(app).get(`/api/jobs/${VALID_CONTRACT}/whitelist`);
      const cached = await request(app)
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(200);

      expect(cached.body).toEqual({ success: true, data: { tokens: [] } });
      expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
    });
  });
});
