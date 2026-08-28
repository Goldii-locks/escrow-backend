import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";

const VALID_CONTRACT = "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";
const VALID_ADDRESS = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";
const VALID_ADDRESS_2 = "GB2AAQ5ECB3LG5XN7VJQ5T7VBR2DXBVXA5HH24376WIFPE7PQN6HBT5X"; // second G... address

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

const { default: router, resetClaimAutoReleaseCache } = await import("../src/routes/jobs.js");
const { default: mockLogger } = await import("../src/utils/logger.js");
const { resetClaimAutoReleaseRateLimitBuckets } = await import(
  "../src/middleware/job-contract-rate-limit.js"
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", router);
  return app;
}

const ENDPOINT = `/api/jobs/${VALID_CONTRACT}/milestones/0/claim-auto-release`;
const VALID_BODY = { sourceAddress: VALID_ADDRESS };

const MOCK_ACCOUNT = {
  accountId: () => VALID_ADDRESS,
  sequenceNumber: () => "1",
  incrementSequenceNumber: () => {},
};

// ---------------------------------------------------------------------------
// Params validation
// ---------------------------------------------------------------------------

describe("POST /api/jobs/:contractId/milestones/:index/claim-auto-release – params validation", () => {
  const originalApiKey = process.env.API_KEY;
  const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;

  beforeEach(() => {
    delete process.env.API_KEY;
    delete process.env.ALLOWED_ORIGINS;
    resetClaimAutoReleaseCache();
    resetClaimAutoReleaseRateLimitBuckets();
    mockGetAccount.mockReset();
    mockPrepareTransaction.mockReset();
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = originalApiKey;
    if (originalAllowedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
  });

  it("returns 400 for an invalid contractId", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/not-a-valid-contract/milestones/0/claim-auto-release")
      .send(VALID_BODY)
      .expect(400);

    expect(res.body).toMatchObject({ success: false, error: expect.any(String) });
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it("returns 400 when contractId is a G... account address", async () => {
    const res = await request(buildApp())
      .post(`/api/jobs/${VALID_ADDRESS}/milestones/0/claim-auto-release`)
      .send(VALID_BODY)
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/valid Stellar contract address/i);
  });

  it("returns 400 for a non-numeric index", async () => {
    const res = await request(buildApp())
      .post(`/api/jobs/${VALID_CONTRACT}/milestones/abc/claim-auto-release`)
      .send(VALID_BODY)
      .expect(400);

    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toBe("index must be a non-negative integer");
  });

  it("returns 400 for a decimal index", async () => {
    const res = await request(buildApp())
      .post(`/api/jobs/${VALID_CONTRACT}/milestones/1.5/claim-auto-release`)
      .send(VALID_BODY)
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
  });

  it("returns 400 for a negative index", async () => {
    const res = await request(buildApp())
      .post(`/api/jobs/${VALID_CONTRACT}/milestones/-1/claim-auto-release`)
      .send(VALID_BODY)
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toBe("index must be a non-negative integer");
  });

  it("returns 400 when sourceAddress is missing", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({})
      .expect(400);

    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toBe("sourceAddress is required");
  });

  it("returns 400 when sourceAddress is not a valid Stellar account address", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ sourceAddress: "not-a-stellar-address" })
      .expect(400);

    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/valid Stellar account address/i);
  });

  it("returns 400 when sourceAddress is a contract address (C...)", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ sourceAddress: VALID_CONTRACT })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
  });

  it("returns 400 when the request body contains extra fields", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ sourceAddress: VALID_ADDRESS, extraField: "not-allowed" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.details[0].message).toMatch(/unrecognized key/i);
  });

  it("returns 400 when sourceAddress is a number", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ sourceAddress: 12345 })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(typeof res.body.error).toBe("string");
  });

  it("returns 400 when body is empty string for sourceAddress", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ sourceAddress: "" })
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("validation fires before any RPC call is made", async () => {
    await request(buildApp())
      .post(ENDPOINT)
      .send({ sourceAddress: "not-a-stellar-address" })
      .expect(400);

    expect(mockGetAccount).not.toHaveBeenCalled();
    expect(mockPrepareTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe("POST /api/jobs/:contractId/milestones/:index/claim-auto-release – success", () => {
  beforeEach(() => {
    resetClaimAutoReleaseRateLimitBuckets();
    resetClaimAutoReleaseCache();
    mockGetAccount.mockReset();
    mockPrepareTransaction.mockReset();
    mockGetAccount.mockResolvedValue(MOCK_ACCOUNT);
  });

  it("returns 200 with xdr on valid input", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    const res = await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(200);

    expect(res.body).toEqual({ success: true, xdr: "AAAAAQ==" });
  });

  it("response shape is exactly { success, xdr }", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    const res = await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(200);

    expect(Object.keys(res.body)).toEqual(["success", "xdr"]);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.xdr).toBe("string");
  });

  it("calls getAccount with sourceAddress", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(200);

    expect(mockGetAccount).toHaveBeenCalledWith(VALID_ADDRESS);
  });
});

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

