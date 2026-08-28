import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";

const VALID_CONTRACT = "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";
const VALID_TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const VALID_ADDRESS = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";

const mockGetAccount = jest.fn<() => Promise<unknown>>();
const mockPrepareTransaction = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getAccount = mockGetAccount;
    prepareTransaction = mockPrepareTransaction;
  },
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: router, resetWhitelistUpdateCache, resetWhitelistCache } = await import(
  "../src/routes/jobs.js"
);
const { default: mockLogger } = await import("../src/utils/logger.js");
const { resetJobWhitelistRateLimitBuckets } = await import(
  "../src/middleware/job-contract-rate-limit.js"
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", router);
  return app;
}

const ENDPOINT = `/api/jobs/${VALID_CONTRACT}/whitelist/update`;
const VALID_BODY = {
  token: VALID_TOKEN,
  action: "add" as const,
  sourceAddress: VALID_ADDRESS,
};

const MOCK_ACCOUNT = {
  accountId: () => VALID_ADDRESS,
  sequenceNumber: () => "1",
  incrementSequenceNumber: () => {},
};

function infoCallsFor(msg: string) {
  return (mockLogger.info as ReturnType<typeof jest.fn>).mock.calls.filter(([m]) => m === msg);
}

function debugCallsFor(msg: string) {
  return (mockLogger.debug as ReturnType<typeof jest.fn>).mock.calls.filter(([m]) => m === msg);
}

beforeEach(() => {
  delete process.env.API_KEY;
  resetWhitelistUpdateCache();
  resetWhitelistCache();
  resetJobWhitelistRateLimitBuckets();
  mockGetAccount.mockReset();
  mockPrepareTransaction.mockReset();
  mockGetAccount.mockResolvedValue(MOCK_ACCOUNT);
  (mockLogger.info as ReturnType<typeof jest.fn>).mockClear();
  (mockLogger.warn as ReturnType<typeof jest.fn>).mockClear();
  (mockLogger.error as ReturnType<typeof jest.fn>).mockClear();
  (mockLogger.debug as ReturnType<typeof jest.fn>).mockClear();
});

// ---------------------------------------------------------------------------
// #245 – Zod schema middleware
// ---------------------------------------------------------------------------

describe("POST /api/jobs/:contractId/whitelist/update – Zod validation (#245)", () => {
  it("returns 400 for an invalid contractId", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/not-a-valid-contract/whitelist/update")
      .send(VALID_BODY)
      .expect(400);

    expect(res.body).toMatchObject({
      success: false,
      error: "ValidationError",
      details: expect.any(Array),
    });
    expect(res.body.details[0].field).toBe("contractId");
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it("returns 400 when contractId is a G... account address", async () => {
    const res = await request(buildApp())
      .post(`/api/jobs/${VALID_ADDRESS}/whitelist/update`)
      .send(VALID_BODY)
      .expect(400);

    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/valid Stellar contract address/i);
  });

  it("returns 400 when token is missing", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ action: "add", sourceAddress: VALID_ADDRESS })
      .expect(400);

    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details.some((d: { field: string }) => d.field === "token")).toBe(true);
  });

  it("returns 400 when token is not a valid contract address", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ ...VALID_BODY, token: "not-a-token" })
      .expect(400);

    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].field).toBe("token");
    expect(res.body.details[0].message).toMatch(/valid Stellar contract address/i);
  });

  it("returns 400 when token is a G... account address", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ ...VALID_BODY, token: VALID_ADDRESS })
      .expect(400);

    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].field).toBe("token");
  });

  it("returns 400 when action is missing", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ token: VALID_TOKEN, sourceAddress: VALID_ADDRESS })
      .expect(400);

    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details.some((d: { field: string }) => d.field === "action")).toBe(true);
  });

  it("returns 400 when action is invalid", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ ...VALID_BODY, action: "toggle" })
      .expect(400);

    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].field).toBe("action");
  });

  it("returns 400 when sourceAddress is missing", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ token: VALID_TOKEN, action: "add" })
      .expect(400);

    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toBe("sourceAddress is required");
  });

  it("returns 400 when sourceAddress is not a valid Stellar account", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ ...VALID_BODY, sourceAddress: "bad" })
      .expect(400);

    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/valid Stellar account address/i);
  });

  it("returns 400 when body contains extra fields", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ ...VALID_BODY, extraField: "nope" })
      .expect(400);

    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/unrecognized key/i);
  });

  it("returns field validation details as an array of { field, message }", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ token: 123, action: null, sourceAddress: "" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(Array.isArray(res.body.details)).toBe(true);
    for (const detail of res.body.details) {
      expect(typeof detail.field).toBe("string");
      expect(typeof detail.message).toBe("string");
    }
  });

  it("validation fires before any RPC call is made", async () => {
    await request(buildApp())
      .post(ENDPOINT)
      .send({ ...VALID_BODY, action: "invalid" })
      .expect(400);

    expect(mockGetAccount).not.toHaveBeenCalled();
    expect(mockPrepareTransaction).not.toHaveBeenCalled();
  });

  it("warn validation log contains invalid params on bad contractId", async () => {
    await request(buildApp())
      .post("/api/jobs/not-a-valid-contract/whitelist/update")
      .send(VALID_BODY)
      .expect(400);

    const warnCalls = (mockLogger.warn as ReturnType<typeof jest.fn>).mock.calls.filter(
      ([m]) => m === "Invalid params for whitelist/update",
    );
    expect(warnCalls).toHaveLength(1);
    expect((warnCalls[0][1] as Record<string, unknown>).params).toMatchObject({
      contractId: "not-a-valid-contract",
    });
  });

  it("warn validation log contains invalid body on bad token", async () => {
    const badBody = { ...VALID_BODY, token: "bad" };
    await request(buildApp()).post(ENDPOINT).send(badBody).expect(400);

    const warnCalls = (mockLogger.warn as ReturnType<typeof jest.fn>).mock.calls.filter(
      ([m]) => m === "Invalid body for whitelist/update",
    );
    expect(warnCalls).toHaveLength(1);
    expect((warnCalls[0][1] as Record<string, unknown>).body).toEqual(badBody);
  });
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe("POST /api/jobs/:contractId/whitelist/update – success", () => {
  it("returns 200 with xdr for action=add", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    const res = await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(200);

    expect(res.body).toEqual({ success: true, xdr: "AAAAAQ==" });
    expect(mockGetAccount).toHaveBeenCalledWith(VALID_ADDRESS);
    expect(mockPrepareTransaction).toHaveBeenCalled();
  });

  it("returns 200 with xdr for action=remove", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "BBBBBQ==" });

    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ ...VALID_BODY, action: "remove" })
      .expect(200);

    expect(res.body).toEqual({ success: true, xdr: "BBBBBQ==" });
  });

  it("serves cached XDR on identical subsequent requests", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });
    const app = buildApp();

    await request(app).post(ENDPOINT).send(VALID_BODY).expect(200);
    const res = await request(app).post(ENDPOINT).send(VALID_BODY).expect(200);

    expect(res.body.xdr).toBe("AAAAAQ==");
    expect(mockPrepareTransaction).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// #247 – Robust try-catch / no stack leakage
