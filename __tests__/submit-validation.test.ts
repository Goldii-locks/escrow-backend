import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";

process.env.NODE_ENV = "test";

const mockSendTransaction = jest.fn<() => Promise<unknown>>();
const mockFromXDR = jest.fn<() => unknown>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    sendTransaction = mockSendTransaction;
  },
}));

jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  Contract: class {},
  Networks: { TESTNET: "Test SDF Network ; September 2015" },
  TransactionBuilder: { fromXDR: mockFromXDR },
  BASE_FEE: "100",
  nativeToScVal: jest.fn(),
  Address: { fromString: jest.fn(() => ({ toScVal: jest.fn() })) },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true), isValidContract: jest.fn(() => true) },
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.unstable_mockModule("../src/middleware/rateLimiter.js", () => ({
  strictLimiter: (_req: any, _res: any, next: any) => next(),
  generalLimiter: (_req: any, _res: any, next: any) => next(),
  walletLookupLimiter: (_req: any, _res: any, next: any) => next(),
}));

const { default: router } = await import("../src/routes/jobs.js");
const { resetSubmitRateLimitBuckets } = await import(
  "../src/middleware/job-contract-rate-limit.js"
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", router);
  return app;
}

describe("POST /api/jobs/submit – payload validation", () => {
  beforeEach(() => {
    resetSubmitRateLimitBuckets();
    mockSendTransaction.mockReset();
    mockFromXDR.mockReset();
  });

  it("returns 400 for missing signedXdr", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({})
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toBe("signedXdr is required");
  });

  it("returns 400 for non-string signedXdr", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: 123 })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/string/i);
  });

  it("returns 400 for empty signedXdr", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: "" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toBe("signedXdr cannot be empty");
  });

  it("returns standard error shape for invalid payloads", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send(null as any) // cast to any so TypeScript accepts sending `null` in the test
      .expect(400);

    expect(res.body).toMatchObject({ success: false, error: expect.any(String) });
  });

  it("allows valid payloads through to the submit handler", async () => {
    mockFromXDR.mockReturnValue({});
    mockSendTransaction.mockResolvedValue({ success: true });

    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: "AAAAAQ==" })
      .expect(200);

    expect(res.body).toEqual({ success: true, data: { success: true } });
  });
});
