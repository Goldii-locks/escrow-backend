// __tests__/get-job-auth.test.ts
import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { jobRetval, JOB_PARTIES } from "./helpers/job-retval.js";

// Mock Stellar SDK RPC server
const mockGetAccount = jest.fn<() => Promise<unknown>>();
const mockSimulateTransaction = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getAccount = mockGetAccount;
    simulateTransaction = mockSimulateTransaction;
  },
}));

// Import the router after mocking
const { default: router } = await import("../src/routes/jobs.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", router);
  return app;
}

describe("GET /api/jobs/:contractId with API key authentication", () => {
  const VALID_CONTRACT = "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";
  const originalApiKey = process.env.API_KEY;

  beforeEach(() => {
    mockGetAccount.mockReset();
    mockSimulateTransaction.mockReset();
    mockGetAccount.mockResolvedValue({
      accountId: () => "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
      sequenceNumber: () => "123456789",
      incrementSequenceNumber: () => {},
    });
    // Ensure API key env is set for tests requiring auth
    process.env.API_KEY = "test-secret-key";
  });

  afterAll(() => {
    if (originalApiKey === undefined) {
      delete process.env.API_KEY;
    } else {
      process.env.API_KEY = originalApiKey;
    }
  });

  it("returns 200 with job data when a valid API key is provided", async () => {
    const retval = jobRetval({
      funded: true,
      milestones: [{ amount: "100", status: "Pending" }],
    });
    mockSimulateTransaction.mockResolvedValue({ result: { retval } });

    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}`)
      .set("x-api-key", "test-secret-key")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(VALID_CONTRACT);
    expect(res.body.data.client).toBe(JOB_PARTIES.client);
    expect(res.body.data.milestones).toEqual([{ index: 0, amount: "100", status: "Pending" }]);
  });
});
