import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";

const mockGetAccount = jest.fn<() => Promise<unknown>>();
const mockPrepareTransaction = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("../src/middleware/rateLimiter.js", () => ({
  strictLimiter: (_req: any, _res: any, next: any) => next(),
  generalLimiter: (_req: any, _res: any, next: any) => next(),
}));

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getAccount = mockGetAccount;
    prepareTransaction = mockPrepareTransaction;
  },
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { default: router, resetBuildTxCache } = await import("../src/routes/jobs.js");
const { resetBuildTxRateLimitBuckets } = await import(
  "../src/middleware/job-contract-rate-limit.js"
);

const app = express();
app.use(express.json());
app.use("/api/jobs", router);

const VALID_BODY = {
  contractId: "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH",
  method: "fund_job",
  args: [],
  sourceAddress: "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
};

const VALID_ADDRESS = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";
const SECOND_ADDRESS = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

describe("POST /api/jobs/build-tx — error sanitization (#70)", () => {
  beforeEach(() => {
    resetBuildTxRateLimitBuckets();
    resetBuildTxCache();
    mockGetAccount.mockReset();
    mockPrepareTransaction.mockReset();

    mockGetAccount.mockResolvedValue({
      accountId: () => VALID_BODY.sourceAddress,
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    });
  });

  it("returns 200 with xdr on success", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    const res = await request(app).post("/api/jobs/build-tx").send(VALID_BODY).expect(200);
    expect(res.body).toEqual({ success: true, xdr: "AAAAAQ==" });
  });

  it("returns 500 without leaking internal error message", async () => {
    mockPrepareTransaction.mockRejectedValue(
      new Error("DB secret: postgres://admin:password@db/prod")
    );

    const res = await request(app).post("/api/jobs/build-tx").send(VALID_BODY).expect(500);

    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expect(JSON.stringify(res.body)).not.toContain("postgres");
    expect(JSON.stringify(res.body)).not.toContain("password");
  });

  it("returns 500 without leaking stack trace", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("some rpc failure"));

    const res = await request(app).post("/api/jobs/build-tx").send(VALID_BODY).expect(500);

    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/at Object\./);
    expect(body).not.toContain(".ts:");
    expect(body).not.toContain(".js:");
  });

  it("returns 500 when getAccount throws", async () => {
    mockGetAccount.mockRejectedValue(new Error("account not found: internal details"));

    const res = await request(app).post("/api/jobs/build-tx").send(VALID_BODY).expect(500);

    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expect(JSON.stringify(res.body)).not.toContain("account not found");
  });

  it("response body has only success and error fields on failure", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("unexpected"));

    const res = await request(app).post("/api/jobs/build-tx").send(VALID_BODY).expect(500);

    expect(Object.keys(res.body)).toEqual(["success", "error"]);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.error).toBe("string");
  });
});

describe("POST /api/jobs/build-tx — validation", () => {
  it("returns 400 with field errors when payload is completely empty", async () => {
    const res = await request(app).post("/api/jobs/build-tx").send({}).expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.fields).toBeDefined();
    expect(res.body.fields.contractId).toMatch(/contractId is required/i);
    expect(res.body.fields.method).toMatch(/method is required/i);
    expect(res.body.fields.sourceAddress).toMatch(/sourceAddress is required/i);
  });

  it("returns 400 with field errors for invalid formats", async () => {
    const res = await request(app).post("/api/jobs/build-tx").send({
      contractId: "invalid-contract-id",
      method: "",
      sourceAddress: "invalid-source-address",
    }).expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.fields).toBeDefined();
    expect(res.body.fields.contractId).toMatch(/valid Stellar contract address/i);
    expect(res.body.fields.method).toMatch(/method cannot be empty/i);
    expect(res.body.fields.sourceAddress).toMatch(/valid Stellar account address/i);
  });

  it("returns 400 if method is missing", async () => {
    const { method, ...bodyWithoutMethod } = VALID_BODY;
    const res = await request(app).post("/api/jobs/build-tx").send(bodyWithoutMethod).expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.fields).toBeDefined();
    expect(res.body.fields.method).toMatch(/method is required/i);
  });
});

