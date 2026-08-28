import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { TransactionBuilder } from "@stellar/stellar-sdk";

const mockSendTransaction = jest.fn<() => Promise<unknown>>();
const mockTx = { toXDR: () => "mock-xdr" };

jest.unstable_mockModule("../src/middleware/rateLimiter.js", () => ({
  strictLimiter: (_req: any, _res: any, next: any) => next(),
  generalLimiter: (_req: any, _res: any, next: any) => next(),
}));

// Must stub every limiter routes/jobs.ts imports: an ESM module mock replaces
// the whole module, so any omitted export breaks the import of the router.
jest.unstable_mockModule("../src/middleware/job-contract-rate-limit.js", () => ({
  submitRateLimit: (_req: any, _res: any, next: any) => next(),
  jobContractRateLimit: (_req: any, _res: any, next: any) => next(),
  partialReleaseRateLimit: (_req: any, _res: any, next: any) => next(),
  jobWhitelistRateLimit: (_req: any, _res: any, next: any) => next(),
  buildTxRateLimit: (_req: any, _res: any, next: any) => next(),
  timeRemainingRateLimit: (_req: any, _res: any, next: any) => next(),
  createJobDraftRateLimit: (_req: any, _res: any, next: any) => next(),
  claimAutoReleaseRateLimit: (_req: any, _res: any, next: any) => next(),
  resetSubmitRateLimitBuckets: () => {},
}));

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    sendTransaction = mockSendTransaction;
  },
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));


jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  TransactionBuilder: {
    fromXDR: jest.fn(() => mockTx),
  },
  Contract: jest.fn(),
  Networks: {
    TESTNET: "Test SDF Network ; September 2015",
    PUBLIC: "Public Global Stellar Network ; September 2015",
  },
  BASE_FEE: "100",
  nativeToScVal: jest.fn(),
  Address: {
    fromString: jest.fn(() => ({ toScVal: jest.fn() })),
  },
  StrKey: {
    isValidEd25519PublicKey: jest.fn(() => true),
  },
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { default: router, resetSubmitCache } = await import("../src/routes/jobs.js");
const { default: mockLogger } = await import("../src/utils/logger.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", router);
  return app;
}

// Real base64-encoded strings (valid format, not necessarily valid Stellar XDR –
// the mock bypasses actual XDR parsing so format-valid base64 is all we need
// for the happy-path and error-path tests).
const VALID_SIGNED_XDR =
  "AAAAAgAAAABz9B8nR7h4qY6Ran5PlacgCUxOFxOdIQAAAAAAAAAAABAAAAAAAAAAAA==";
const VALID_SIGNED_XDR_2 =
  "AAAAAgAAAABz9B8nR7h4qY6Ran5PlacgCUxOFxOdIQAAAAAAAAAAABAAAAAAAAAAAA==".replace(
    "AAAA",
    "BBBB",
  );

describe("POST /api/jobs/submit – success path", () => {
  beforeEach(() => {
    mockSendTransaction.mockReset();
    resetSubmitCache();
  });

  it("returns 200 with transaction result on successful submission", async () => {
    const mockResult = {
      id: "123456789",
      status: "PENDING",
      hash: "abcdef123456789",
    };
    mockSendTransaction.mockResolvedValue(mockResult);

    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(200);

    expect(res.body).toEqual({ success: true, data: mockResult });
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });

  it("accepts valid signedXdr and calls sendTransaction", async () => {
    mockSendTransaction.mockResolvedValue({ id: "test-id" });

    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
  });
});

describe("POST /api/jobs/submit – schema validation", () => {
  it("returns 400 when signedXdr is missing", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({})
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/required/i);
  });

  it("returns 400 when signedXdr is an empty string", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: "" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/empty/i);
  });

  it("returns 400 when signedXdr is not a string", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: 12345 })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/string/i);
  });

  it("returns 400 when signedXdr is null", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: null })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/string/i);
  });

  it("error body has ValidationError format on validation failure", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({})
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.message).toBe("Invalid request parameters");
    expect(Array.isArray(res.body.details)).toBe(true);
  });
});

