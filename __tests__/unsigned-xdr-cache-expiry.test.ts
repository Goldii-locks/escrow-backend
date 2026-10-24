import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { Account, Networks, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { autoAuth } from "./helpers/api-key-helper.js";

/**
 * #677: cached unsigned XDRs must never be served once their time bounds are
 * nearly spent, and the bounds themselves must leave the user enough time to
 * sign. Cache TTLs are deliberately set far above the transaction timeout
 * here so the test proves the validity check, not the TTL, does the work.
 */
process.env.BUILD_TX_CACHE_TTL_S = "3600";
process.env.PARTIAL_RELEASE_CACHE_TTL_S = "3600";
process.env.CLAIM_AUTO_RELEASE_CACHE_TTL_S = "3600";
// The clock walk below sends many requests; keep the route limiters out of it.
process.env.BUILD_TX_RATE_MAX = "10000";
process.env.PARTIAL_RELEASE_RATE_MAX = "10000";
process.env.CLAIM_AUTO_RELEASE_RATE_MAX = "10000";

const VALID_CONTRACT = "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";
const VALID_ADDRESS = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";
const START_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

const mockGetAccount = jest.fn<() => Promise<unknown>>();
const mockPrepareTransaction = jest.fn(async (tx: Transaction) => tx);

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getAccount = mockGetAccount;
    prepareTransaction = mockPrepareTransaction;
  },
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  default: router,
  resetBuildTxCache,
  resetPartialReleaseCache,
  resetClaimAutoReleaseCache,
  UNSIGNED_TX_TIMEOUT_S,
  UNSIGNED_TX_MIN_REMAINING_S,
} = await import("../src/routes/jobs.js");
const {
  resetBuildTxRateLimitBuckets,
  resetPartialReleaseRateLimitBuckets,
  resetClaimAutoReleaseRateLimitBuckets,
} = await import("../src/middleware/job-contract-rate-limit.js");

const app = express();
app.use(express.json());
app.use(autoAuth);
app.use("/api/jobs", router);

const ROUTES = [
  {
    name: "build-tx",
    path: "/api/jobs/build-tx",
    body: { contractId: VALID_CONTRACT, method: "fund", args: [], sourceAddress: VALID_ADDRESS },
  },
  {
    name: "partial-release",
    path: `/api/jobs/${VALID_CONTRACT}/milestones/0/partial-release`,
    body: { amount: "100", sourceAddress: VALID_ADDRESS },
  },
  {
    name: "claim-auto-release",
    path: `/api/jobs/${VALID_CONTRACT}/milestones/0/claim-auto-release`,
    body: { sourceAddress: VALID_ADDRESS },
  },
];

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

function setClock(offsetSeconds: number): void {
  jest.setSystemTime(START_MS + offsetSeconds * 1000);
}

function maxTimeOf(envelope: string): number {
  const tx = TransactionBuilder.fromXDR(envelope, Networks.TESTNET) as Transaction;
  return Number(tx.timeBounds?.maxTime);
}

beforeEach(() => {
  // Fake only the clock: supertest needs real timers and I/O callbacks.
  jest.useFakeTimers({
    now: START_MS,
    doNotFake: [
      "nextTick",
      "setImmediate",
      "clearImmediate",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "queueMicrotask",
    ],
  });
  resetBuildTxRateLimitBuckets();
  resetPartialReleaseRateLimitBuckets();
  resetClaimAutoReleaseRateLimitBuckets();
  resetBuildTxCache();
  resetPartialReleaseCache();
  resetClaimAutoReleaseCache();
  mockGetAccount.mockReset();
  mockPrepareTransaction.mockClear();
  mockGetAccount.mockImplementation(async () => new Account(VALID_ADDRESS, "1"));
});

afterEach(() => {
  jest.useRealTimers();
});

it("uses a 120–300s signing window for unsigned transactions", () => {
  expect(UNSIGNED_TX_TIMEOUT_S).toBeGreaterThanOrEqual(120);
  expect(UNSIGNED_TX_TIMEOUT_S).toBeLessThanOrEqual(300);
});

describe.each(ROUTES)("$name unsigned XDR cache (#677)", ({ path, body }) => {
  it("sets time bounds of now + UNSIGNED_TX_TIMEOUT_S", async () => {
    const res = await request(app).post(path).send(body).expect(200);
    expect(maxTimeOf(res.body.xdr)).toBe(nowS() + UNSIGNED_TX_TIMEOUT_S);
  });

  it("serves the cached XDR while enough validity remains", async () => {
    const first = await request(app).post(path).send(body).expect(200);

    setClock(UNSIGNED_TX_TIMEOUT_S - UNSIGNED_TX_MIN_REMAINING_S - 1);
    const second = await request(app).post(path).send(body).expect(200);

    expect(second.body.xdr).toBe(first.body.xdr);
    expect(mockPrepareTransaction).toHaveBeenCalledTimes(1);
  });

  it("rebuilds a fresh XDR for requests late in the validity window", async () => {
    const first = await request(app).post(path).send(body).expect(200);
    const firstMaxTime = maxTimeOf(first.body.xdr);

    setClock(UNSIGNED_TX_TIMEOUT_S - UNSIGNED_TX_MIN_REMAINING_S + 1);
    const late = await request(app).post(path).send(body).expect(200);

    expect(late.body.xdr).not.toBe(first.body.xdr);
    expect(mockPrepareTransaction).toHaveBeenCalledTimes(2);
    expect(maxTimeOf(late.body.xdr)).toBe(nowS() + UNSIGNED_TX_TIMEOUT_S);
    expect(maxTimeOf(late.body.xdr)).toBeGreaterThan(firstMaxTime);
  });

  it("never serves an XDR with less than the minimum signing window left", async () => {
    // Walk the clock well past several transaction lifetimes.
    for (let t = 0; t <= UNSIGNED_TX_TIMEOUT_S * 3; t += 7) {
      setClock(t);
      const res = await request(app).post(path).send(body).expect(200);
      const remaining = maxTimeOf(res.body.xdr) - Date.now() / 1000;
      expect(remaining).toBeGreaterThanOrEqual(UNSIGNED_TX_MIN_REMAINING_S);
      expect(remaining).toBeLessThanOrEqual(UNSIGNED_TX_TIMEOUT_S);
    }
  });
});