describe("POST /api/jobs/build-tx — request payload schema validation (#101)", () => {
  it("returns 400 when contractId is missing", async () => {
    const body = { ...VALID_BODY, contractId: undefined };
    const res = await request(app).post("/api/jobs/build-tx").send(body).expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toBe("contractId is required");
  });

  it("returns 400 when contractId is not a valid Stellar contract address", async () => {
    const body = { ...VALID_BODY, contractId: "not-a-valid-contract-id" };
    const res = await request(app).post("/api/jobs/build-tx").send(body).expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toBe("contractId must be a valid Stellar contract address (C...)");
  });

  it("returns 400 when method is missing", async () => {
    const body = { ...VALID_BODY, method: undefined };
    const res = await request(app).post("/api/jobs/build-tx").send(body).expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toBe("method is required");
  });

  it("returns 400 when method is empty string", async () => {
    const body = { ...VALID_BODY, method: "" };
    const res = await request(app).post("/api/jobs/build-tx").send(body).expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toBe("method cannot be empty");
  });

  it("returns 400 when sourceAddress is missing", async () => {
    const body = { ...VALID_BODY, sourceAddress: undefined };
    const res = await request(app).post("/api/jobs/build-tx").send(body).expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toBe("sourceAddress is required");
  });

  it("returns 400 when sourceAddress is not a valid Stellar account address", async () => {
    const body = { ...VALID_BODY, sourceAddress: "not-a-valid-address" };
    const res = await request(app).post("/api/jobs/build-tx").send(body).expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toBe(
      "sourceAddress must be a valid Stellar account address (G...)",
    );
  });

  it("returns 400 when args is not an array", async () => {
    const body = { ...VALID_BODY, args: "not-an-array" };
    const res = await request(app).post("/api/jobs/build-tx").send(body).expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.details[0].message).toContain("Expected array, received string");
  });

  it("returns 400 when contractId is invalid data type (number)", async () => {
    const body = { ...VALID_BODY, contractId: 12345 };
    const res = await request(app).post("/api/jobs/build-tx").send(body as any).expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.details[0].message).toContain(
      "contractId must be a valid Stellar contract address (C...)",
    );
  });

  it("returns 400 when method is invalid data type (boolean)", async () => {
    const body = { ...VALID_BODY, method: true };
    const res = await request(app).post("/api/jobs/build-tx").send(body as any).expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.details[0].message).toContain("Expected string, received boolean");
  });
});

describe("POST /api/jobs/build-tx — whitelist management argument validation", () => {
  beforeEach(() => {
    resetBuildTxRateLimitBuckets();
    resetBuildTxCache();
    mockGetAccount.mockReset();
    mockPrepareTransaction.mockReset();

    mockGetAccount.mockResolvedValue({
      accountId: () => VALID_BODY.sourceAddress,
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    });
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });
  });

  it("returns 400 for add_whitelisted_token when no address args are provided", async () => {
    const body = { ...VALID_BODY, method: "add_whitelisted_token", args: [] };
    const res = await request(app).post("/api/jobs/build-tx").send(body).expect(400);

    expect(res.body).toEqual({
      success: false,
      error:
        "Both admin (address) and token (address) arguments are required for whitelist management methods",
    });
    expect(mockPrepareTransaction).not.toHaveBeenCalled();
  });

  it("returns 400 for add_whitelisted_token when only one address arg is provided", async () => {
    const body = {
      ...VALID_BODY,
      method: "add_whitelisted_token",
      args: [{ type: "address", value: VALID_ADDRESS }],
    };
    const res = await request(app).post("/api/jobs/build-tx").send(body).expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("whitelist management methods");
  });

  it("returns 400 for remove_whitelisted_token when address args are missing", async () => {
    const body = { ...VALID_BODY, method: "remove_whitelisted_token", args: [] };
    const res = await request(app).post("/api/jobs/build-tx").send(body).expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("whitelist management methods");
  });

  it("returns 200 for add_whitelisted_token when both admin and token address args are provided", async () => {
    const body = {
      ...VALID_BODY,
      method: "add_whitelisted_token",
      args: [
        { type: "address", value: VALID_ADDRESS },
        { type: "address", value: SECOND_ADDRESS },
      ],
    };
    const res = await request(app).post("/api/jobs/build-tx").send(body).expect(200);

    expect(res.body).toEqual({ success: true, xdr: "AAAAAQ==" });
  });

  it("returns 200 for remove_whitelisted_token when both admin and token address args are provided", async () => {
    const body = {
      ...VALID_BODY,
      method: "remove_whitelisted_token",
      args: [
        { type: "address", value: VALID_ADDRESS },
        { type: "address", value: SECOND_ADDRESS },
      ],
    };
    const res = await request(app).post("/api/jobs/build-tx").send(body).expect(200);

    expect(res.body).toEqual({ success: true, xdr: "AAAAAQ==" });
  });
});

