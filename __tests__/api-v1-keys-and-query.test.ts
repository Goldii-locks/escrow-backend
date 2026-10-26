import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import type { Request, Response } from "express";
import { Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";

/**
 * #695 admin/API key rotation, #697 /api/v1 versioning and #696 the routes the
 * frontend calls (read-only query, whitelisted-tokens alias, auto-release).
 */

const VALID_CONTRACT = "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";

const mockGetAccount = jest.fn<() => Promise<unknown>>();
const mockSimulateTransaction = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getAccount = mockGetAccount;
    simulateTransaction = mockSimulateTransaction;
  },
}));

const { default: jobRoutes, resetTimeRemainingCache } = await import("../src/routes/jobs.js");
const { requireAdmin } = await import("../src/middleware/adminAuth.js");
const { legacyApiDeprecation } = await import("../src/middleware/api-version.js");
const { configuredApiKeys, matchingApiKeyIndex } = await import("../src/utils/api-keys.js");
const rateLimits = await import("../src/middleware/job-contract-rate-limit.js");
const { default: logger } = await import("../src/utils/logger.js");

/** Mirrors the mounting in src/index.ts. */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", legacyApiDeprecation);
  const admin = express.Router();
  admin.use(requireAdmin);
  admin.get("/ping", (_req: Request, res: Response) => {
    res.json({ success: true });
  });
  app.use("/api/v1/jobs", jobRoutes);
  app.use("/api/v1/admin", admin);
  app.use("/api/jobs", jobRoutes);
  app.use("/api/admin", admin);
  return app;
}

