import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { autoAuth } from "./helpers/api-key-helper.js";

/**
 * GET /api/jobs/:contractId/fee-preview (#719): a read-only simulation of the
 * contract's calculate_platform_fee_split, with amounts returned as strings,
 * a response cache, in-flight deduplication and classified error mapping.
 */

const VALID_CONTRACT = "CARZQMYKDGA4TTIE2XBDJ42EX27VYLLJGGG4WGUIXXWIVHPDTX3UCLJA";
const URL = `/api/jobs/${VALID_CONTRACT}/fee-preview`;

const mockGetAccount = jest.fn<() => Promise<unknown>>();
const mockSimulateTransaction = jest.fn<() => Promise<unknown>>();
const mockSendTransaction = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getAccount = mockGetAccount;
    simulateTransaction = mockSimulateTransaction;
    sendTransaction = mockSendTransaction;
  },
}));

const { default: router, feePreviewCache, resetFeePreviewCache } = await import(
  "../src/routes/jobs.js"
);
const { resetJobContractRateLimitBuckets } = await import(
  "../src/middleware/job-contract-rate-limit.js"
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(autoAuth);
  app.use("/api/jobs", router);
  return app;
}

/** A PlatformFeeDistribution-shaped struct as the contract returns it. */
function splitRetval(fields: Record<string, bigint>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.entries(fields).map(
      ([k, v]) =>
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol(k),
          val: nativeToScVal(v, { type: "i128" }),
        }),
    ),
  );
}

const SPLIT = {
  client_amount: 250n,
  freelancer_amount: 250n,
  // Above 2^53 to prove amounts survive as exact strings.
  treasury_amount: 9007199254740993n,
};

beforeEach(() => {
  resetFeePreviewCache();
  resetJobContractRateLimitBuckets();
  mockGetAccount.mockReset();
  mockSimulateTransaction.mockReset();
  mockSendTransaction.mockReset();
  mockGetAccount.mockResolvedValue({
    accountId: () => Keypair.random().publicKey(),
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  });
});

describe("GET /:contractId/fee-preview", () => {
  it("returns the simulated split with every amount as a decimal string", async () => {
    mockSimulateTransaction.mockResolvedValue({ result: { retval: splitRetval(SPLIT) } });

    const res = await request(buildApp()).get(`${URL}?amount=1000`).expect(200);

    expect(res.body).toEqual({
      success: true,
      data: {
        client_amount: "250",
        freelancer_amount: "250",
        treasury_amount: "9007199254740993",
      },
    });
    // Read-only: nothing is ever submitted.
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it("serves a repeat request from the cache without simulating again", async () => {
    mockSimulateTransaction.mockResolvedValue({ result: { retval: splitRetval(SPLIT) } });
    const app = buildApp();

    await request(app).get(`${URL}?amount=1000`).expect(200);
    const second = await request(app).get(`${URL}?amount=1000`).expect(200);

    expect(second.body.data.treasury_amount).toBe("9007199254740993");
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("caches per amount", async () => {
    mockSimulateTransaction.mockResolvedValue({ result: { retval: splitRetval(SPLIT) } });
    const app = buildApp();

    await request(app).get(`${URL}?amount=1000`).expect(200);
    await request(app).get(`${URL}?amount=2000`).expect(200);

    expect(mockSimulateTransaction).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent identical requests onto one simulation", async () => {
    let release!: (v: unknown) => void;
    mockSimulateTransaction.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const app = buildApp();
    const first = request(app).get(`${URL}?amount=1000`).then((r) => r);
    const second = request(app).get(`${URL}?amount=1000`).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    release({ result: { retval: splitRetval(SPLIT) } });

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.status).toBe(200);
    expect(r2.body).toEqual(r1.body);
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["contract not found", 404, "Contract not found on network"],
    ["HostError: contract error #2", 422, "Contract execution reverted (error code 2)"],
    ["host unreachable: secret-internal-detail", 500, "Internal server error"],
  ])("maps simulation error %j to %i without caching it", async (raw, status, error) => {
    mockSimulateTransaction.mockResolvedValue({ error: raw });
    const app = buildApp();

    const res = await request(app).get(`${URL}?amount=1000`).expect(status);
    expect(res.body).toEqual({ success: false, error });
    expect(res.text).not.toContain("secret-internal-detail");
    expect(feePreviewCache.keys()).toHaveLength(0);

    // Not cached: a retry simulates again.
    await request(app).get(`${URL}?amount=1000`).expect(status);
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(2);
  });

  it("returns 500 for an empty retval", async () => {
    mockSimulateTransaction.mockResolvedValue({ result: {} });
    const res = await request(buildApp()).get(`${URL}?amount=1000`).expect(500);
    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expect(feePreviewCache.keys()).toHaveLength(0);
  });

  it("returns a clean 500 when the RPC call throws", async () => {
    mockGetAccount.mockRejectedValue(new Error("secret-internal-detail"));
    const res = await request(buildApp()).get(`${URL}?amount=1000`).expect(500);
    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expect(res.text).not.toContain("secret-internal-detail");
  });

  it.each([
    ["missing", ""],
    ["zero", "?amount=0"],
    ["negative", "?amount=-5"],
    ["non-numeric", "?amount=abc"],
    ["decimal", "?amount=1.5"],
    ["hex", "?amount=0x10"],
    ["above i128 max", `?amount=${(1n << 127n).toString()}`],
  ])("rejects a %s amount with 400 before any RPC call", async (_label, query) => {
    const res = await request(buildApp()).get(`${URL}${query}`).expect(400);
    expect(res.body.success).toBe(false);
    expect(mockGetAccount).not.toHaveBeenCalled();
    expect(mockSimulateTransaction).not.toHaveBeenCalled();
  });

  it("accepts the i128 maximum", async () => {
    mockSimulateTransaction.mockResolvedValue({ result: { retval: splitRetval(SPLIT) } });
    await request(buildApp())
      .get(`${URL}?amount=${((1n << 127n) - 1n).toString()}`)
      .expect(200);
  });

  it("rejects an invalid contractId with 400", async () => {
    await request(buildApp()).get("/api/jobs/not-a-contract/fee-preview?amount=1").expect(400);
    expect(mockSimulateTransaction).not.toHaveBeenCalled();
  });
});