// ---------------------------------------------------------------------------

describe("POST /api/jobs/:contractId/whitelist/update – error handling (#247)", () => {
  it("returns sanitized 500 when getAccount throws", async () => {
    mockGetAccount.mockRejectedValue(new Error("account boom /secret/path.ts:42"));

    const res = await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expect(JSON.stringify(res.body)).not.toMatch(/boom|stack|path\.ts/i);
  });

  it("returns sanitized 500 when prepareTransaction throws", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("rpc internal failure"));

    const res = await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    expect(res.body).toEqual({ success: false, error: "Internal server error" });
  });

  it("never includes stack traces in 500 responses", async () => {
    const stackError = new Error("boom");
    stackError.stack = "Error: boom\n    at Object.<anonymous> (/app/src/file.ts:1:1)";
    mockGetAccount.mockRejectedValue(stackError);

    const res = await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expect(res.text).not.toContain("stack");
    expect(res.text).not.toContain("/app/src/file.ts");
    expect(Object.keys(res.body).sort()).toEqual(["error", "success"]);
  });

  it("logs server-side error with stack while keeping client body clean", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("rpc boom"));

    const res = await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    expect(res.body.error).toBe("Internal server error");
    const errCalls = (mockLogger.error as ReturnType<typeof jest.fn>).mock.calls.filter(
      ([m]) => m === "Failed to build whitelist update tx",
    );
    expect(errCalls).toHaveLength(1);
    const meta = errCalls[0][1] as Record<string, unknown>;
    expect(meta.error).toBe("rpc boom");
    expect(typeof meta.stack).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// #244 – Winston logger traces
// ---------------------------------------------------------------------------