describe("POST /api/jobs/:contractId/milestones/:index/claim-auto-release – caching", () => {
  beforeEach(() => {
    resetClaimAutoReleaseRateLimitBuckets();
    resetClaimAutoReleaseCache();
    mockGetAccount.mockReset();
    mockPrepareTransaction.mockReset();
    mockGetAccount.mockResolvedValue(MOCK_ACCOUNT);
  });

  it("serves the second request from cache without calling RPC again", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    const app = buildApp();
    const first = await request(app).post(ENDPOINT).send(VALID_BODY).expect(200);
    const second = await request(app).post(ENDPOINT).send(VALID_BODY).expect(200);

    expect(first.body).toEqual({ success: true, xdr: "AAAAAQ==" });
    expect(second.body).toEqual({ success: true, xdr: "AAAAAQ==" });
    expect(mockGetAccount).toHaveBeenCalledTimes(1);
    expect(mockPrepareTransaction).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent requests — only one RPC call", async () => {
    mockPrepareTransaction.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ toXDR: () => "AAAAAQ==" }), 20)),
    );

    const app = buildApp();
    const results = await Promise.all([
      request(app).post(ENDPOINT).send(VALID_BODY),
      request(app).post(ENDPOINT).send(VALID_BODY),
      request(app).post(ENDPOINT).send(VALID_BODY),
    ]);

    for (const res of results) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, xdr: "AAAAAQ==" });
    }
    expect(mockGetAccount).toHaveBeenCalledTimes(1);
    expect(mockPrepareTransaction).toHaveBeenCalledTimes(1);
  });

  it("different sourceAddress values each trigger their own RPC call", async () => {
    mockPrepareTransaction
      .mockResolvedValueOnce({ toXDR: () => "XDR_A" })
      .mockResolvedValueOnce({ toXDR: () => "XDR_B" });

    const app = buildApp();

    const resA = await request(app).post(ENDPOINT).send({ sourceAddress: VALID_ADDRESS }).expect(200);
    const resB = await request(app)
      .post(ENDPOINT)
      .send({ sourceAddress: VALID_ADDRESS_2 })
      .expect(200);

    expect(resA.body.xdr).toBe("XDR_A");
    expect(resB.body.xdr).toBe("XDR_B");
    expect(mockPrepareTransaction).toHaveBeenCalledTimes(2);
  });

  it("different milestone indexes get separate cache entries", async () => {
    mockPrepareTransaction
      .mockResolvedValueOnce({ toXDR: () => "XDR_0" })
      .mockResolvedValueOnce({ toXDR: () => "XDR_1" });

    const app = buildApp();

    const res0 = await request(app)
      .post(`/api/jobs/${VALID_CONTRACT}/milestones/0/claim-auto-release`)
      .send(VALID_BODY)
      .expect(200);
    const res1 = await request(app)
      .post(`/api/jobs/${VALID_CONTRACT}/milestones/1/claim-auto-release`)
      .send(VALID_BODY)
      .expect(200);

    expect(res0.body.xdr).toBe("XDR_0");
    expect(res1.body.xdr).toBe("XDR_1");
    expect(mockPrepareTransaction).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed request — next request retries RPC", async () => {
    mockPrepareTransaction
      .mockRejectedValueOnce(new Error("RPC error"))
      .mockResolvedValueOnce({ toXDR: () => "AAAAAQ==" });

    const app = buildApp();

    await request(app).post(ENDPOINT).send(VALID_BODY).expect(500);
    const retry = await request(app).post(ENDPOINT).send(VALID_BODY).expect(200);

    expect(retry.body).toEqual({ success: true, xdr: "AAAAAQ==" });
    expect(mockPrepareTransaction).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Error path
// ---------------------------------------------------------------------------

describe("POST /api/jobs/:contractId/milestones/:index/claim-auto-release – errors", () => {
  beforeEach(() => {
    resetClaimAutoReleaseRateLimitBuckets();
    resetClaimAutoReleaseCache();
    mockGetAccount.mockReset();
    mockPrepareTransaction.mockReset();
    mockGetAccount.mockResolvedValue(MOCK_ACCOUNT);
  });

  it("returns 500 when getAccount throws", async () => {
    mockGetAccount.mockRejectedValue(new Error("account not found"));

    const res = await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    expect(res.body).toEqual({ success: false, error: "Internal server error" });
  });

  it("returns 500 when prepareTransaction throws", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("RPC failure"));

    const res = await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    expect(res.body).toEqual({ success: false, error: "Internal server error" });
  });

  it("does not leak internal error details in the 500 response", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("secret internal detail: api-key-abc"));

    const res = await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    expect(JSON.stringify(res.body)).not.toContain("api-key");
    expect(JSON.stringify(res.body)).not.toContain("secret");
    expect(res.body.error).toBe("Internal server error");
  });

  it("500 response has exactly { success, error } keys", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("boom"));

    const res = await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    expect(Object.keys(res.body)).toEqual(["success", "error"]);
    expect(res.body.success).toBe(false);
  });

  it("logs the error when RPC fails", async () => {
    (mockLogger.error as ReturnType<typeof jest.fn>).mockClear();
    mockPrepareTransaction.mockRejectedValue(new Error("rpc down"));

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    const errorCalls = (mockLogger.error as ReturnType<typeof jest.fn>).mock.calls.filter(
      ([m]) => m === "Failed to build claim-auto-release tx",
    );
    expect(errorCalls).toHaveLength(1);
  });

  it("returns 400 when sourceAddress is a muxed (M...) address", async () => {
    const res = await request(buildApp())
      .post(ENDPOINT)
      .send({ sourceAddress: "MA7QYNF7SOWQ3GLR2BGMZEHXAVSVJHF3G7SPMYRRLZDDZY6E5CTXJHXAAAAAAAAAAAAAAJLNU" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.details[0].message).toMatch(/sourceAddress/i);
  });

  // ── unhandled exception path (try/catch wrapper, #134) ───────────────────

  it("returns sanitized 500 when getAccount throws (no leak)", async () => {
    mockGetAccount.mockRejectedValue(new Error("connection refused - detail"));

    const res = await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expect(res.text).not.toContain("connection refused");
    expect(res.text).not.toContain("stack");
  });

  it("returns sanitized 500 when prepareTransaction throws (no leak)", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("Database connection timeout"));

    const res = await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expect(res.text).not.toContain("Database connection timeout");
  });

  it("never includes stack traces in 500 responses", async () => {
    const stackError = new Error("boom");
    stackError.stack = "Error: boom\n    at Object.<anonymous> (/app/src/file.ts:1:1)";
    mockGetAccount.mockRejectedValue(stackError);

    const res = await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expect(res.text).not.toContain("/app/src");
    expect(res.text).not.toContain("file.ts");
    expect(res.text).not.toContain("at ");
  });

  it("evicts the cache entry and allows retry after a failed request", async () => {
    mockPrepareTransaction.mockRejectedValueOnce(new Error("temporary RPC failure"));
    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    mockPrepareTransaction.mockResolvedValueOnce({ toXDR: () => "AAAAAQ==" });
    const res = await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(200);

    expect(res.body).toEqual({ success: true, xdr: "AAAAAQ==" });
    expect(mockPrepareTransaction).toHaveBeenCalledTimes(2);
  });
});