describe("POST /api/jobs/submit – error sanitization", () => {
  beforeEach(() => {
    mockSendTransaction.mockReset();
    resetSubmitCache();
  });

  it("returns 500 without leaking internal error message from RPC", async () => {
    mockSendTransaction.mockRejectedValue(
      new Error("RPC secret: api-key-12345 internal detail")
    );

    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(500);

    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expect(JSON.stringify(res.body)).not.toContain("api-key");
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });

  it("returns 500 without leaking stack trace", async () => {
    const stackError = new Error("RPC failure");
    stackError.stack = "Error: RPC failure\n    at Object.sendTransaction (/app/src/rpc.ts:1:1)";
    mockSendTransaction.mockRejectedValue(stackError);

    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(500);

    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/at Object\./);
    expect(body).not.toContain(".ts:");
    expect(body).not.toContain(".js:");
  });

  it("returns 500 when sendTransaction throws network error", async () => {
    mockSendTransaction.mockRejectedValue(new Error("network unreachable"));

    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(500);

    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expect(JSON.stringify(res.body)).not.toContain("network unreachable");
  });

  it("returns 400 when XDR parsing fails", async () => {
    // A format-valid base64 string that triggers XDR parsing failure classification
    mockSendTransaction.mockImplementation(() => {
      throw new Error("XDR parsing failed");
    });

    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(typeof res.body.error).toBe("string");
  });

  it("response body has only success and error fields on failure", async () => {
    mockSendTransaction.mockRejectedValue(new Error("unexpected error"));

    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(500);

    expect(Object.keys(res.body).sort()).toEqual(["error", "success"].sort());
    expect(res.body.success).toBe(false);
    expect(typeof res.body.error).toBe("string");
  });

  it("returns sanitized 500 for timeout errors", async () => {
    mockSendTransaction.mockRejectedValue(new Error("Request timeout after 30000ms"));

    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(500);

    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expect(JSON.stringify(res.body)).not.toContain("30000ms");
  });

  it("returns 401 for authentication errors instead of leaking them", async () => {
    mockSendTransaction.mockRejectedValue(
      new Error("Authentication failed: invalid credentials")
    );

    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(401);

    expect(res.body.success).toBe(false);
    expect(typeof res.body.error).toBe("string");
    expect(JSON.stringify(res.body)).not.toContain("credentials");
  });
});