describe("POST /api/jobs/:contractId/whitelist/update – Winston traces (#244)", () => {
  it("logs request received with path vars and traceId as JSON meta", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(200);

    const calls = infoCallsFor("Whitelist update request received");
    expect(calls).toHaveLength(1);
    const meta = calls[0][1] as Record<string, unknown>;
    expect(typeof meta.traceId).toBe("string");
    expect(meta.contractId).toBe(VALID_CONTRACT);
    expect(meta.token).toBe(VALID_TOKEN);
    expect(meta.action).toBe("add");
    expect(meta.sourceAddress).toBe(VALID_ADDRESS);
  });

  it("logs handler entered with path vars, params, and bodyKeys", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(200);

    const calls = debugCallsFor("Whitelist update handler entered");
    expect(calls).toHaveLength(1);
    const meta = calls[0][1] as Record<string, unknown>;
    expect(typeof meta.traceId).toBe("string");
    expect(meta.contractId).toBe(VALID_CONTRACT);
    expect(meta.token).toBe(VALID_TOKEN);
    expect(meta.action).toBe("add");
    expect(meta.sourceAddress).toBe(VALID_ADDRESS);
    expect((meta.params as Record<string, unknown>).contractId).toBe(VALID_CONTRACT);
    expect(Array.isArray(meta.bodyKeys)).toBe(true);
    expect((meta.bodyKeys as string[]).includes("token")).toBe(true);
  });

  it("logs response sent with status=200 and path vars on success", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(200);

    const calls = infoCallsFor("Whitelist update response sent");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const meta = calls[calls.length - 1][1] as Record<string, unknown>;
    expect(typeof meta.traceId).toBe("string");
    expect(meta.contractId).toBe(VALID_CONTRACT);
    expect(meta.token).toBe(VALID_TOKEN);
    expect(meta.action).toBe("add");
    expect(meta.sourceAddress).toBe(VALID_ADDRESS);
    expect(meta.status).toBe(200);
    expect(meta.success).toBe(true);
  });

  it("logs response body prepared with success and xdrLength", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(200);

    const calls = debugCallsFor("Whitelist update response body prepared");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const meta = calls[calls.length - 1][1] as Record<string, unknown>;
    expect(meta.success).toBe(true);
    expect(meta.xdrLength).toBe("AAAAAQ==".length);
    expect(meta.contractId).toBe(VALID_CONTRACT);
  });

  it("logs Failed with traceId, path vars, and error on RPC failure", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("rpc boom"));

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    const errCalls = (mockLogger.error as ReturnType<typeof jest.fn>).mock.calls.filter(
      ([m]) => m === "Failed to build whitelist update tx",
    );
    expect(errCalls).toHaveLength(1);
    const meta = errCalls[0][1] as Record<string, unknown>;
    expect(typeof meta.traceId).toBe("string");
    expect(meta.contractId).toBe(VALID_CONTRACT);
    expect(meta.token).toBe(VALID_TOKEN);
    expect(meta.action).toBe("add");
    expect(meta.sourceAddress).toBe(VALID_ADDRESS);
    expect(meta.error).toBe("rpc boom");
  });

  it("logs response sent with status=500 + success=false on RPC failure", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("rpc boom"));

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    const calls = infoCallsFor("Whitelist update response sent");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const meta = calls[calls.length - 1][1] as Record<string, unknown>;
    expect(meta.status).toBe(500);
    expect(meta.success).toBe(false);
    expect(meta.contractId).toBe(VALID_CONTRACT);
  });

  it("traceId is consistent across request received and success logs", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(200);

    const receivedId = (infoCallsFor("Whitelist update request received")[0] as [
      string,
      Record<string, unknown>,
    ])[1].traceId;
    const successId = (infoCallsFor("Whitelist update XDR built successfully")[0] as [
      string,
      Record<string, unknown>,
    ])[1].traceId;
    expect(receivedId).toBe(successId);
  });

  it("traceId is consistent across request received and error logs", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("boom"));

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    const receivedId = (infoCallsFor("Whitelist update request received")[0] as [
      string,
      Record<string, unknown>,
    ])[1].traceId;
    const errCalls = (mockLogger.error as ReturnType<typeof jest.fn>).mock.calls.filter(
      ([m]) => m === "Failed to build whitelist update tx",
    );
    expect((errCalls[0][1] as Record<string, unknown>).traceId).toBe(receivedId);
  });

  it("logs cache-hit served with source=cache and path vars", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });
    const app = buildApp();

    await request(app).post(ENDPOINT).send(VALID_BODY).expect(200);
    (mockLogger.info as ReturnType<typeof jest.fn>).mockClear();

    await request(app).post(ENDPOINT).send(VALID_BODY).expect(200);

    const calls = infoCallsFor("Whitelist update XDR served from cache");
    expect(calls).toHaveLength(1);
    const meta = calls[0][1] as Record<string, unknown>;
    expect(meta.source).toBe("cache");
    expect(meta.contractId).toBe(VALID_CONTRACT);
    expect(typeof meta.traceId).toBe("string");
    expect(meta.xdrLength).toBe("AAAAAQ==".length);
  });

  it("logs error caught with stack + path vars on RPC failure", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("rpc boom"));

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    const calls = debugCallsFor("Whitelist update error caught");
    expect(calls).toHaveLength(1);
    const meta = calls[0][1] as Record<string, unknown>;
    expect(meta.error).toBe("rpc boom");
    expect(typeof meta.stack).toBe("string");
    expect(meta.contractId).toBe(VALID_CONTRACT);
  });

  it("logs error response body prepared with client-safe message", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("rpc boom"));

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    const calls = debugCallsFor("Whitelist update error response body prepared");
    expect(calls).toHaveLength(1);
    const meta = calls[0][1] as Record<string, unknown>;
    expect(meta.success).toBe(false);
    expect(meta.clientError).toBe("Internal server error");
  });
});
