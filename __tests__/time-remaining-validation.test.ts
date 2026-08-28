import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";

const VALID_CONTRACT = "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";

const mockGetAccount = jest.fn<() => Promise<unknown>>();
const mockSimulateTransaction = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getAccount = mockGetAccount;
    simulateTransaction = mockSimulateTransaction;
  },
}));

const { default: router } = await import("../src/routes/jobs.js");
const { resetTimeRemainingRateLimitBuckets } = await import(
  "../src/middleware/job-contract-rate-limit.js"
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", router);
  return app;
}

describe("GET /api/jobs/:contractId/milestones/:index/time-remaining", () => {
  beforeEach(() => {
    resetTimeRemainingRateLimitBuckets();
    mockGetAccount.mockReset();
    mockSimulateTransaction.mockReset();

    mockGetAccount.mockResolvedValue({
      accountId: () => "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    });
  });

  // 1. Valid Request
  it("returns 200 with secondsRemaining on valid input", async () => {
    mockSimulateTransaction.mockResolvedValue({
      result: {
        retval: 120, // returns 120 seconds remaining
      },
    });

    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`)
      .expect(200);

    expect(res.body).toEqual({ success: true, data: { secondsRemaining: 120 } });
    expect(mockGetAccount).toHaveBeenCalled();
    expect(mockSimulateTransaction).toHaveBeenCalled();
  });

  // 2. Invalid contractId
  it("returns 400 for an invalid contractId", async () => {
    const res = await request(buildApp())
      .get("/api/jobs/not-a-valid-contract/milestones/0/time-remaining")
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toBe("contractId must be a valid Stellar contract address (C...)");
    expect(mockGetAccount).not.toHaveBeenCalled();
    expect(mockSimulateTransaction).not.toHaveBeenCalled();
  });

  it("returns 400 for a Stellar account address (G...) used as contractId", async () => {
    const res = await request(buildApp())
      .get(
        "/api/jobs/GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX/milestones/0/time-remaining"
      )
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.details[0].message).toMatch(/valid Stellar contract address/i);
    expect(mockGetAccount).not.toHaveBeenCalled();
    expect(mockSimulateTransaction).not.toHaveBeenCalled();
  });

  it("returns 400 for a contractId that is too short", async () => {
    const short = "C" + "A".repeat(40);
    const res = await request(buildApp())
      .get(`/api/jobs/${short}/milestones/0/time-remaining`)
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.details[0].message).toMatch(/valid Stellar contract address/i);
    expect(mockGetAccount).not.toHaveBeenCalled();
    expect(mockSimulateTransaction).not.toHaveBeenCalled();
  });

  it("returns 400 for a contractId that is too long", async () => {
    const long = "C" + "A".repeat(60);
    const res = await request(buildApp())
      .get(`/api/jobs/${long}/milestones/0/time-remaining`)
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.details[0].message).toMatch(/valid Stellar contract address/i);
    expect(mockGetAccount).not.toHaveBeenCalled();
    expect(mockSimulateTransaction).not.toHaveBeenCalled();
  });

  // 3. Invalid milestone index
  it("returns 400 for a non-numeric index", async () => {
    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}/milestones/abc/time-remaining`)
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toBe("index must be a non-negative integer");
    expect(mockGetAccount).not.toHaveBeenCalled();
    expect(mockSimulateTransaction).not.toHaveBeenCalled();
  });

  it("returns 400 for a decimal index", async () => {
    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}/milestones/1.5/time-remaining`)
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.details[0].message).toMatch(/index/i);
    expect(mockGetAccount).not.toHaveBeenCalled();
    expect(mockSimulateTransaction).not.toHaveBeenCalled();
  });

  it("returns 400 for a negative index", async () => {
    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}/milestones/-5/time-remaining`)
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.details[0].message).toMatch(/index/i);
    expect(mockGetAccount).not.toHaveBeenCalled();
    expect(mockSimulateTransaction).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty index", async () => {
    // If we have a route `/api/jobs/:contractId/milestones//time-remaining`,
    // it won't even match this endpoint or Express router might treat it as a different route,
    // but we can test this to ensure correct routing or behavior.
    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}/milestones//time-remaining`);

    // In Express, `/milestones//time-remaining` might be resolved differently (e.g. 404),
    // let's assert on status is either 404 or 400.
    expect([400, 404]).toContain(res.status);
  });
});
