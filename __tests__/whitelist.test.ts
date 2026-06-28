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

  // --- ISSUE #48: Winston Logger Traces ---
  describe("Winston Logger Traces (Issue #48)", () => {
    it("logs info with contractId at the start of every request", async () => {
      const vec = { forEach: () => {} };
      mockSimulateTransaction.mockResolvedValue({ result: { retval: vec } });

      await request(buildApp()).get(`/api/jobs/${VALID_CONTRACT}/whitelist`);

      expect(mockLoggerInfo).toHaveBeenCalledWith("Fetching whitelisted tokens", {
        contractId: VALID_CONTRACT,
      });
    });

    it("logs warn with contractId when contractId is invalid", async () => {
      await request(buildApp())
        .get("/api/jobs/not-a-valid-contract/whitelist")
        .expect(400);

      expect(mockLoggerInfo).toHaveBeenCalledWith("Fetching whitelisted tokens", {
        contractId: "not-a-valid-contract",
      });
      expect(mockLoggerWarn).toHaveBeenCalledWith("Invalid contractId provided", {
        contractId: "not-a-valid-contract",
      });
    });

    it("logs warn with contractId when the request is unauthorized", async () => {
      process.env.API_KEY = "secret-key";

      await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(401);

      expect(mockLoggerWarn).toHaveBeenCalledWith("Unauthorized request", {
        contractId: VALID_CONTRACT,
      });
    });

    it("logs warn with contractId when contract/job is not found", async () => {
      mockSimulateTransaction.mockResolvedValue({
        error: "contract not found on network",
      });

      await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(404);

      expect(mockLoggerWarn).toHaveBeenCalledWith("Job not found", {
        contractId: VALID_CONTRACT,
      });
    });

    it("logs info with tokenCount: 0 for uninitialized contract (contract error #2)", async () => {
      mockSimulateTransaction.mockResolvedValue({ error: "contract error #2" });

      await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(200);

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        "Whitelisted tokens fetched successfully",
        { contractId: VALID_CONTRACT, tokenCount: 0 }
      );
    });

    it("logs error with contractId and error message on simulation failure", async () => {
      mockSimulateTransaction.mockResolvedValue({ error: "host unreachable" });

      await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(mockLoggerError).toHaveBeenCalledWith(
        "Failed to fetch whitelisted tokens",
        { contractId: VALID_CONTRACT, error: "host unreachable" }
      );
    });

    it("logs info with contractId and correct tokenCount on successful fetch", async () => {
      const vec = {
        forEach: (fn: (item: unknown) => void) => {
          ["TOKEN_A", "TOKEN_B", "TOKEN_C"].forEach(fn);
        },
      };
      mockSimulateTransaction.mockResolvedValue({ result: { retval: vec } });

      await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(200);

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        "Whitelisted tokens fetched successfully",
        { contractId: VALID_CONTRACT, tokenCount: 3 }
      );
    });

    it("logs error with contractId when retval is missing from result", async () => {
      mockSimulateTransaction.mockResolvedValue({ result: {} });

      await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(mockLoggerError).toHaveBeenCalledWith(
        "Failed to fetch whitelisted tokens",
        { contractId: VALID_CONTRACT, error: "unexpected empty retval" }
      );
    });

    it("logs error with contractId and message when an exception is thrown", async () => {
      mockSimulateTransaction.mockRejectedValue(new Error("Network exploded"));

      await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(mockLoggerError).toHaveBeenCalledWith(
        "Failed to fetch whitelisted tokens",
        { contractId: VALID_CONTRACT, error: "Network exploded" }
      );
    });

    it("log metadata is JSON-serializable and contains the required tracking fields", async () => {
      const vec = {
        forEach: (fn: (item: unknown) => void) => ["TOKEN_X"].forEach(fn),
      };
      mockSimulateTransaction.mockResolvedValue({ result: { retval: vec } });

      await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(200);

      const infoCalls = mockLoggerInfo.mock.calls as Array<[string, Record<string, unknown>]>;
      const successCall = infoCalls.find(([msg]) => msg === "Whitelisted tokens fetched successfully");
      expect(successCall).toBeDefined();

      const [, meta] = successCall!;
      expect(() => JSON.stringify(meta)).not.toThrow();
      expect(meta).toMatchObject({ contractId: VALID_CONTRACT, tokenCount: 1 });
    });

    it("entry log contains contractId in JSON-serializable format", async () => {
      mockSimulateTransaction.mockResolvedValue({ error: "contract error #2" });

      await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(200);

      const infoCalls = mockLoggerInfo.mock.calls as Array<[string, Record<string, unknown>]>;
      const entryCall = infoCalls.find(([msg]) => msg === "Fetching whitelisted tokens");
      expect(entryCall).toBeDefined();

      const [, meta] = entryCall!;
      expect(() => JSON.stringify(meta)).not.toThrow();
      expect(JSON.stringify(meta)).toContain(VALID_CONTRACT);
    });
  });
});