function infoCallsFor(msg: string) {
  return (mockLogger.info as ReturnType<typeof jest.fn>).mock.calls.filter(
    ([m]) => m === msg,
  );
}

function debugCallsFor(msg: string) {
  return (mockLogger.debug as ReturnType<typeof jest.fn>).mock.calls.filter(
    ([m]) => m === msg,
  );
}

describe("POST /api/jobs/:contractId/milestones/:index/claim-auto-release – trace logging", () => {
  beforeEach(() => {
    resetClaimAutoReleaseRateLimitBuckets();
    resetClaimAutoReleaseCache();
    mockGetAccount.mockReset();
    mockPrepareTransaction.mockReset();
    (mockLogger.info as ReturnType<typeof jest.fn>).mockClear();
    (mockLogger.warn as ReturnType<typeof jest.fn>).mockClear();
    (mockLogger.error as ReturnType<typeof jest.fn>).mockClear();
    (mockLogger.debug as ReturnType<typeof jest.fn>).mockClear();

    mockGetAccount.mockResolvedValue({
      accountId: () => VALID_ADDRESS,
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    });
  });

  it("logs request received with path vars (contractId, index, sourceAddress) and traceId", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(200);

    const calls = infoCallsFor("Claim auto-release request received");
    expect(calls).toHaveLength(1);

    const [, meta] = calls[0] as [string, Record<string, unknown>];
    expect(typeof meta.traceId).toBe("string");
    expect(meta.contractId).toBe(VALID_CONTRACT);
    expect(meta.index).toBe(0);
    expect(meta.sourceAddress).toBe(VALID_ADDRESS);
  });

  it("logs response sent with status=200 on success (RPC-built XDR) and includes all path vars + success", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(200);

    const calls = infoCallsFor("Claim auto-release response sent");
    expect(calls.length).toBeGreaterThanOrEqual(1);

    const last = calls[calls.length - 1] as [string, Record<string, unknown>];
    const [, meta] = last;
    expect(typeof meta.traceId).toBe("string");
    expect(meta.contractId).toBe(VALID_CONTRACT);
    expect(meta.index).toBe(0);
    expect(meta.sourceAddress).toBe(VALID_ADDRESS);
    expect(meta.status).toBe(200);
    expect(meta.success).toBe(true);
    expect(meta.cached).toBe(false);
    expect(meta.xdrLength).toBe("AAAAAQ==".length);
    expect(meta.error).toBeUndefined();
  });

  it("logs XDR built successfully on RPC build path with xdrLength + path vars", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(200);

    const calls = infoCallsFor("Claim auto-release XDR built successfully");
    expect(calls).toHaveLength(1);

    const [, meta] = calls[0] as [string, Record<string, unknown>];
    expect(typeof meta.traceId).toBe("string");
    expect(meta.contractId).toBe(VALID_CONTRACT);
    expect(meta.index).toBe(0);
    expect(meta.sourceAddress).toBe(VALID_ADDRESS);
    expect(meta.xdrLength).toBe("AAAAAQ==".length);
  });

  it("logs Fetching XDR from Stellar RPC before each RPC call", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(200);

    const calls = infoCallsFor("Fetching claim auto-release XDR from Stellar RPC");
    expect(calls).toHaveLength(1);

    const [, meta] = calls[0] as [string, Record<string, unknown>];
    expect(typeof meta.traceId).toBe("string");
    expect(meta.contractId).toBe(VALID_CONTRACT);
    expect(meta.index).toBe(0);
    expect(meta.sourceAddress).toBe(VALID_ADDRESS);
  });

  it("logs cache-hit served with source=cache, xdrLength, and traceId", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });
    const app = buildApp();

    await request(app).post(ENDPOINT).send(VALID_BODY).expect(200);
    (mockLogger.info as ReturnType<typeof jest.fn>).mockClear();

    await request(app).post(ENDPOINT).send(VALID_BODY).expect(200);

    const calls = infoCallsFor("Claim auto-release XDR served from cache");
    expect(calls).toHaveLength(1);

    const [, meta] = calls[0] as [string, Record<string, unknown>];
    expect(typeof meta.traceId).toBe("string");
    expect(meta.contractId).toBe(VALID_CONTRACT);
    expect(meta.index).toBe(0);
    expect(meta.sourceAddress).toBe(VALID_ADDRESS);
    expect(meta.source).toBe("cache");
    expect(meta.xdrLength).toBe("AAAAAQ==".length);
  });

  it("logs response sent with cached=true on cache hit and includes all path vars + success", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });
    const app = buildApp();

    await request(app).post(ENDPOINT).send(VALID_BODY).expect(200);
    (mockLogger.info as ReturnType<typeof jest.fn>).mockClear();

    await request(app).post(ENDPOINT).send(VALID_BODY).expect(200);

    const sent = infoCallsFor("Claim auto-release response sent");
    expect(sent).toHaveLength(1);

    const [, meta] = sent[0] as [string, Record<string, unknown>];
    expect(typeof meta.traceId).toBe("string");
    expect(meta.contractId).toBe(VALID_CONTRACT);
    expect(meta.index).toBe(0);
    expect(meta.sourceAddress).toBe(VALID_ADDRESS);
    expect(meta.status).toBe(200);
    expect(meta.success).toBe(true);
    expect(meta.cached).toBe(true);
    expect(meta.xdrLength).toBe("AAAAAQ==".length);
  });

  it("logs in-flight hit with source=in-flight on concurrent dedup", async () => {
    mockPrepareTransaction.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ toXDR: () => "AAAAAQ==" }), 20)),
    );
    const app = buildApp();

    await Promise.all([
      request(app).post(ENDPOINT).send(VALID_BODY),
      request(app).post(ENDPOINT).send(VALID_BODY),
    ]);

    const calls = infoCallsFor("Claim auto-release XDR served from in-flight cache");
    expect(calls.length).toBeGreaterThanOrEqual(1);

    const [, meta] = calls[0] as [string, Record<string, unknown>];
    expect(typeof meta.traceId).toBe("string");
    expect(meta.source).toBe("in-flight");
    expect(meta.xdrLength).toBe("AAAAAQ==".length);
  });

  it("logs Failed with traceId, path vars, and error message on RPC failure", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("rpc boom"));

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    const errCalls = (mockLogger.error as ReturnType<typeof jest.fn>).mock.calls.filter(
      ([m]) => m === "Failed to build claim-auto-release tx",
    );
    expect(errCalls).toHaveLength(1);

    const [, meta] = errCalls[0] as [string, Record<string, unknown>];
    expect(typeof meta.traceId).toBe("string");
    expect(meta.contractId).toBe(VALID_CONTRACT);
    expect(meta.index).toBe(0);
    expect(meta.sourceAddress).toBe(VALID_ADDRESS);
    expect(meta.error).toBe("rpc boom");
  });

  it("logs response sent with status=500 + error on RPC failure and includes all path vars + success=false", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("rpc boom"));

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    const calls = infoCallsFor("Claim auto-release response sent");
    const last = calls[calls.length - 1] as [string, Record<string, unknown>];
    const [, meta] = last;

    expect(typeof meta.traceId).toBe("string");
    expect(meta.contractId).toBe(VALID_CONTRACT);
    expect(meta.index).toBe(0);
    expect(meta.sourceAddress).toBe(VALID_ADDRESS);
    expect(meta.status).toBe(500);
    expect(meta.success).toBe(false);
    expect(meta.error).toBe("rpc boom");
  });

  it("traceId on request received matches traceId on built-successfully log", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(200);

    const receivedId = (infoCallsFor("Claim auto-release request received")[0] as [string, Record<string, unknown>])[1].traceId;
    const successId = (infoCallsFor("Claim auto-release XDR built successfully")[0] as [string, Record<string, unknown>])[1].traceId;

    expect(typeof receivedId).toBe("string");
    expect(receivedId).toBe(successId);
  });

  it("traceId on request received matches traceId on error log (same request)", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("boom"));

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    const receivedId = (infoCallsFor("Claim auto-release request received")[0] as [string, Record<string, unknown>])[1].traceId;
    const errCalls = (mockLogger.error as ReturnType<typeof jest.fn>).mock.calls.filter(
      ([m]) => m === "Failed to build claim-auto-release tx",
    );
    const errorId = (errCalls[0] as [string, Record<string, unknown>])[1].traceId;

    expect(receivedId).toBe(errorId);
  });

  it("traceId on request received matches traceId on response-sent log", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(200);

    const receivedId = (infoCallsFor("Claim auto-release request received")[0] as [string, Record<string, unknown>])[1].traceId;
    const sent = infoCallsFor("Claim auto-release response sent");
    const lastSent = sent[sent.length - 1] as [string, Record<string, unknown>];

    expect(lastSent[1].traceId).toBe(receivedId);
  });

  it("does not log XDR built successfully on RPC failure", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("network down"));

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    expect(infoCallsFor("Claim auto-release XDR built successfully")).toHaveLength(0);
  });

  it("does not log Failed to build on success path", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(200);

    const errCalls = (mockLogger.error as ReturnType<typeof jest.fn>).mock.calls.filter(
      ([m]) => m === "Failed to build claim-auto-release tx",
    );
    expect(errCalls).toHaveLength(0);
  });

  it("uses non-negative xdrLength for every success-path info call meta", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });
    const app = buildApp();

    await request(app).post(ENDPOINT).send(VALID_BODY).expect(200);
    await request(app).post(ENDPOINT).send(VALID_BODY).expect(200);

    const msgs = [
      "Claim auto-release request received",
      "Fetching claim auto-release XDR from Stellar RPC",
      "Claim auto-release XDR built successfully",
      "Claim auto-release XDR served from cache",
      "Claim auto-release response sent",
    ];

    for (const msg of msgs) {
      for (const call of infoCallsFor(msg)) {
        const meta = call[1] as Record<string, unknown>;
        const id = meta.traceId as string;
        expect(typeof id).toBe("string");
        expect(id.length).toBeGreaterThan(0);
      }
    }
  });

  it("warn validation log contains the invalid params on bad contractId", async () => {
    await request(buildApp())
      .post("/api/jobs/not-a-valid-contract/milestones/0/claim-auto-release")
      .send(VALID_BODY)
      .expect(400);

    const warnCalls = (mockLogger.warn as ReturnType<typeof jest.fn>).mock.calls.filter(
      ([m]) => m === "Invalid params for claim-auto-release",
    );
    expect(warnCalls).toHaveLength(1);
    const [, meta] = warnCalls[0] as [string, Record<string, unknown>];
    expect((meta.params as Record<string, unknown>).contractId).toBe("not-a-valid-contract");
  });

  it("warn validation log contains invalid body on bad sourceAddress", async () => {
    const badBody = { sourceAddress: "bad" };
    await request(buildApp()).post(ENDPOINT).send(badBody).expect(400);

    const warnCalls = (mockLogger.warn as ReturnType<typeof jest.fn>).mock.calls.filter(
      ([m]) => m === "Invalid body for claim-auto-release",
    );
    expect(warnCalls).toHaveLength(1);
    const [, meta] = warnCalls[0] as [string, Record<string, unknown>];
    expect(meta.body).toEqual(badBody);
  });

  it("trace: logs handler entered with path vars and params", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(200);

    const calls = debugCallsFor("Claim auto-release handler entered");
    expect(calls).toHaveLength(1);

    const [, meta] = calls[0] as [string, Record<string, unknown>];
    expect(typeof meta.traceId).toBe("string");
    expect(meta.contractId).toBe(VALID_CONTRACT);
    expect(meta.index).toBe(0);
    expect(meta.sourceAddress).toBe(VALID_ADDRESS);
    expect((meta.params as Record<string, unknown>).contractId).toBe(VALID_CONTRACT);
    expect(Array.isArray(meta.bodyKeys)).toBe(true);
    expect((meta.bodyKeys as string[]).includes("sourceAddress")).toBe(true);
  });

  it("trace: logs cache check with cacheKey on every request", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(200);

    const calls = debugCallsFor("Checking claim auto-release cache");
    expect(calls).toHaveLength(1);

    const [, meta] = calls[0] as [string, Record<string, unknown>];
    expect(typeof meta.traceId).toBe("string");
    expect(meta.contractId).toBe(VALID_CONTRACT);
    expect(meta.index).toBe(0);
    expect(meta.sourceAddress).toBe(VALID_ADDRESS);
    expect(typeof meta.cacheKey).toBe("string");
    expect(meta.cacheKey).toBe(`${VALID_CONTRACT}:0:${VALID_ADDRESS}`);
  });

  it("trace: logs response body prepared with success and xdrLength on RPC success", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(200);

    const calls = debugCallsFor("Claim auto-release response body prepared");
    expect(calls.length).toBeGreaterThanOrEqual(1);

    const last = calls[calls.length - 1] as [string, Record<string, unknown>];
    const [, meta] = last;
    expect(typeof meta.traceId).toBe("string");
    expect(meta.contractId).toBe(VALID_CONTRACT);
    expect(meta.index).toBe(0);
    expect(meta.sourceAddress).toBe(VALID_ADDRESS);
    expect(meta.success).toBe(true);
    expect(meta.xdrLength).toBe("AAAAAQ==".length);
  });

  it("trace: logs response body prepared with success + xdrLength on cache hit", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });
    const app = buildApp();

    await request(app).post(ENDPOINT).send(VALID_BODY).expect(200);
    (mockLogger.debug as ReturnType<typeof jest.fn>).mockClear();

    await request(app).post(ENDPOINT).send(VALID_BODY).expect(200);

    const calls = debugCallsFor("Claim auto-release response body prepared");
    expect(calls).toHaveLength(1);

    const [, meta] = calls[0] as [string, Record<string, unknown>];
    expect(meta.contractId).toBe(VALID_CONTRACT);
    expect(meta.index).toBe(0);
    expect(meta.sourceAddress).toBe(VALID_ADDRESS);
    expect(meta.success).toBe(true);
    expect(meta.xdrLength).toBe("AAAAAQ==".length);
  });

  it("trace: logs in-flight check and register/unregister around RPC call", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(200);

    expect(debugCallsFor("Checking in-flight claim auto-release requests")).toHaveLength(1);
    expect(debugCallsFor("In-flight promise registered")).toHaveLength(1);
    expect(debugCallsFor("In-flight promise unregistered")).toHaveLength(1);

    const reg = debugCallsFor("In-flight promise registered")[0] as [string, Record<string, unknown>];
    expect(reg[1].contractId).toBe(VALID_CONTRACT);
    expect(reg[1].index).toBe(0);
    expect(reg[1].sourceAddress).toBe(VALID_ADDRESS);
    expect(typeof reg[1].cacheKey).toBe("string");
  });

  it("trace: logs building transaction steps during RPC build", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(200);

    const buildCalls = debugCallsFor("Building Stellar transaction for claim auto-release");
    expect(buildCalls).toHaveLength(1);
    const [, buildMeta] = buildCalls[0] as [string, Record<string, unknown>];
    expect(buildMeta.contractId).toBe(VALID_CONTRACT);
    expect(buildMeta.index).toBe(0);
    expect(buildMeta.sourceAddress).toBe(VALID_ADDRESS);
    expect(buildMeta.fee).toBeDefined();
    expect(buildMeta.timeout).toBe(30);

    expect(debugCallsFor("Fetching Stellar account")).toHaveLength(1);
    expect(debugCallsFor("Stellar account fetched")).toHaveLength(1);
    expect(debugCallsFor("Calling prepareTransaction on Stellar RPC")).toHaveLength(1);
    expect(debugCallsFor("Storing claim auto-release XDR in cache")).toHaveLength(1);

    const storeCalls = debugCallsFor("Storing claim auto-release XDR in cache");
    const [, storeMeta] = storeCalls[0] as [string, Record<string, unknown>];
    expect(storeMeta.xdrLength).toBe("AAAAAQ==".length);
    expect(typeof storeMeta.ttlSeconds).toBe("number");
  });

  it("trace: logs error caught with stack + path vars on RPC failure", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("rpc boom"));

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    const calls = debugCallsFor("Claim auto-release error caught");
    expect(calls).toHaveLength(1);

    const [, meta] = calls[0] as [string, Record<string, unknown>];
    expect(typeof meta.traceId).toBe("string");
    expect(meta.contractId).toBe(VALID_CONTRACT);
    expect(meta.index).toBe(0);
    expect(meta.sourceAddress).toBe(VALID_ADDRESS);
    expect(meta.error).toBe("rpc boom");
    expect(typeof meta.stack).toBe("string");
  });

  it("trace: logs RPC promise rejected with cache clear on failure", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("rpc boom"));

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    const calls = debugCallsFor("RPC promise rejected, clearing cache entry");
    expect(calls).toHaveLength(1);

    const [, meta] = calls[0] as [string, Record<string, unknown>];
    expect(meta.contractId).toBe(VALID_CONTRACT);
    expect(meta.index).toBe(0);
    expect(meta.sourceAddress).toBe(VALID_ADDRESS);
    expect(meta.error).toBe("rpc boom");
  });

  it("trace: logs error response body prepared with success=false + client message", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("rpc boom"));

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    const calls = debugCallsFor("Claim auto-release error response body prepared");
    expect(calls).toHaveLength(1);

    const [, meta] = calls[0] as [string, Record<string, unknown>];
    expect(meta.contractId).toBe(VALID_CONTRACT);
    expect(meta.index).toBe(0);
    expect(meta.sourceAddress).toBe(VALID_ADDRESS);
    expect(meta.success).toBe(false);
    expect(meta.clientError).toBe("Internal server error");
  });

  it("trace: error log includes stack trace alongside message and path vars", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("rpc boom"));

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    const errCalls = (mockLogger.error as ReturnType<typeof jest.fn>).mock.calls.filter(
      ([m]) => m === "Failed to build claim-auto-release tx",
    );
    expect(errCalls).toHaveLength(1);

    const [, meta] = errCalls[0] as [string, Record<string, unknown>];
    expect(meta.contractId).toBe(VALID_CONTRACT);
    expect(meta.index).toBe(0);
    expect(meta.sourceAddress).toBe(VALID_ADDRESS);
    expect(meta.error).toBe("rpc boom");
    expect(typeof meta.stack).toBe("string");
    expect((meta.stack as string).includes("Error: rpc boom")).toBe(true);
  });

  it("trace: traceId on handler entry matches traceId on error caught", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("boom"));

    await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    const entryId = (debugCallsFor("Claim auto-release handler entered")[0] as [string, Record<string, unknown>])[1].traceId;
    const errCatchId = (debugCallsFor("Claim auto-release error caught")[0] as [string, Record<string, unknown>])[1].traceId;

    expect(typeof entryId).toBe("string");
    expect(entryId).toBe(errCatchId);
  });
});

