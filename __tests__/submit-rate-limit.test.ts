import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";

const mockSendTransaction = jest.fn<() => Promise<unknown>>();
const mockTx = { toXDR: () => "mock-xdr" };

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    sendTransaction = mockSendTransaction;
  },
}));

jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  TransactionBuilder: { fromXDR: jest.fn(() => mockTx) },
  Contract: jest.fn(),
  Networks: {
    TESTNET: "Test SDF Network ; September 2015",
    PUBLIC: "Public Global Stellar Network ; September 2015",
  },
  BASE_FEE: "100",
  nativeToScVal: jest.fn(),
  Address: { fromString: jest.fn(() => ({ toScVal: jest.fn() })) },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.unstable_mockModule("../src/middleware/rateLimiter.js", () => ({
  strictLimiter: (_req: any, _res: any, next: any) => next(),
  generalLimiter: (_req: any, _res: any, next: any) => next(),
}));

const { default: router, resetSubmitCache } = await import("../src/routes/jobs.js");
const { resetSubmitRateLimitBuckets } = await import(
  "../src/middleware/job-contract-rate-limit.js"
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", router);
  return app;
}

const VALID_SIGNED_XDR =
  "AAAAAgAAAABz9B8nR7h4qY6Ran5PlacgCUxOFxOdIQAAAAAAAAAAABAAAAAAAAAAAA==";

