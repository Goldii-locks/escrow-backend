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

describe("GET /api/jobs/:contractId/whitelist – Robust Error Handling (Issue #51)", () => {
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

  // ─────────────────────────────────────────────────────────────────────────
  // Happy Path: Valid contractId returns whitelist with 200
  // ─────────────────────────────────────────────────────────────────────────

  describe("Happy path: valid contractId returns whitelist with 200", () => {
    it("returns 200 with successful token list", async () => {
      const vec = {
        forEach: (fn: (item: unknown) => void) => {
          fn({ toString: () => "TOKEN1" });
          fn({ toString: () => "TOKEN2" });
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

    it("logs success with correct tokenCount", async () => {
      const vec = {
        forEach: (fn: (item: unknown) => void) => {
          fn({ toString: () => "A" });
          fn({ toString: () => "B" });
          fn({ toString: () => "C" });
        },
      };
      mockSimulateTransaction.mockResolvedValue({
        result: { retval: vec },
      });

      await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(200);

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        "Whitelisted tokens fetched successfully",
        { contractId: VALID_CONTRACT, tokenCount: 3 }
      );
    });

    it("returns 200 for uninitialized contract with empty token list", async () => {
      mockSimulateTransaction.mockResolvedValue({
        error: "contract error #2",
      });

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(200);

      expect(res.body).toEqual({
        success: true,
        data: { tokens: [] },
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Contract Not Found: Returns 404 with clear message
  // ─────────────────────────────────────────────────────────────────────────

  describe("Contract not found: returns 404 with clear message", () => {
    it("returns 404 when simulation reports 'contract not found'", async () => {
      mockSimulateTransaction.mockResolvedValue({
        error: "contract not found on network",
      });

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(404);

      expect(res.body).toEqual({
        success: false,
        error: "Job not found",
      });
    });

    it("returns 404 when simulation reports 'contract error #1'", async () => {
      mockSimulateTransaction.mockResolvedValue({
        error: "contract error #1",
      });

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(404);

      expect(res.body).toEqual({
        success: false,
        error: "Job not found",
      });
    });

    it("returns 404 when simulation reports 'NotFound'", async () => {
      mockSimulateTransaction.mockResolvedValue({
        error: "NotFound",
      });

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(404);

      expect(res.body).toEqual({
        success: false,
        error: "Job not found",
      });
    });

    it("logs warn when 404 is returned", async () => {
      mockSimulateTransaction.mockResolvedValue({
        error: "contract not found",
      });

      await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(404);

      expect(mockLoggerWarn).toHaveBeenCalledWith("Job not found", {
        contractId: VALID_CONTRACT,
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Invalid contractId Format: Returns 400 with validation message
  // ─────────────────────────────────────────────────────────────────────────

  describe("Invalid contractId format: returns 400 with validation message", () => {
    it("returns 400 for malformed contractId", async () => {
      const res = await request(buildApp())
        .get("/api/jobs/INVALID_ID/whitelist")
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("ValidationError");
      expect(res.body.details[0].field).toBe("contractId");
      expect(res.body.details[0].message).toMatch(/valid Stellar contract address/i);
    });

    it("returns 400 for account address instead of contract", async () => {
      const res = await request(buildApp())
        .get(
          "/api/jobs/GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX/whitelist"
        )
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("ValidationError");
      expect(res.body.details[0].message).toMatch(/valid Stellar contract address/i);
    });

    it("never calls RPC on invalid contractId", async () => {
      await request(buildApp())
        .get("/api/jobs/bad/whitelist")
        .expect(400);

      expect(mockGetAccount).not.toHaveBeenCalled();
      expect(mockSimulateTransaction).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Database/Service Error: Returns 500 with generic message only
  // ─────────────────────────────────────────────────────────────────────────

  describe("Database/service error: returns 500 with generic message only", () => {
    it("returns 500 for RPC connection failure without leaking error details", async () => {
      mockSimulateTransaction.mockRejectedValue(
        new Error("RPC connection refused - server at 10.0.0.5:8000")
      );

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(res.body).toEqual({
        success: false,
        error: "Internal server error",
      });
      expect(JSON.stringify(res.body)).not.toContain("10.0.0.5");
      expect(JSON.stringify(res.body)).not.toContain("connection refused");
    });

    it("returns 500 for account not found error without leaking error details", async () => {
      mockGetAccount.mockRejectedValue(
        new Error("Account not found: admin@private.db")
      );

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(res.body).toEqual({
        success: false,
        error: "Internal server error",
      });
      expect(JSON.stringify(res.body)).not.toContain("admin@private.db");
    });

    it("returns 500 for generic simulation error without leaking error details", async () => {
      mockSimulateTransaction.mockResolvedValue({
        error: "host unreachable - internal server error at 192.168.1.1",
      });

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(res.body).toEqual({
        success: false,
        error: "Internal server error",
      });
      expect(JSON.stringify(res.body)).not.toContain("192.168.1.1");
    });

    it("logs error server-side with full error message", async () => {
      const detailedError = "host unreachable - internal detail";
      mockSimulateTransaction.mockResolvedValue({
        error: detailedError,
      });

      await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(mockLoggerError).toHaveBeenCalledWith(
        "Failed to fetch whitelisted tokens",
        { contractId: VALID_CONTRACT, error: detailedError }
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Stack Trace Leakage Prevention
  // ─────────────────────────────────────────────────────────────────────────

  describe("Stack trace leakage prevention", () => {
    it("never includes 'Error:' string in 500 response body", async () => {
      mockSimulateTransaction.mockRejectedValue(new Error("boom"));

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      const bodyString = JSON.stringify(res.body);
      expect(bodyString).not.toMatch(/Error:/);
    });

    it("never includes 'at ' (stack trace marker) in response body", async () => {
      const errWithStack = new Error("failure");
      errWithStack.stack = "Error: failure\n    at Object.<anonymous> (/app/src/routes/jobs.ts:1:1)";
      mockSimulateTransaction.mockRejectedValue(errWithStack);

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      const bodyString = JSON.stringify(res.body);
      expect(bodyString).not.toContain("at ");
      expect(bodyString).not.toContain("/app/src");
    });

    it("never includes file paths with extensions (.ts, .js) in response", async () => {
      mockGetAccount.mockRejectedValue(
        new Error("error at /home/user/src/routes/jobs.ts line 250")
      );

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      const bodyString = JSON.stringify(res.body);
      expect(bodyString).not.toMatch(/\.ts:/);
      expect(bodyString).not.toMatch(/\.js:/);
      expect(bodyString).not.toContain("/home/user/src");
    });

    it("response body only contains {success: false, error: string}", async () => {
      mockSimulateTransaction.mockRejectedValue(new Error("unexpected"));

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(Object.keys(res.body).sort()).toEqual(["error", "success"]);
      expect(res.body.success).toBe(false);
      expect(typeof res.body.error).toBe("string");
      expect(res.body.error).toBe("Internal server error");
    });

    it("never returns raw database error messages", async () => {
      const dbError = "SQL Error: duplicate key value violates unique constraint";
      mockSimulateTransaction.mockRejectedValue(new Error(dbError));

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      const bodyString = JSON.stringify(res.body);
      expect(bodyString).not.toContain("SQL Error");
      expect(bodyString).not.toContain("constraint");
      expect(bodyString).not.toContain("duplicate key");
    });

    it("never returns authentication credentials that might be in error messages", async () => {
      mockGetAccount.mockRejectedValue(
        new Error("auth failed: token=abc123xyz credential=secret_password")
      );

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      const bodyString = JSON.stringify(res.body);
      expect(bodyString).not.toContain("abc123xyz");
      expect(bodyString).not.toContain("secret_password");
      expect(bodyString).not.toContain("credential");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Unexpected Error Scenarios
  // ─────────────────────────────────────────────────────────────────────────

  describe("Unexpected error scenarios: returns 500", () => {
    it("returns 500 when retval is completely missing", async () => {
      mockSimulateTransaction.mockResolvedValue({
        result: {},
      });

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(res.body).toEqual({
        success: false,
        error: "Internal server error",
      });
    });

    it("returns 500 when simulation returns null", async () => {
      mockSimulateTransaction.mockResolvedValue(null);

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(res.body).toEqual({
        success: false,
        error: "Internal server error",
      });
    });

    it("returns 500 when getAccount throws unexpected error", async () => {
      mockGetAccount.mockRejectedValue(new Error("unexpected network failure"));

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(res.body).toEqual({
        success: false,
        error: "Internal server error",
      });
    });

    it("returns 500 for any error not matching known patterns", async () => {
      mockSimulateTransaction.mockResolvedValue({
        error: "mysterious error that we have never seen before",
      });

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(res.body).toEqual({
        success: false,
        error: "Internal server error",
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Error Response Format Validation
  // ─────────────────────────────────────────────────────────────────────────

  describe("Error response format validation", () => {
    it("404 response has standard error shape", async () => {
      mockSimulateTransaction.mockResolvedValue({
        error: "contract not found",
      });

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(404);

      expect(res.body).toEqual({
        success: false,
        error: "Job not found",
      });
    });

    it("500 response has standard error shape", async () => {
      mockSimulateTransaction.mockRejectedValue(new Error("unexpected"));

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(res.body).toEqual({
        success: false,
        error: "Internal server error",
      });
    });

    it("all error responses match the same JSON structure", async () => {
      const scenarios = [
        {
          name: "unauthorized",
          setup: () => {
            process.env.API_KEY = "secret";
          },
          expectedStatus: 401,
          expectedError: "Unauthorized",
        },
        {
          name: "not found",
          setup: () => {
            mockSimulateTransaction.mockResolvedValue({
              error: "contract not found",
            });
          },
          expectedStatus: 404,
          expectedError: "Job not found",
        },
        {
          name: "unexpected error",
          setup: () => {
            mockSimulateTransaction.mockRejectedValue(new Error("boom"));
          },
          expectedStatus: 500,
          expectedError: "Internal server error",
        },
      ];

      for (const scenario of scenarios) {
        mockSimulateTransaction.mockReset();
        mockLoggerError.mockReset();
        delete process.env.API_KEY;
        scenario.setup();

        const res = await request(buildApp())
          .get(`/api/jobs/${VALID_CONTRACT}/whitelist`);

        expect(res.status).toBe(scenario.expectedStatus);
        expect(Object.keys(res.body).sort()).toEqual(["error", "success"]);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe(scenario.expectedError);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Promise-based async error handling
  // ─────────────────────────────────────────────────────────────────────────

  describe("Promise-based async error handling", () => {
    it("catches errors thrown in the inner requestPromise async function", async () => {
      mockSimulateTransaction.mockRejectedValue(
        new Error("network timeout at internal server")
      );

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(res.body).toEqual({
        success: false,
        error: "Internal server error",
      });
    });

    it("awaits the in-flight promise and catches any errors from it", async () => {
      let resolvePromise: (value: any) => void;
      const promise = new Promise((resolve) => {
        resolvePromise = resolve;
      });
      mockSimulateTransaction.mockReturnValue(promise);

      // Start first request
      const req1 = request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`);

      // Delay slightly to let in-flight cache populate
      await new Promise(resolve => setTimeout(resolve, 50));

      // Resolve with error
      resolvePromise!({
        error: "contract not found",
      });

      const res = await req1;
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Job not found");
    });

    it("properly cleans up in-flight request entry even on error", async () => {
      mockSimulateTransaction.mockRejectedValue(new Error("boom"));

      await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      // Second request should not hang or reuse the failed promise
      mockSimulateTransaction.mockResolvedValue({
        result: { retval: { forEach: () => {} } },
      });

      const res2 = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(200);

      expect(res2.body.success).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Error Logging Patterns
  // ─────────────────────────────────────────────────────────────────────────

  describe("Error logging patterns", () => {
    it("logs error with contractId on unexpected failures", async () => {
      mockSimulateTransaction.mockRejectedValue(new Error("failure"));

      await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      expect(mockLoggerError).toHaveBeenCalledWith(
        "Failed to fetch whitelisted tokens",
        { contractId: VALID_CONTRACT, error: "failure" }
      );
    });

    it("logs warn with contractId on 404", async () => {
      mockSimulateTransaction.mockResolvedValue({
        error: "contract not found",
      });

      await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(404);

      expect(mockLoggerWarn).toHaveBeenCalledWith("Job not found", {
        contractId: VALID_CONTRACT,
      });
    });

    it("logs simulation error as a separate error when caught", async () => {
      const simError = "host unreachable: internal detail";
      mockSimulateTransaction.mockResolvedValue({
        error: simError,
      });

      await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(500);

      const errorCalls = mockLoggerError.mock.calls as Array<[string, Record<string, unknown>]>;
      const simErrorCall = errorCalls.find(
        ([msg]) => msg === "Failed to fetch whitelisted tokens: simulation error"
      );
      expect(simErrorCall).toBeDefined();
      expect(simErrorCall![1].error).toBe(simError);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Authorization and 401 Handling
  // ─────────────────────────────────────────────────────────────────────────

  describe("Authorization and 401 handling", () => {
    it("returns 401 when API key is required but missing", async () => {
      process.env.API_KEY = "secret-key";

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(401);

      expect(res.body).toEqual({
        success: false,
        error: "Unauthorized",
      });
    });

    it("returns 401 when API key is wrong", async () => {
      process.env.API_KEY = "secret-key";

      const res = await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .set("x-api-key", "wrong-key")
        .expect(401);

      expect(res.body).toEqual({
        success: false,
        error: "Unauthorized",
      });
    });

    it("does not call RPC when authorization fails", async () => {
      process.env.API_KEY = "secret-key";

      await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(401);

      expect(mockGetAccount).not.toHaveBeenCalled();
      expect(mockSimulateTransaction).not.toHaveBeenCalled();
    });

    it("logs warn for unauthorized requests", async () => {
      process.env.API_KEY = "secret-key";

      await request(buildApp())
        .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
        .expect(401);

      expect(mockLoggerWarn).toHaveBeenCalledWith("Unauthorized request", {
        contractId: VALID_CONTRACT,
      });
    });
  });
});
