/**
 * #865: GET /api/jobs/tx/:hash with the RPC mocked.
 */
import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { xdr } from "@stellar/stellar-sdk";

const mockGetTransaction = jest.fn<(hash: string) => Promise<unknown>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getTransaction = mockGetTransaction;
  },
}));

const { default: router, resetTxStatusCache } = await import("../src/routes/jobs.js");
const { resetJobContractRateLimitBuckets } = await import(
  "../src/middleware/job-contract-rate-limit.js"
);

const HASH = "a".repeat(64);

function buildApp() {
  const app = express();
  app.use("/api/jobs", router);
  return app;
}

function resultXdr(code: "txSuccess" | "txFailed") {
  return { feeCharged: 100n, result: { type: code } };
}

function contractErrorEvent(code: number) {
  return {
    inSuccessfulContractCall: false,
    event: {
      body: {
        v0: {
          topics: [xdr.ScVal.scvSymbol("error")],
          data: xdr.ScVal.scvError(xdr.ScError.sceContract(code)),
        },
      },
    },
  };
}

beforeEach(() => {
  mockGetTransaction.mockReset();
  resetTxStatusCache();
  resetJobContractRateLimitBuckets();
});

describe("GET /api/jobs/tx/:hash (#865)", () => {
  it("rejects a hash that is not 64 hex chars", async () => {
    await request(buildApp()).get("/api/jobs/tx/xyz").expect(400);
    expect(mockGetTransaction).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND and never caches it", async () => {
    mockGetTransaction.mockResolvedValue({ status: "NOT_FOUND" });
    const res = await request(buildApp()).get(`/api/jobs/tx/${HASH}`).expect(200);
    expect(res.body.data).toEqual({ status: "NOT_FOUND", ledger: null, createdAt: null, resultCode: null });
    await request(buildApp()).get(`/api/jobs/tx/${HASH}`).expect(200);
    expect(mockGetTransaction).toHaveBeenCalledTimes(2);
  });

  it("returns SUCCESS and caches it", async () => {
    mockGetTransaction.mockResolvedValue({
      status: "SUCCESS", ledger: 1234, createdAt: 1700000000, resultXdr: resultXdr("txSuccess"),
    });
    const res = await request(buildApp()).get(`/api/jobs/tx/${HASH}`).expect(200);
    expect(res.body.data).toEqual({
      status: "SUCCESS", ledger: 1234, createdAt: 1700000000, resultCode: "txSuccess",
    });
    await request(buildApp()).get(`/api/jobs/tx/${HASH}`).expect(200);
    expect(mockGetTransaction).toHaveBeenCalledTimes(1);
  });

  it("maps a FAILED contract error to the classifySimError message", async () => {
    mockGetTransaction.mockResolvedValue({
      status: "FAILED", ledger: 99, createdAt: 1700000001,
      resultXdr: resultXdr("txFailed"),
      diagnosticEventsXdr: [contractErrorEvent(3)],
    });
    const res = await request(buildApp()).get(`/api/jobs/tx/${HASH}`).expect(200);
    expect(res.body.data).toEqual({
      status: "FAILED", ledger: 99, createdAt: 1700000001, resultCode: "txFailed",
      error: "Contract execution reverted (error code 3)",
    });
  });
});