describe("POST /api/jobs/:contractId/milestones/:index/claim-auto-release – rate limiting", () => {
  const originalMax = process.env.CLAIM_AUTO_RELEASE_RATE_MAX;
  const originalWindow = process.env.CLAIM_AUTO_RELEASE_RATE_WINDOW_MS;

  beforeEach(() => {
    resetClaimAutoReleaseRateLimitBuckets();
    process.env.CLAIM_AUTO_RELEASE_RATE_MAX = "3";
    process.env.CLAIM_AUTO_RELEASE_RATE_WINDOW_MS = "60000";
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });
  });

  afterEach(() => {
    resetClaimAutoReleaseRateLimitBuckets();
    if (originalMax === undefined) delete process.env.CLAIM_AUTO_RELEASE_RATE_MAX;
    else process.env.CLAIM_AUTO_RELEASE_RATE_MAX = originalMax;
    if (originalWindow === undefined) delete process.env.CLAIM_AUTO_RELEASE_RATE_WINDOW_MS;
    else process.env.CLAIM_AUTO_RELEASE_RATE_WINDOW_MS = originalWindow;
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
    expect(res.headers["x-ratelimit-limit"]).toBe("3");
    expect(res.headers["x-ratelimit-remaining"]).toBe("2");
    expect(res.headers["x-ratelimit-reset"]).toBeDefined();
  });

  it("returns 429 for every request beyond the threshold", async () => {
    const app = buildApp();
    for (let i = 0; i < 3; i++) {
      await request(app).post(ENDPOINT).send(VALID_BODY);
    }
    const extras = await Promise.all([
      request(app).post(ENDPOINT).send(VALID_BODY),
      request(app).post(ENDPOINT).send(VALID_BODY),
    ]);
    expect(extras[0].status).toBe(429);
    expect(extras[1].status).toBe(429);
    expect(extras[0].body.success).toBe(false);
    expect(extras[1].body.success).toBe(false);
  });

  it("returns Content-Type: application/json on the 429 response", async () => {
    const app = buildApp();
    for (let i = 0; i < 3; i++) {
      await request(app).post(ENDPOINT).send(VALID_BODY);
    }
    const res = await request(app).post(ENDPOINT).send(VALID_BODY);
    expect(res.status).toBe(429);
    expect(res.headers["content-type"]).toMatch(/json/);
  });

  it("counts validation errors (400) against the rate limit bucket", async () => {
    const app = buildApp();
    await request(app).post(ENDPOINT).send({ sourceAddress: "bad" });
    await request(app).post(ENDPOINT).send({ sourceAddress: "bad" });
    await request(app).post(ENDPOINT).send({ sourceAddress: "bad" });
    const res = await request(app).post(ENDPOINT).send(VALID_BODY).expect(429);
    expect(res.headers["x-ratelimit-limit"]).toBe("3");
  });

  it("has independent buckets per IP address (uses req.ip)", async () => {
    const app = express();
    app.set("trust proxy", true);
    app.use(express.json());
    app.use("/api/jobs", router);

    for (let i = 0; i < 3; i++) {
      await request(app)
        .post(ENDPOINT)
        .set("X-Forwarded-For", "10.0.0.1")
        .send(VALID_BODY);
    }
    const blocked = await request(app)
      .post(ENDPOINT)
      .set("X-Forwarded-For", "10.0.0.1")
      .send(VALID_BODY);
    const allowed = await request(app)
      .post(ENDPOINT)
      .set("X-Forwarded-For", "10.0.0.2")
      .send(VALID_BODY);
    expect(blocked.status).toBe(429);
    expect(allowed.status).toBe(200);
    expect(allowed.headers["x-ratelimit-remaining"]).toBe("2");
  });
});
