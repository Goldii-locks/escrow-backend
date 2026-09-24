// __tests__/whitelist-update-validation.test.ts
//
// Schema validation tests for POST /api/jobs/:contractId/whitelist/update
//
import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { autoAuth, TEST_API_KEY } from "./helpers/api-key-helper.js";
import {
  resetJobWhitelistRateLimitBuckets,
  resetWhitelistUpdateRateLimitBuckets,
} from "../src/middleware/job-contract-rate-limit.js";

const VALID_CONTRACT = "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";
const VALID_TOKEN    = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const VALID_ADMIN    = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";

// ---------------------------------------------------------------------------
// Mocks – must be declared before the dynamic import of the router
// ---------------------------------------------------------------------------

const mockGetAccount = jest.fn<() => Promise<unknown>>();
const mockPrepareTransaction = jest.fn<() => Promise<unknown>>();
const mockLoggerInfo  = jest.fn();
const mockLoggerWarn  = jest.fn();
const mockLoggerError = jest.fn();

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: {
    info:  mockLoggerInfo,
    warn:  mockLoggerWarn,
    error: mockLoggerError,
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getAccount          = mockGetAccount;
    prepareTransaction  = mockPrepareTransaction;
    simulateTransaction = jest.fn();
  },
}));

const { default: router, resetWhitelistCache } = await import("../src/routes/jobs.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(autoAuth);
  app.use("/api/jobs", router);
  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validBody(overrides: Record<string, unknown> = {}) {
  return { token: VALID_TOKEN, action: "add", adminAddress: VALID_ADMIN, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/jobs/:contractId/whitelist/update – schema validation", () => {
  beforeEach(() => {
    mockGetAccount.mockReset();
    mockPrepareTransaction.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerError.mockReset();
    resetJobWhitelistRateLimitBuckets();
    // This suite issues more requests than the endpoint's per-window budget,
    // so clear its bucket too – the limiter itself is covered by
    // whitelist-update.test.ts.
    resetWhitelistUpdateRateLimitBuckets();
    resetWhitelistCache();

    // Default happy-path mock: return a minimal account and a stub XDR
    mockGetAccount.mockResolvedValue({
      accountId:               () => VALID_ADMIN,
      sequenceNumber:          () => "100",
      incrementSequenceNumber: () => {},
    });
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAA==" });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Route params: contractId
  // ─────────────────────────────────────────────────────────────────────────

  describe("contractId param validation", () => {
    it("returns 400 for an invalid contractId", async () => {
      const res = await request(buildApp())
        .post("/api/jobs/not-a-contract/whitelist/update")
        .send(validBody())
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("ValidationError");
      expect(res.body.details[0].message).toMatch(/valid Stellar contract address/i);
    });

    it("returns 400 when a Stellar account address is used as contractId", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_ADMIN}/whitelist/update`)
        .send(validBody())
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("ValidationError");
    });

    it("does not return 400 for a valid contractId", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send(validBody());

      expect(res.status).not.toBe(400);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Body: token field
  // ─────────────────────────────────────────────────────────────────────────

  describe("token field validation", () => {
    it("returns 400 when token is missing", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send(validBody({ token: undefined }))
        .expect(400);

      expect(res.body.error).toBe("ValidationError");
      expect(res.body.details.some((d: any) => d.field === "token")).toBe(true);
    });

    it("returns 400 when token is not a string", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send(validBody({ token: 12345 }))
        .expect(400);

      expect(res.body.error).toBe("ValidationError");
      const tokenError = res.body.details.find((d: any) => d.field === "token");
      expect(tokenError).toBeDefined();
      expect(tokenError.message).toMatch(/string/i);
    });

    it("returns 400 when token is an empty string", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send(validBody({ token: "" }))
        .expect(400);

      expect(res.body.error).toBe("ValidationError");
    });

    it("returns 400 when token is not a valid contract address", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send(validBody({ token: "not-a-contract" }))
        .expect(400);

      expect(res.body.error).toBe("ValidationError");
      const tokenError = res.body.details.find((d: any) => d.field === "token");
      expect(tokenError.message).toMatch(/valid Stellar contract address/i);
    });

    it("returns 400 when token is a Stellar account address (G…)", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send(validBody({ token: VALID_ADMIN }))
        .expect(400);

      expect(res.body.error).toBe("ValidationError");
      expect(res.body.details.find((d: any) => d.field === "token").message).toMatch(
        /valid Stellar contract address/i,
      );
    });

    it("accepts a valid contract address as token", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send(validBody());

      expect(res.status).not.toBe(400);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Body: action field
  // ─────────────────────────────────────────────────────────────────────────

  describe("action field validation", () => {
    it("returns 400 when action is missing", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send(validBody({ action: undefined }))
        .expect(400);

      expect(res.body.error).toBe("ValidationError");
      expect(res.body.details.some((d: any) => d.field === "action")).toBe(true);
    });

    it("returns 400 when action is an unknown value", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send(validBody({ action: "update" }))
        .expect(400);

      expect(res.body.error).toBe("ValidationError");
      const actionError = res.body.details.find((d: any) => d.field === "action");
      expect(actionError).toBeDefined();
    });

    it("returns 400 when action is not a string", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send(validBody({ action: 1 }))
        .expect(400);

      expect(res.body.error).toBe("ValidationError");
    });

    it("accepts action = 'add'", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send(validBody({ action: "add" }));

      expect(res.status).not.toBe(400);
    });

    it("accepts action = 'remove'", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send(validBody({ action: "remove" }));

      expect(res.status).not.toBe(400);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Body: adminAddress field
  // ─────────────────────────────────────────────────────────────────────────

  describe("adminAddress field validation", () => {
    it("returns 400 when adminAddress is missing", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send(validBody({ adminAddress: undefined }))
        .expect(400);

      expect(res.body.error).toBe("ValidationError");
      expect(res.body.details.some((d: any) => d.field === "adminAddress")).toBe(true);
    });

    it("returns 400 when adminAddress is not a string", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send(validBody({ adminAddress: 123 }))
        .expect(400);

      expect(res.body.error).toBe("ValidationError");
    });

    it("returns 400 when adminAddress is not a valid Stellar account", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send(validBody({ adminAddress: "not-an-address" }))
        .expect(400);

      expect(res.body.error).toBe("ValidationError");
      const addrError = res.body.details.find((d: any) => d.field === "adminAddress");
      expect(addrError.message).toMatch(/valid Stellar account address/i);
    });

    it("returns 400 when adminAddress is a contract address (C…)", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send(validBody({ adminAddress: VALID_TOKEN }))
        .expect(400);

      expect(res.body.error).toBe("ValidationError");
    });

    it("accepts a valid Stellar account address", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send(validBody());

      expect(res.status).not.toBe(400);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Strict mode: no extra fields allowed
  // ─────────────────────────────────────────────────────────────────────────

  describe("strict mode – no extra fields", () => {
    it("returns 400 when unknown fields are present", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send(validBody({ unknownField: "foo" }))
        .expect(400);

      expect(res.body.error).toBe("ValidationError");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Multiple missing fields – all errors reported
  // ─────────────────────────────────────────────────────────────────────────

  describe("multiple validation errors", () => {
    it("reports all missing fields at once", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send({})
        .expect(400);

      expect(res.body.error).toBe("ValidationError");
      const fields = res.body.details.map((d: any) => d.field);
      expect(fields).toContain("token");
      expect(fields).toContain("action");
      expect(fields).toContain("adminAddress");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Response shape
  // ─────────────────────────────────────────────────────────────────────────

  describe("error response shape", () => {
    it("returns the standard ValidationError envelope on bad input", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send({})
        .expect(400);

      expect(res.body).toMatchObject({
        success: false,
        error: "ValidationError",
        message: expect.any(String),
        details: expect.any(Array),
      });
      expect(res.body.details.length).toBeGreaterThan(0);
      res.body.details.forEach((d: any) => {
        expect(d).toMatchObject({ field: expect.any(String), message: expect.any(String) });
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Happy path – valid payload reaches the handler
  // ─────────────────────────────────────────────────────────────────────────

  describe("happy path", () => {
    it("returns 200 and an xdr string for a valid add request", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send(validBody({ action: "add" }))
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(typeof res.body.data.xdr).toBe("string");
    });

    it("returns 200 and an xdr string for a valid remove request", async () => {
      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send(validBody({ action: "remove" }))
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(typeof res.body.data.xdr).toBe("string");
    });

    it("logs whitelist update with correct fields on success", async () => {
      await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send(validBody())
        .expect(200);

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        "Processing whitelist update",
        expect.objectContaining({ contractId: VALID_CONTRACT, token: VALID_TOKEN, action: "add" }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // API key gate
  // ─────────────────────────────────────────────────────────────────────────

  describe("API key authorization", () => {
    it("returns 401 when API_KEY is set and header is missing", async () => {
      process.env.API_KEY = "secret";

      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .send(validBody())
        .expect(401);

      expect(res.body).toEqual({ success: false, error: "Unauthorized" });
    });

    it("returns 401 when API_KEY is set and wrong key is provided", async () => {
      process.env.API_KEY = "secret";

      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .set("x-api-key", "wrong")
        .send(validBody())
        .expect(401);

      expect(res.body).toEqual({ success: false, error: "Unauthorized" });
    });

    it("proceeds past auth when the correct API key is provided", async () => {
      process.env.API_KEY = "secret";

      const res = await request(buildApp())
        .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
        .set("x-api-key", "secret")
        .send(validBody());

      expect(res.status).not.toBe(401);
    });
  });
});
