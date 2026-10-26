import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { Account, Networks, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";

/**
 * #681: one inclusion-fee helper for every transaction the backend builds,
 * configurable as a fixed fee or derived from RPC fee stats.
 */

const VALID_CONTRACT = "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";
const VALID_ADDRESS = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";

const mockGetAccount = jest.fn<() => Promise<unknown>>();
const mockPrepareTransaction = jest.fn(async (tx: Transaction) => tx);
const mockGetFeeStats = jest.fn<() => Promise<{ sorobanInclusionFee: { p90: string } }>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getAccount = mockGetAccount;
    prepareTransaction = mockPrepareTransaction;
    getFeeStats = mockGetFeeStats;
  },
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: router, resetBuildTxCache } = await import("../src/routes/jobs.js");
const { resetBuildTxRateLimitBuckets } = await import(
  "../src/middleware/job-contract-rate-limit.js"
);
const {
  getInclusionFee,
  resetInclusionFeeCache,
  resolveFixedInclusionFee,
  resolveInclusionFeeStrategy,
} = await import("../src/utils/fee-helper.js");

const app = express();
app.use(express.json());
app.use("/api/jobs", router);

const FEE_ENV = [
  "INCLUSION_FEE_STROOPS",
  "INCLUSION_FEE_STRATEGY",
  "MAX_INCLUSION_FEE_STROOPS",
  "INCLUSION_FEE_CACHE_TTL_S",
] as const;
const savedEnv: Record<string, string | undefined> = {};

const feeStats = (p90: string) => ({ sorobanInclusionFee: { p90 } });
const source = { getFeeStats: mockGetFeeStats };

function feeOf(envelope: string): string {
  return (TransactionBuilder.fromXDR(envelope, Networks.TESTNET) as Transaction).fee;
}

async function buildFundTx(): Promise<string> {
  const res = await request(app)
    .post("/api/jobs/build-tx")
    .send({ contractId: VALID_CONTRACT, method: "fund", args: [], sourceAddress: VALID_ADDRESS })
    .expect(200);
  return res.body.data.xdr;
}

beforeEach(() => {
  for (const key of FEE_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetInclusionFeeCache();
  resetBuildTxCache();
  resetBuildTxRateLimitBuckets();
  mockGetFeeStats.mockReset();
  mockPrepareTransaction.mockClear();
  mockGetAccount.mockReset();
  mockGetAccount.mockImplementation(async () => new Account(VALID_ADDRESS, "1"));
});

afterEach(() => {
  jest.useRealTimers();
  for (const key of FEE_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("fixed strategy", () => {
  it("defaults to BASE_FEE (100 stroops) without calling fee stats", async () => {
    expect(resolveInclusionFeeStrategy()).toBe("fixed");
    expect(resolveFixedInclusionFee()).toBe(100);
    expect(feeOf(await buildFundTx())).toBe("100");
    expect(mockGetFeeStats).not.toHaveBeenCalled();
  });

  it("INCLUSION_FEE_STROOPS=1000 sets the fee in the built XDR", async () => {
    process.env.INCLUSION_FEE_STROOPS = "1000";
    expect(feeOf(await buildFundTx())).toBe("1000");
  });

  it.each([["0"], ["-5"], ["abc"], ["1.5"]])(
    "ignores an invalid INCLUSION_FEE_STROOPS=%s",
    async (value) => {
      process.env.INCLUSION_FEE_STROOPS = value;
      expect(await getInclusionFee(source)).toBe("100");
    },
  );
});

describe("feeStats strategy", () => {
  beforeEach(() => {
    process.env.INCLUSION_FEE_STRATEGY = "feeStats";
  });

  it("uses sorobanInclusionFee.p90 from RPC", async () => {
    mockGetFeeStats.mockResolvedValue(feeStats("5000"));
    expect(await getInclusionFee(source)).toBe("5000");
  });

  it("puts the p90 fee into the built XDR", async () => {
    mockGetFeeStats.mockResolvedValue(feeStats("4321"));
    expect(feeOf(await buildFundTx())).toBe("4321");
  });

  it("caps the fee at MAX_INCLUSION_FEE_STROOPS", async () => {
    process.env.MAX_INCLUSION_FEE_STROOPS = "2000";
    mockGetFeeStats.mockResolvedValue(feeStats("999999"));
    expect(await getInclusionFee(source)).toBe("2000");
  });

  it("never goes below the fixed fee", async () => {
    process.env.INCLUSION_FEE_STROOPS = "300";
    mockGetFeeStats.mockResolvedValue(feeStats("120"));
    expect(await getInclusionFee(source)).toBe("300");
  });

  it("caches fee stats for INCLUSION_FEE_CACHE_TTL_S and shares concurrent lookups", async () => {
    process.env.INCLUSION_FEE_CACHE_TTL_S = "15";
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    mockGetFeeStats.mockResolvedValue(feeStats("5000"));

    await Promise.all([getInclusionFee(source), getInclusionFee(source)]);
    await getInclusionFee(source);
    expect(mockGetFeeStats).toHaveBeenCalledTimes(1);

    mockGetFeeStats.mockResolvedValue(feeStats("6000"));
    jest.advanceTimersByTime(15_001);
    expect(await getInclusionFee(source)).toBe("6000");
    expect(mockGetFeeStats).toHaveBeenCalledTimes(2);
  });

  it("falls back to the fixed fee when fee stats fail or are malformed", async () => {
    process.env.INCLUSION_FEE_STROOPS = "250";
    mockGetFeeStats.mockRejectedValueOnce(new Error("rpc down"));
    expect(await getInclusionFee(source)).toBe("250");

    mockGetFeeStats.mockResolvedValueOnce(feeStats("not-a-number"));
    expect(await getInclusionFee(source)).toBe("250");
  });
});