function setupEnvs(overrides: Record<string, string | undefined>) {
  const restore: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    restore[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  return () => {
    for (const key of Object.keys(restore)) {
      if (restore[key] === undefined) delete process.env[key];
      else process.env[key] = restore[key];
    }
  };
}

describe("POST /api/jobs/submit – dedicated rate limiter", () => {
  beforeEach(() => {
    mockSendTransaction.mockReset();
    resetSubmitCache();
    resetSubmitRateLimitBuckets();
  });

  it("allows requests up to the configured threshold of 3", async () => {
    mockSendTransaction.mockResolvedValue({ id: "ok" });
    const restore = setupEnvs({ SUBMIT_RATE_MAX: "3", SUBMIT_RATE_WINDOW_MS: "60000" });
    const app = buildApp();
    try {
      for (let i = 0; i < 3; i++) {
        const res = await request(app)
          .post("/api/jobs/submit")
          .send({ signedXdr: VALID_SIGNED_XDR });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      }
    } finally {
      restore();
    }
  });

  it("returns 429 Too Many Requests once the threshold is exceeded", async () => {
    mockSendTransaction.mockResolvedValue({ id: "ok" });
    const restore = setupEnvs({ SUBMIT_RATE_MAX: "3", SUBMIT_RATE_WINDOW_MS: "60000" });
    const app = buildApp();
    try {
      for (let i = 0; i < 3; i++) {
        await request(app)
          .post("/api/jobs/submit")
          .send({ signedXdr: VALID_SIGNED_XDR })
          .expect(200);
      }
      const res = await request(app)
        .post("/api/jobs/submit")
        .send({ signedXdr: VALID_SIGNED_XDR })
        .expect(429);
      expect(res.body).toEqual({
        success: false,
        error: "Too many requests, please try again later",
      });
    } finally {
      restore();
    }
  });

  it("sets correct decrementing X-RateLimit-Remaining headers", async () => {
    mockSendTransaction.mockResolvedValue({ id: "ok" });
    const restore = setupEnvs({ SUBMIT_RATE_MAX: "3", SUBMIT_RATE_WINDOW_MS: "60000" });
    const app = buildApp();
    try {
      const r1 = await request(app).post("/api/jobs/submit").send({ signedXdr: VALID_SIGNED_XDR });
      expect(r1.header["x-ratelimit-limit"]).toBe("3");
      expect(r1.header["x-ratelimit-remaining"]).toBe("2");
      const r2 = await request(app).post("/api/jobs/submit").send({ signedXdr: VALID_SIGNED_XDR });
      expect(r2.header["x-ratelimit-remaining"]).toBe("1");
      const r3 = await request(app).post("/api/jobs/submit").send({ signedXdr: VALID_SIGNED_XDR });
      expect(r3.header["x-ratelimit-remaining"]).toBe("0");
    } finally {
      restore();
    }
  });

  it("429 response body contains exactly success and error keys", async () => {
    mockSendTransaction.mockResolvedValue({ id: "ok" });
    const restore = setupEnvs({ SUBMIT_RATE_MAX: "2", SUBMIT_RATE_WINDOW_MS: "60000" });
    const app = buildApp();
    try {
      await request(app).post("/api/jobs/submit").send({ signedXdr: VALID_SIGNED_XDR });
      await request(app).post("/api/jobs/submit").send({ signedXdr: VALID_SIGNED_XDR });
      const res = await request(app)
        .post("/api/jobs/submit")
        .send({ signedXdr: VALID_SIGNED_XDR });
      expect(res.status).toBe(429);
      expect(Object.keys(res.body)).toEqual(["success", "error"]);
    } finally {
      restore();
    }
  });

  it("does not rate-limit other job routes when submit endpoint is throttled", async () => {
    mockSendTransaction.mockResolvedValue({ id: "ok" });
    const restore = setupEnvs({ SUBMIT_RATE_MAX: "2", SUBMIT_RATE_WINDOW_MS: "60000" });
    const app = buildApp();
    try {
      await request(app).post("/api/jobs/submit").send({ signedXdr: VALID_SIGNED_XDR });
      await request(app).post("/api/jobs/submit").send({ signedXdr: VALID_SIGNED_XDR });
      const submitThrottled = await request(app)
        .post("/api/jobs/submit")
        .send({ signedXdr: VALID_SIGNED_XDR });
      expect(submitThrottled.status).toBe(429);
      const byWallet = await request(app).get("/api/jobs/by-wallet/GABC");
      expect(byWallet.status).not.toBe(429);
      const draft = await request(app)
        .post("/api/jobs/create-job-draft")
        .send({ client: "GABC" });
      expect(draft.status).not.toBe(429);
    } finally {
      restore();
    }
  });

  it("resetSubmitRateLimitBuckets clears state between test runs", async () => {
    mockSendTransaction.mockResolvedValue({ id: "ok" });
    const restore = setupEnvs({ SUBMIT_RATE_MAX: "2", SUBMIT_RATE_WINDOW_MS: "60000" });
    const app = buildApp();
    try {
      await request(app).post("/api/jobs/submit").send({ signedXdr: VALID_SIGNED_XDR });
      await request(app).post("/api/jobs/submit").send({ signedXdr: VALID_SIGNED_XDR });
      const before = await request(app)
        .post("/api/jobs/submit")
        .send({ signedXdr: VALID_SIGNED_XDR });
      expect(before.status).toBe(429);
      resetSubmitRateLimitBuckets();
      const after = await request(app)
        .post("/api/jobs/submit")
        .send({ signedXdr: VALID_SIGNED_XDR });
      expect(after.status).toBe(200);
    } finally {
      restore();
    }
  });

  it("uses default SUBMIT_RATE_MAX of 5 req/min when env vars not set", async () => {
    mockSendTransaction.mockResolvedValue({ id: "ok" });
    const restore = setupEnvs({
      SUBMIT_RATE_MAX: undefined,
      SUBMIT_RATE_WINDOW_MS: undefined,
    });
    const app = buildApp();
    try {
      for (let i = 0; i < 5; i++) {
        await request(app)
          .post("/api/jobs/submit")
          .send({ signedXdr: VALID_SIGNED_XDR })
          .expect(200);
      }
      await request(app)
        .post("/api/jobs/submit")
        .send({ signedXdr: VALID_SIGNED_XDR })
        .expect(429);
    } finally {
      restore();
    }
  });

  it("counts validation errors (400) against the rate limit counter", async () => {
    mockSendTransaction.mockResolvedValue({ id: "ok" });
    const restore = setupEnvs({ SUBMIT_RATE_MAX: "3", SUBMIT_RATE_WINDOW_MS: "60000" });
    const app = buildApp();
    try {
      await request(app).post("/api/jobs/submit").send({ signedXdr: "" }).expect(400);
      await request(app).post("/api/jobs/submit").send({ signedXdr: "" }).expect(400);
      await request(app).post("/api/jobs/submit").send({ signedXdr: "" }).expect(400);
      await request(app)
        .post("/api/jobs/submit")
        .send({ signedXdr: VALID_SIGNED_XDR })
        .expect(429);
    } finally {
      restore();
    }
  });
});