describe("POST /api/jobs/build-tx — contract argument type mapping", () => {
  beforeEach(() => {
    resetBuildTxRateLimitBuckets();
    resetBuildTxCache();
    mockGetAccount.mockReset();
    mockPrepareTransaction.mockReset();

    mockGetAccount.mockResolvedValue({
      accountId: () => VALID_BODY.sourceAddress,
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    });
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });
  });

  it("builds a tx for an address-typed argument", async () => {
    const body = { ...VALID_BODY, args: [{ type: "address", value: VALID_ADDRESS }] };
    const res = await request(app).post("/api/jobs/build-tx").send(body).expect(200);
    expect(res.body).toEqual({ success: true, xdr: "AAAAAQ==" });
  });

  it("builds a tx for an i128-typed argument", async () => {
    const body = { ...VALID_BODY, args: [{ type: "i128", value: "1000000000" }] };
    const res = await request(app).post("/api/jobs/build-tx").send(body).expect(200);
    expect(res.body).toEqual({ success: true, xdr: "AAAAAQ==" });
  });

  it("builds a tx for a u32-typed argument", async () => {
    const body = { ...VALID_BODY, args: [{ type: "u32", value: 5 }] };
    const res = await request(app).post("/api/jobs/build-tx").send(body).expect(200);
    expect(res.body).toEqual({ success: true, xdr: "AAAAAQ==" });
  });

  it("builds a tx for a u64-typed argument", async () => {
    const body = { ...VALID_BODY, args: [{ type: "u64", value: "123456789" }] };
    const res = await request(app).post("/api/jobs/build-tx").send(body).expect(200);
    expect(res.body).toEqual({ success: true, xdr: "AAAAAQ==" });
  });

  it("builds a tx for a bool-typed argument", async () => {
    const body = { ...VALID_BODY, args: [{ type: "bool", value: true }] };
    const res = await request(app).post("/api/jobs/build-tx").send(body).expect(200);
    expect(res.body).toEqual({ success: true, xdr: "AAAAAQ==" });
  });

  it("builds a tx for a vec argument containing i128/u32/u64/default elements", async () => {
    const body = {
      ...VALID_BODY,
      args: [
        {
          type: "vec",
          value: [
            { type: "i128", value: "100" },
            { type: "u32", value: 2 },
            { type: "u64", value: "300" },
            { type: "bool", value: false },
          ],
        },
      ],
    };
    const res = await request(app).post("/api/jobs/build-tx").send(body).expect(200);
    expect(res.body).toEqual({ success: true, xdr: "AAAAAQ==" });
  });

  it("builds a tx for an untyped/default argument", async () => {
    const body = { ...VALID_BODY, args: [{ type: "string", value: "hello" }] };
    const res = await request(app).post("/api/jobs/build-tx").send(body).expect(200);
    expect(res.body).toEqual({ success: true, xdr: "AAAAAQ==" });
  });
});

describe("POST /api/jobs/build-tx — in-memory caching (duplicate network hits)", () => {
  beforeEach(() => {
    resetBuildTxRateLimitBuckets();
    resetBuildTxCache();
    mockGetAccount.mockReset();
    mockPrepareTransaction.mockReset();

    mockGetAccount.mockResolvedValue({
      accountId: () => VALID_BODY.sourceAddress,
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    });
  });

  it("serves a second identical request from cache without hitting the RPC again", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    await request(app).post("/api/jobs/build-tx").send(VALID_BODY).expect(200);
    const second = await request(app).post("/api/jobs/build-tx").send(VALID_BODY).expect(200);

    expect(second.body).toEqual({ success: true, xdr: "AAAAAQ==" });
    expect(mockGetAccount).toHaveBeenCalledTimes(1);
    expect(mockPrepareTransaction).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent identical requests into a single RPC round-trip", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    const results = await Promise.all([
      request(app).post("/api/jobs/build-tx").send(VALID_BODY),
      request(app).post("/api/jobs/build-tx").send(VALID_BODY),
      request(app).post("/api/jobs/build-tx").send(VALID_BODY),
    ]);

    for (const res of results) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, xdr: "AAAAAQ==" });
    }
    expect(mockGetAccount).toHaveBeenCalledTimes(1);
    expect(mockPrepareTransaction).toHaveBeenCalledTimes(1);
  });

  it("treats requests with different method/args/sourceAddress as distinct cache entries", async () => {
    mockPrepareTransaction
      .mockResolvedValueOnce({ toXDR: () => "AAAA_FIRST" })
      .mockResolvedValueOnce({ toXDR: () => "AAAA_SECOND" });

    const first = await request(app).post("/api/jobs/build-tx").send(VALID_BODY).expect(200);
    const second = await request(app)
      .post("/api/jobs/build-tx")
      .send({ ...VALID_BODY, method: "release_milestone" })
      .expect(200);

    expect(first.body.xdr).toBe("AAAA_FIRST");
    expect(second.body.xdr).toBe("AAAA_SECOND");
    expect(mockPrepareTransaction).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed build, so the next identical request retries the RPC", async () => {
    mockPrepareTransaction
      .mockRejectedValueOnce(new Error("simulation failed"))
      .mockResolvedValueOnce({ toXDR: () => "AAAAAQ==" });

    const first = await request(app).post("/api/jobs/build-tx").send(VALID_BODY).expect(500);
    expect(first.body).toEqual({ success: false, error: "Internal server error" });

    const second = await request(app).post("/api/jobs/build-tx").send(VALID_BODY).expect(200);
    expect(second.body).toEqual({ success: true, xdr: "AAAAAQ==" });

    expect(mockPrepareTransaction).toHaveBeenCalledTimes(2);
  });
});