describe("POST /api/jobs/submit – rate limiting", () => {
  beforeEach(() => {
    mockSendTransaction.mockReset();
    resetSubmitCache();
  });

  it("applies strict rate limiter middleware", async () => {
    mockSendTransaction.mockResolvedValue({ id: "test-id" });

    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(200);

    expect(res.body.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/jobs/submit – in-memory caching
// ---------------------------------------------------------------------------

describe("POST /api/jobs/submit – caching", () => {
  beforeEach(() => {
    mockSendTransaction.mockReset();
    resetSubmitCache();
  });

  it("returns cached result on second identical request without calling sendTransaction again", async () => {
    const mockResult = { id: "tx-abc", status: "PENDING", hash: "hash-abc" };
    mockSendTransaction.mockResolvedValue(mockResult);

    const app = buildApp();

    const first = await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(200);

    const second = await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(200);

    expect(first.body).toEqual({ success: true, data: mockResult });
    expect(second.body).toEqual({ success: true, data: mockResult });
    // sendTransaction must only have been called once – second hit came from cache
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });

  it("concurrent requests for the same XDR call sendTransaction exactly once", async () => {
    const mockResult = { id: "tx-concurrent", status: "PENDING" };
    // Simulate a slow network call so both requests are in-flight together
    mockSendTransaction.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(mockResult), 20)),
    );

    const app = buildApp();

    const [first, second, third] = await Promise.all([
      request(app).post("/api/jobs/submit").send({ signedXdr: VALID_SIGNED_XDR }),
      request(app).post("/api/jobs/submit").send({ signedXdr: VALID_SIGNED_XDR }),
      request(app).post("/api/jobs/submit").send({ signedXdr: VALID_SIGNED_XDR }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);

    expect(first.body).toEqual({ success: true, data: mockResult });
    expect(second.body).toEqual({ success: true, data: mockResult });
    expect(third.body).toEqual({ success: true, data: mockResult });

    // Only one real network call despite three concurrent requests
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });

  it("different XDR values each trigger their own sendTransaction call", async () => {
    mockSendTransaction
      .mockResolvedValueOnce({ id: "tx-1", status: "PENDING" })
      .mockResolvedValueOnce({ id: "tx-2", status: "PENDING" });

    const app = buildApp();
    const XDR_A = VALID_SIGNED_XDR;
    const XDR_B = VALID_SIGNED_XDR_2;

    const resA = await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: XDR_A })
      .expect(200);

    const resB = await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: XDR_B })
      .expect(200);

    expect(resA.body.data.id).toBe("tx-1");
    expect(resB.body.data.id).toBe("tx-2");
    expect(mockSendTransaction).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed submission – next request retries sendTransaction", async () => {
    mockSendTransaction
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce({ id: "tx-retry", status: "PENDING" });

    const app = buildApp();

    const failed = await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(500);

    expect(failed.body).toEqual({ success: false, error: "Internal server error" });

    const retry = await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(200);

    expect(retry.body).toEqual({ success: true, data: { id: "tx-retry", status: "PENDING" } });
    expect(mockSendTransaction).toHaveBeenCalledTimes(2);
  });

  it("cache is isolated per test – resetSubmitCache prevents cross-test pollution", async () => {
    const mockResult = { id: "fresh", status: "PENDING" };
    mockSendTransaction.mockResolvedValue(mockResult);

    const app = buildApp();

    // First call populates cache
    await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(200);

    expect(mockSendTransaction).toHaveBeenCalledTimes(1);

    // Reset simulates a new test boundary
    resetSubmitCache();
    mockSendTransaction.mockClear();

    // After reset a fresh call must hit the network again
    await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(200);

    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// POST /api/jobs/submit – Zod format validation (signedXdr field)
// ---------------------------------------------------------------------------

describe("POST /api/jobs/submit – Zod format validation", () => {
  // These tests exercise the schema layer only; no RPC call is made.

  beforeEach(() => {
    mockSendTransaction.mockReset();
    resetSubmitCache();
  });

  // -------------------------------------------------------------------------
  // Presence / type checks (first-layer refines)
  // -------------------------------------------------------------------------

  it("returns 400 with 'required' message when body is empty", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({})
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/required/i);
  });

  it("returns 400 with 'empty' message for empty string", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: "" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/empty/i);
  });

  it("returns 400 with 'string' message for numeric signedXdr", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: 99999 })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/string/i);
  });

  it("returns 400 with 'string' message for boolean signedXdr", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: true })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/string/i);
  });

  it("returns 400 with 'string' message for array signedXdr", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: ["AAAAAgAA=="] })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/string/i);
  });

  it("returns 400 with 'string' message for object signedXdr", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: { value: "AAAAAgAA==" } })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/string/i);
  });

  // -------------------------------------------------------------------------
  // Whitespace checks
  // -------------------------------------------------------------------------

  it("returns 400 with 'whitespace' message for signedXdr containing a space", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: "AAAAAgAA== AAAAAgAA==" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/whitespace/i);
  });

  it("returns 400 for signedXdr that is only whitespace", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: "    " })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
  });

  it("returns 400 for signedXdr containing a tab character", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: "AAAAAgAA==\tAAAA" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/whitespace/i);
  });

  it("returns 400 for signedXdr containing a newline", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: "AAAAAgAA==\nAAAAAgAA==" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/whitespace/i);
  });

  // -------------------------------------------------------------------------
  // Base64 format checks
  // -------------------------------------------------------------------------

  it("returns 400 with 'base64' message for signedXdr with non-base64 characters", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      // '!' is not a valid base64 character
      .send({ signedXdr: "AAAAAgAA!!" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/base64/i);
  });

  it("returns 400 for signedXdr with hyphen (not standard base64)", async () => {
    // URL-safe base64 uses - and _ which are not standard base64
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: "AAAAAgAA-A==" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/base64/i);
  });

  it("returns 400 for signedXdr with underscore (URL-safe base64, not standard)", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: "AAAAAgAA_A==" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/base64/i);
  });

  it("returns 400 for signedXdr whose length is not divisible by 4", async () => {
    // 'abc' is 3 chars — not divisible by 4
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: "abc" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/base64/i);
  });

  it("returns 400 for signedXdr with padding in the wrong position", async () => {
    // '=' must only appear at the end in standard base64
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: "=AAAAAAAAAAg=" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/base64/i);
  });

  it("returns 400 for signedXdr with too much padding (3 '=' chars)", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: "AAAA===" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/base64/i);
  });

  // -------------------------------------------------------------------------
  // Valid input accepted
  // -------------------------------------------------------------------------

  it("accepts a well-formed base64 string and calls sendTransaction", async () => {
    mockSendTransaction.mockResolvedValue({ id: "ok" });

    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: "AAAAAAAAAA==" })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });

  it("accepts VALID_SIGNED_XDR and passes it through to the handler", async () => {
    mockSendTransaction.mockResolvedValue({ id: "ok", status: "PENDING" });

    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Response shape on every 400
  // -------------------------------------------------------------------------

  it("every validation failure returns ValidationError format", async () => {
    const invalids = [
      {},
      { signedXdr: "" },
      { signedXdr: 0 },
      { signedXdr: "has space" },
      { signedXdr: "bad!chars" },
      { signedXdr: "notdiv4" },
    ];

    for (const body of invalids) {
      const res = await request(buildApp())
        .post("/api/jobs/submit")
        .send(body)
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("ValidationError");
      expect(res.body.message).toBe("Invalid request parameters");
      expect(Array.isArray(res.body.details)).toBe(true);
      expect(res.body.details.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/jobs/submit – trace logging
// ---------------------------------------------------------------------------

// Helper: return all calls to mockLogger.info whose first argument matches msg
function infoCallsFor(msg: string) {
  return (mockLogger.info as ReturnType<typeof jest.fn>).mock.calls.filter(
    ([m]) => m === msg,
  );
}

describe("POST /api/jobs/submit – trace logging", () => {
  beforeEach(() => {
    mockSendTransaction.mockReset();
    resetSubmitCache();
    (mockLogger.info as ReturnType<typeof jest.fn>).mockClear();
    (mockLogger.warn as ReturnType<typeof jest.fn>).mockClear();
    (mockLogger.error as ReturnType<typeof jest.fn>).mockClear();
  });

  // -------------------------------------------------------------------------
  // Request-received log
  // -------------------------------------------------------------------------

  it("logs 'Submit transaction request received' with traceId and xdrLength on every request", async () => {
    mockSendTransaction.mockResolvedValue({ id: "ok" });

    await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(200);

    const calls = infoCallsFor("Submit transaction request received");
    expect(calls).toHaveLength(1);

    const [, meta] = calls[0] as [string, Record<string, unknown>];
    expect(typeof meta.traceId).toBe("string");
    expect(meta.traceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(meta.xdrLength).toBe(VALID_SIGNED_XDR.length);
  });

  it("xdrLength in request-received log matches the actual signedXdr length", async () => {
    mockSendTransaction.mockResolvedValue({ id: "ok" });
    const xdr = "AAAAAAAAAA=="; // length 12

    await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: xdr })
      .expect(200);

    const [[, meta]] = infoCallsFor("Submit transaction request received") as [string, Record<string, unknown>][];
    expect(meta.xdrLength).toBe(12);
  });

  // -------------------------------------------------------------------------
  // Network-submission log
  // -------------------------------------------------------------------------

  it("logs 'Submitting transaction to network' with traceId before calling sendTransaction", async () => {
    mockSendTransaction.mockResolvedValue({ id: "ok", status: "PENDING" });

    await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(200);

    const calls = infoCallsFor("Submitting transaction to network");
    expect(calls).toHaveLength(1);

    const [, meta] = calls[0] as [string, Record<string, unknown>];
    expect(typeof meta.traceId).toBe("string");
  });

  // -------------------------------------------------------------------------
  // Success log
  // -------------------------------------------------------------------------

  it("logs 'Transaction submitted successfully' with traceId, status, and hash on success", async () => {
    const mockResult = { id: "tx-123", status: "PENDING", hash: "abc123" };
    mockSendTransaction.mockResolvedValue(mockResult);

    await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(200);

    const calls = infoCallsFor("Transaction submitted successfully");
    expect(calls).toHaveLength(1);

    const [, meta] = calls[0] as [string, Record<string, unknown>];
    expect(typeof meta.traceId).toBe("string");
    expect(meta.status).toBe("PENDING");
    expect(meta.hash).toBe("abc123");
  });

  it("success log traceId matches the request-received traceId (same request)", async () => {
    mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: "h1" });

    await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(200);

    const receivedId = (infoCallsFor("Submit transaction request received")[0] as [string, Record<string, unknown>])[1].traceId;
    const successId = (infoCallsFor("Transaction submitted successfully")[0] as [string, Record<string, unknown>])[1].traceId;

    expect(receivedId).toBe(successId);
  });

  it("logs undefined status/hash gracefully when result has neither field", async () => {
    mockSendTransaction.mockResolvedValue({ id: "no-status" });

    await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(200);

    const calls = infoCallsFor("Transaction submitted successfully");
    expect(calls).toHaveLength(1);
    const [, meta] = calls[0] as [string, Record<string, unknown>];
    // Should not throw – just logs undefined
    expect(meta.status).toBeUndefined();
    expect(meta.hash).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Error log
  // -------------------------------------------------------------------------

  it("logs 'Failed to submit transaction' with traceId and error message on RPC failure", async () => {
    mockSendTransaction.mockRejectedValue(new Error("rpc unavailable"));

    await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(500);

    const errorCalls = (mockLogger.error as ReturnType<typeof jest.fn>).mock.calls.filter(
      ([m]) => m === "Failed to submit transaction",
    );
    expect(errorCalls).toHaveLength(1);

    const [, meta] = errorCalls[0] as [string, Record<string, unknown>];
    expect(typeof meta.traceId).toBe("string");
    expect(meta.error).toBe("rpc unavailable");
  });

  it("error log traceId matches the request-received traceId (same request)", async () => {
    mockSendTransaction.mockRejectedValue(new Error("boom"));

    await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(500);

    const receivedId = (infoCallsFor("Submit transaction request received")[0] as [string, Record<string, unknown>])[1].traceId;
    const errorCalls = (mockLogger.error as ReturnType<typeof jest.fn>).mock.calls.filter(
      ([m]) => m === "Failed to submit transaction",
    );
    const errorId = (errorCalls[0] as [string, Record<string, unknown>])[1].traceId;

    expect(receivedId).toBe(errorId);
  });

  // -------------------------------------------------------------------------
  // Cache-hit log
  // -------------------------------------------------------------------------

  it("logs 'Submit result served from cache' with traceId and source='cache' on cache hit", async () => {
    mockSendTransaction.mockResolvedValue({ id: "cached" });
    const app = buildApp();

    // Prime the cache
    await request(app).post("/api/jobs/submit").send({ signedXdr: VALID_SIGNED_XDR }).expect(200);
    (mockLogger.info as ReturnType<typeof jest.fn>).mockClear();

    // Second request hits the cache
    await request(app).post("/api/jobs/submit").send({ signedXdr: VALID_SIGNED_XDR }).expect(200);

    const calls = infoCallsFor("Submit result served from cache");
    expect(calls).toHaveLength(1);

    const [, meta] = calls[0] as [string, Record<string, unknown>];
    expect(typeof meta.traceId).toBe("string");
    expect(meta.source).toBe("cache");
  });

  // -------------------------------------------------------------------------
  // Validation-rejection warn log
  // -------------------------------------------------------------------------

  it("logs a warn with xdrLength when signedXdr is a string that fails validation", async () => {
    await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: "bad!chars" })
      .expect(400);

    const warnCalls = (mockLogger.warn as ReturnType<typeof jest.fn>).mock.calls.filter(
      ([m]) => m === "Invalid submit request body",
    );
    expect(warnCalls).toHaveLength(1);

    const [, meta] = warnCalls[0] as [string, Record<string, unknown>];
    expect((meta.xdrLength as number)).toBe(9); // "bad!chars".length === 9
  });

  it("logs a warn without xdrLength when signedXdr is not a string", async () => {
    await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: 12345 })
      .expect(400);

    const warnCalls = (mockLogger.warn as ReturnType<typeof jest.fn>).mock.calls.filter(
      ([m]) => m === "Invalid submit request body",
    );
    expect(warnCalls).toHaveLength(1);

    const [, meta] = warnCalls[0] as [string, Record<string, unknown>];
    expect(meta.xdrLength).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // traceId uniqueness across requests
  // -------------------------------------------------------------------------

  it("each request gets a distinct traceId", async () => {
    mockSendTransaction.mockResolvedValue({ id: "ok" });
    const app = buildApp();

    // Two sequential requests
    await request(app).post("/api/jobs/submit").send({ signedXdr: VALID_SIGNED_XDR }).expect(200);
    resetSubmitCache();
    await request(app).post("/api/jobs/submit").send({ signedXdr: VALID_SIGNED_XDR }).expect(200);

    const receivedCalls = infoCallsFor("Submit transaction request received");
    expect(receivedCalls).toHaveLength(2);

    const id1 = (receivedCalls[0] as [string, Record<string, unknown>])[1].traceId;
    const id2 = (receivedCalls[1] as [string, Record<string, unknown>])[1].traceId;
    expect(id1).not.toBe(id2);
  });

  // -------------------------------------------------------------------------
  // No success log on error path
  // -------------------------------------------------------------------------

  it("does not log 'Transaction submitted successfully' when the RPC call fails", async () => {
    mockSendTransaction.mockRejectedValue(new Error("network down"));

    await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(500);

    expect(infoCallsFor("Transaction submitted successfully")).toHaveLength(0);
  });

  it("does not log 'Failed to submit transaction' on the success path", async () => {
    mockSendTransaction.mockResolvedValue({ id: "ok" });

    await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(200);

    const errorCalls = (mockLogger.error as ReturnType<typeof jest.fn>).mock.calls.filter(
      ([m]) => m === "Failed to submit transaction",
    );
    expect(errorCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/jobs/submit – sourceAddress validation
// ---------------------------------------------------------------------------

// Pull the mocked StrKey so individual tests can control its return value.
const { StrKey: MockStrKey } = await import("@stellar/stellar-sdk");
const mockIsValidEd25519 = MockStrKey.isValidEd25519PublicKey as ReturnType<typeof jest.fn>;

// A realistic-looking but invalid Stellar address (wrong checksum / structure)
const INVALID_ADDRESS = "GBADADDRESS_NOT_VALID_STELLAR_PUBLIC_KEY_FORMAT_123456789012";
// A valid-length G... address that the SDK would accept
const VALID_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

describe("POST /api/jobs/submit – sourceAddress validation", () => {
  beforeEach(() => {
    mockSendTransaction.mockReset();
    resetSubmitCache();
    // Default: SDK accepts all addresses
    mockIsValidEd25519.mockReturnValue(true);
  });

  it("accepts a valid sourceAddress alongside signedXdr", async () => {
    mockSendTransaction.mockResolvedValue({ id: "ok", status: "PENDING" });

    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR, sourceAddress: VALID_ADDRESS })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });

  it("succeeds without sourceAddress (field is optional)", async () => {
    mockSendTransaction.mockResolvedValue({ id: "ok" });

    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(200);

    expect(res.body.success).toBe(true);
  });

  it("returns 400 when sourceAddress is not a valid Stellar address", async () => {
    mockIsValidEd25519.mockReturnValue(false);

    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR, sourceAddress: INVALID_ADDRESS })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/sourceAddress/i);
    expect(res.body.details[0].message).toMatch(/valid Stellar account address/i);
  });

  it("returns 400 when sourceAddress is an empty string", async () => {
    mockIsValidEd25519.mockReturnValue(false);

    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR, sourceAddress: "" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(typeof res.body.error).toBe("string");
  });

  it("returns 400 when sourceAddress is a number", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR, sourceAddress: 12345 })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(typeof res.body.error).toBe("string");
  });

  it("returns 400 when sourceAddress starts with C (contract address, not account)", async () => {
    // Contract addresses start with C and fail isValidEd25519PublicKey
    mockIsValidEd25519.mockReturnValue(false);

    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR, sourceAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/valid Stellar account address/i);
  });

  it("validation failure response has exactly { success, error } keys", async () => {
    mockIsValidEd25519.mockReturnValue(false);

    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR, sourceAddress: INVALID_ADDRESS })
      .expect(400);

    expect(Object.keys(res.body).sort()).toEqual(
      ["details", "error", "message", "success"].sort(),
    );
    expect(res.body.success).toBe(false);
    expect(typeof res.body.error).toBe("string");
  });
});
