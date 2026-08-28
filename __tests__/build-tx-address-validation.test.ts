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

const { default: router } = await import("../src/routes/jobs.js");
const { resetBuildTxRateLimitBuckets } = await import(
  "../src/middleware/job-contract-rate-limit.js"
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", router);
  return app;
}

const VALID_BODY = {
  contractId: "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH",
  method: "fund_job",
  args: [],
  sourceAddress: "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
};

describe("POST /api/jobs/build-tx – Stellar address validation", () => {
  beforeEach(() => {
    resetBuildTxRateLimitBuckets();
    mockGetAccount.mockReset();
    mockPrepareTransaction.mockReset();
    mockGetAccount.mockResolvedValue({
      accountId: () => VALID_BODY.sourceAddress,
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    });
  });

  it("accepts a valid Stellar address", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAAAQ==" });

    const res = await request(buildApp())
      .post("/api/jobs/build-tx")
      .send(VALID_BODY)
      .expect(200);

    expect(res.body.success).toBe(true);
  });

  it("rejects a malformed Stellar address", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/build-tx")
      .send({ ...VALID_BODY, sourceAddress: "not-a-valid-address" })
      .expect(400);

    expect(res.body).toMatchObject({ success: false, error: expect.any(String) });
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/sourceAddress/i);
  });

  it("rejects a wrong-length Stellar address", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/build-tx")
      .send({ ...VALID_BODY, sourceAddress: "G".repeat(10) })
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("rejects a wrong-charset Stellar address", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/build-tx")
      .send({ ...VALID_BODY, sourceAddress: "$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$" })
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("rejects a missing address field", async () => {
    const { sourceAddress, ...rest } = VALID_BODY;
    const res = await request(buildApp())
      .post("/api/jobs/build-tx")
      .send(rest)
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/sourceAddress/i);
  });

  it("returns a structured error payload for invalid addresses", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/build-tx")
      .send({ ...VALID_BODY, sourceAddress: "bad-address" })
      .expect(400);

    expect(res.body).toMatchObject({ success: false, error: expect.any(String) });
  });
});
