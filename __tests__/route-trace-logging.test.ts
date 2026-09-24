import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { autoAuth, TEST_API_KEY } from "./helpers/api-key-helper.js";

const VALID_CONTRACT = "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";
const VALID_ADDRESS = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";

const VALID_DRAFT_BODY = {
  client: VALID_ADDRESS,
  freelancer: "GB5CRPXUGXZCG6BESL4CM4F3VUAGQGFNYNBHPBRJAGLXXSRYJSEGZHUV",
  arbiter: "GABNCQRZNTG6MMITD33VHFITKJZ5PSYW2XVEXMP52BSMTPLU7WORDQNT",
  token: VALID_CONTRACT,
  autoReleaseDays: 7,
  milestones: [{ amount: "10000000" }],
};

const mockLogger = {
  info: jest.fn<(...args: any[]) => void>(),
  warn: jest.fn<(...args: any[]) => void>(),
  error: jest.fn<(...args: any[]) => void>(),
  debug: jest.fn<(...args: any[]) => void>(),
};

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: mockLogger,
}));

const mockGetAccount = jest.fn<() => Promise<unknown>>();
const mockPrepareTransaction = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: jest.fn().mockImplementation(() => ({
    getAccount: mockGetAccount,
    prepareTransaction: mockPrepareTransaction,
  })),
}));

const { default: router } = await import("../src/routes/jobs.js");
const {
  resetPartialReleaseRateLimitBuckets,
  resetCreateJobDraftRateLimitBuckets,
} = await import("../src/middleware/job-contract-rate-limit.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(autoAuth);
  app.use("/api/jobs", router);
  return app;
}

describe("POST /api/jobs/create-job-draft – Winston trace logging (#234)", () => {
  beforeEach(() => {
    resetCreateJobDraftRateLimitBuckets();
    jest.clearAllMocks();
  });

  it("logs traceId, path variables, and response in JSON metadata", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .send(VALID_DRAFT_BODY)
      .expect(200);

    expect(res.body.success).toBe(true);

    const infoCalls = mockLogger.info.mock.calls.filter(
      (call: any[]) => typeof call[0] === "string" && call[0] === "Job draft created",
    );
    expect(infoCalls.length).toBeGreaterThanOrEqual(1);
    const meta = infoCalls[0][1];
    expect(meta).toMatchObject({
      route: "/api/jobs/create-job-draft",
      milestoneCount: 1,
    });
    expect(typeof meta.traceId).toBe("string");

    const debugCalls = mockLogger.debug.mock.calls.filter(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("handler entered"),
    );
    expect(debugCalls.length).toBeGreaterThanOrEqual(1);
    const entryMeta = debugCalls[0][1];
    expect(entryMeta).toMatchObject({
      route: "/api/jobs/create-job-draft",
    });
    expect(Array.isArray(entryMeta.bodyKeys)).toBe(true);
    expect(typeof entryMeta.traceId).toBe("string");

    const responseCalls = mockLogger.debug.mock.calls.filter(
      (call: any[]) =>
        typeof call[0] === "string" && call[0].includes("response sent"),
    );
    expect(responseCalls.length).toBeGreaterThanOrEqual(1);
    expect(responseCalls[0][1]).toMatchObject({
      status: 200,
      success: true,
    });
  });
});

describe("POST /api/jobs/:contractId/milestones/:index/partial-release – clean 500 (#117)", () => {
  beforeEach(() => {
    resetPartialReleaseRateLimitBuckets();
    jest.clearAllMocks();

    mockGetAccount.mockReset();
    mockPrepareTransaction.mockReset();
    mockGetAccount.mockResolvedValue({
      accountId: () => VALID_ADDRESS,
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    });
  });

  const ENDPOINT = `/api/jobs/${VALID_CONTRACT}/milestones/0/partial-release`;
  const VALID_BODY = { amount: "100", sourceAddress: VALID_ADDRESS };

  it("returns a clean 500 without leaking internal stack trace details", async () => {
    mockPrepareTransaction.mockRejectedValue(
      new Error("secret internal sqlite deadlock details: user@db:3306"),
    );

    const res = await request(buildApp()).post(ENDPOINT).send(VALID_BODY).expect(500);

    // No internal detail (server path, DB names, etc.) may reach the client.
    expect(res.body).toEqual({
      success: false,
      error: "Internal server error",
    });
    expect(JSON.stringify(res.body)).not.toContain("sqlite");
    expect(JSON.stringify(res.body)).not.toContain("deadlock");
    expect(JSON.stringify(res.body)).not.toContain("stack");

    // Full detail is logged server-side with a traceId for correlation.
    const errorCalls = mockLogger.error.mock.calls.filter((call: any[]) => {
      const msg = String(call[0]);
      return (
        msg.includes("Unexpected error in partial release") ||
        msg.includes("Failed to prepare transaction")
      );
    });
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    const meta = errorCalls[0][1];
    expect(meta).toMatchObject({
      contractId: VALID_CONTRACT,
      // `milestoneIndexSchema` transforms the path param to a number and the
      // validate() middleware writes the parsed params back onto req.params,
      // so the handler logs the coerced value rather than the raw string.
      index: 0,
    });
    expect(meta.error).toContain("secret internal");
  });
});