const ENV_KEYS = ["ADMIN_API_KEY", "ADMIN_API_KEYS", "API_KEYS"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  rateLimits.resetJobContractRateLimitBuckets();
  rateLimits.resetTimeRemainingRateLimitBuckets();
  resetTimeRemainingCache();
  mockGetAccount.mockReset();
  mockSimulateTransaction.mockReset();
  mockGetAccount.mockResolvedValue({
    accountId: () => Keypair.random().publicKey(),
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// #695 key rotation
// ---------------------------------------------------------------------------

describe("api-keys helpers (#695)", () => {
  it("prefers the plural list, trims entries and drops empties", () => {
    process.env.ADMIN_API_KEYS = " old , ,new ";
    process.env.ADMIN_API_KEY = "ignored";
    expect(configuredApiKeys("ADMIN_API_KEYS", "ADMIN_API_KEY")).toEqual(["old", "new"]);
  });

  it("falls back to the singular variable", () => {
    process.env.ADMIN_API_KEY = "x";
    expect(configuredApiKeys("ADMIN_API_KEYS", "ADMIN_API_KEY")).toEqual(["x"]);
  });

  it("returns the index of the matching key, or undefined", () => {
    expect(matchingApiKeyIndex("new", ["old", "new"])).toBe(1);
    expect(matchingApiKeyIndex("other", ["old", "new"])).toBeUndefined();
    expect(matchingApiKeyIndex(undefined, ["old"])).toBeUndefined();
    expect(matchingApiKeyIndex("", ["old"])).toBeUndefined();
  });
});

describe("requireAdmin key rotation (#695)", () => {
  it("accepts both keys from ADMIN_API_KEYS=old,new and rejects an unknown key", async () => {
    process.env.ADMIN_API_KEYS = "old,new";
    const app = buildApp();
    await request(app).get("/api/v1/admin/ping").set("x-api-key", "old").expect(200);
    await request(app).get("/api/v1/admin/ping").set("x-api-key", "new").expect(200);
    await request(app).get("/api/v1/admin/ping").set("x-api-key", "unknown").expect(401);
    await request(app).get("/api/v1/admin/ping").expect(401);
  });

  it("behaves as before with only ADMIN_API_KEY set", async () => {
    process.env.ADMIN_API_KEY = "x";
    const app = buildApp();
    await request(app).get("/api/v1/admin/ping").set("x-api-key", "x").expect(200);
    await request(app).get("/api/v1/admin/ping").set("authorization", "Bearer x").expect(200);
    await request(app).get("/api/v1/admin/ping").set("x-api-key", "y").expect(401);
  });

  it("fails closed when no admin key is configured", async () => {
    await request(buildApp()).get("/api/v1/admin/ping").set("x-api-key", "anything").expect(401);
  });

  it("logs which key index matched, never the key itself", async () => {
    process.env.ADMIN_API_KEYS = "old-secret,new-secret";
    const info = jest.spyOn(logger, "info");
    await request(buildApp()).get("/api/v1/admin/ping").set("x-api-key", "new-secret").expect(200);

    expect(info).toHaveBeenCalledWith(
      "Admin API key authenticated",
      expect.objectContaining({ keyIndex: 1 }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain("new-secret");
  });
});

// ---------------------------------------------------------------------------
// #697 versioning
// ---------------------------------------------------------------------------

describe("/api/v1 versioning (#697)", () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = "x";
  });

  it("serves the same route on /api/v1 and the legacy path", async () => {
    const app = buildApp();
    const v1 = await request(app).get("/api/v1/admin/ping").set("x-api-key", "x").expect(200);
    const legacy = await request(app).get("/api/admin/ping").set("x-api-key", "x").expect(200);
    expect(legacy.body).toEqual(v1.body);
  });

  it("marks only the legacy paths as deprecated", async () => {
    const app = buildApp();
    const v1 = await request(app).get("/api/v1/admin/ping").set("x-api-key", "x");
    const legacy = await request(app).get("/api/admin/ping").set("x-api-key", "x");
    expect(v1.headers.deprecation).toBeUndefined();
    expect(legacy.headers.deprecation).toBe("true");
  });

  it("does not mark /api/v1 with a query string as deprecated", async () => {
    const res = await request(buildApp()).get("/api/v1/jobs/whitelisted-tokens?contractId=");
    expect(res.headers.deprecation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #696 routes the frontend calls
// ---------------------------------------------------------------------------

function feeAllocationRetval(): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("treasury_bps"),
      val: nativeToScVal(9007199254740993n, { type: "i128" }),
    }),
  ]);
}

describe("GET|POST /api/v1/jobs/query (#696)", () => {
  it("simulates an allowlisted view method and returns amounts as strings", async () => {
    mockSimulateTransaction.mockResolvedValue({ result: { retval: feeAllocationRetval() } });

    const res = await request(buildApp())
      .get("/api/v1/jobs/query")
      .query({ contractId: VALID_CONTRACT, method: "get_platform_fee_allocation" })
      .expect(200);

    expect(res.body).toEqual({
      success: true,
      data: {
        contractId: VALID_CONTRACT,
        method: "get_platform_fee_allocation",
        result: { treasury_bps: "9007199254740993" },
      },
    });
  });

  it("accepts the POST form the frontend admin page sends", async () => {
    mockSimulateTransaction.mockResolvedValue({ result: { retval: xdr.ScVal.scvBool(true) } });

    const res = await request(buildApp())
      .post("/api/jobs/query")
      .send({ contractId: VALID_CONTRACT, method: "is_paused" })
      .expect(200);

    expect(res.body.data.result).toBe(true);
  });

  it.each(["transfer", "initialize", "get_admin", ""])(
    "rejects non-allowlisted method %j with 400 before any RPC call",
    async (method) => {
      const res = await request(buildApp())
        .get("/api/v1/jobs/query")
        .query({ contractId: VALID_CONTRACT, method })
        .expect(400);
      expect(res.body).toEqual({ success: false, error: "Unsupported query method" });
      expect(mockSimulateTransaction).not.toHaveBeenCalled();
    },
  );

  it("rejects a missing or malformed contractId with 400", async () => {
    const app = buildApp();
    await request(app).get("/api/v1/jobs/query").query({ method: "is_paused" }).expect(400);
    const res = await request(app)
      .get("/api/v1/jobs/query")
      .query({ contractId: "not-a-contract", method: "is_paused" })
      .expect(400);
    expect(res.body.error).toMatch(/valid Stellar contract address/);
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it("maps a simulation error without leaking it", async () => {
    mockSimulateTransaction.mockResolvedValue({ error: "contract not found: secret-detail" });
    const res = await request(buildApp())
      .get("/api/v1/jobs/query")
      .query({ contractId: VALID_CONTRACT, method: "is_paused" })
      .expect(404);
    expect(res.text).not.toContain("secret-detail");
  });
});

describe("GET /jobs/whitelisted-tokens alias (#696)", () => {
  it.each([
    ["/api/jobs", "/api/jobs"],
    ["/api/v1/jobs", "/api/v1/jobs"],
  ])("redirects %s to the whitelist route under the same mount", async (mount, expected) => {
    const res = await request(buildApp())
      .get(`${mount}/whitelisted-tokens`)
      .query({ contractId: VALID_CONTRACT })
      .expect(307);
    expect(res.headers.location).toBe(`${expected}/${VALID_CONTRACT}/whitelist`);
  });

  it("requires a contractId", async () => {
    await request(buildApp()).get("/api/v1/jobs/whitelisted-tokens").expect(400);
  });
});

describe("GET /jobs/:contractId/milestones/:index/auto-release alias (#696)", () => {
  it("answers exactly like time-remaining", async () => {
    mockSimulateTransaction.mockResolvedValue({ result: { retval: nativeToScVal(120n, { type: "u64" }) } });
    const app = buildApp();
    const alias = await request(app)
      .get(`/api/v1/jobs/${VALID_CONTRACT}/milestones/0/auto-release`)
      .expect(200);
    const original = await request(app)
      .get(`/api/v1/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`)
      .expect(200);
    expect(alias.body).toEqual({ success: true, data: { secondsRemaining: 120 } });
    expect(original.body).toEqual(alias.body);
  });
});
