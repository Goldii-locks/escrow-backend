import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";

const VALID_CONTRACT =
  "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";

const mockGetAccount = jest.fn<() => Promise<unknown>>();
const mockSimulateTransaction = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getAccount = mockGetAccount;
    simulateTransaction = mockSimulateTransaction;
  },
}));

const { default: router } = await import("../src/routes/jobs.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", router);
  return app;
}

describe("GET /api/jobs/:contractId – response format and status codes", () => {
  const originalApiKey = process.env.API_KEY;

  beforeEach(() => {
    mockGetAccount.mockReset();
    mockSimulateTransaction.mockReset();
    delete process.env.API_KEY;
    mockGetAccount.mockResolvedValue({
      accountId: () =>
        "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
      sequenceNumber: () => "123456789",
      incrementSequenceNumber: () => {},
    });
  });

  afterAll(() => {
    if (originalApiKey === undefined) {
      delete process.env.API_KEY;
    } else {
      process.env.API_KEY = originalApiKey;
    }
  });

  it("returns 400 with a standardized error body for invalid contractId", async () => {
    const res = await request(buildApp())
      .get("/api/jobs/not-a-contract")
      .expect(400);

    expect(res.body).toEqual({
      success: false,
      error: "contractId must be a valid Stellar contract address (C...)",
    });
  });

  it("returns 401 when API_KEY is configured and the header is missing", async () => {
    process.env.API_KEY = "secret-key";

    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}`)
      .expect(401);

    expect(res.body).toEqual({ success: false, error: "Unauthorized" });
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it("returns 401 when API_KEY is configured and the header is wrong", async () => {
    process.env.API_KEY = "secret-key";

    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}`)
      .set("x-api-key", "wrong-key")
      .expect(401);

    expect(res.body).toEqual({ success: false, error: "Unauthorized" });
  });

  it("returns 404 when simulation reports the job was not found", async () => {
    mockSimulateTransaction.mockResolvedValue({
      error: "contract not found on network",
    });

    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}`)
      .expect(404);

    expect(res.body).toEqual({ success: false, error: "Job not found" });
  });

  it("returns 404 when simulation succeeds but no job payload is present", async () => {
    mockSimulateTransaction.mockResolvedValue({ result: { retval: null } });

    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}`)
      .expect(404);

    expect(res.body).toEqual({ success: false, error: "Job not found" });
  });

  it("returns 500 for unexpected simulation failures", async () => {
    mockSimulateTransaction.mockResolvedValue({
      error: "host unreachable",
    });

    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}`)
      .expect(500);

    expect(res.body).toEqual({ success: false, error: "host unreachable" });
  });

  it("returns 500 when the RPC client throws", async () => {
    mockGetAccount.mockRejectedValue(new Error("upstream failure"));

    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}`)
      .expect(500);

    expect(res.body).toEqual({ success: false, error: "upstream failure" });
  });

  it("returns 200 with a standardized success envelope for a valid job", async () => {
    const milestones = {
      map: (fn: (m: unknown, i: number) => unknown) =>
        [{ amount: () => ({ toString: () => "100" }), status: () => ({ funded: true }) }].map(
          fn
        ),
    };
    const retval = {
      client: () => ({ toString: () => "GCLIENT" }),
      freelancer: () => ({ toString: () => "GFREELANCER" }),
      arbiter: () => ({ toString: () => "GARBITER" }),
      token: () => ({ toString: () => "GTOKEN" }),
      funded: () => true,
      milestones: () => milestones,
    };

    mockSimulateTransaction.mockResolvedValue({
      result: { retval },
    });

    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      id: VALID_CONTRACT,
      client: "GCLIENT",
      freelancer: "GFREELANCER",
      arbiter: "GARBITER",
      token: "GTOKEN",
      funded: true,
    });
    expect(Array.isArray(res.body.data.milestones)).toBe(true);
  });
});
