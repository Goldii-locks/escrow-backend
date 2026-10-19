import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import Database from "better-sqlite3";
import { initSchema, setDb } from "../src/indexer/db.js";

/**
 * #679: GET /api/jobs/:contractId caches job state, collapses concurrent
 * lookups into one simulation, and is invalidated as soon as the indexer
 * stores a new event for that contract.
 */

const CONTRACT_A = "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";
const CONTRACT_B = "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";

const mockGetAccount = jest.fn<() => Promise<unknown>>();
const mockSimulateTransaction = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getAccount = mockGetAccount;
    simulateTransaction = mockSimulateTransaction;
  },
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: router } = await import("../src/routes/jobs.js");
const { resetJobContractRateLimitBuckets } = await import(
  "../src/middleware/job-contract-rate-limit.js"
);
const { enqueueEventInsert, resetEventInsertQueueForTests } = await import(
  "../src/indexer/poller.js"
);
const { jobStateCache, getCachedJobState, invalidateJobState } = await import(
  "../src/indexer/job-state-cache.js"
);

const app = express();
app.use(express.json());
app.use("/api/jobs", router);

function jobResult(funded: boolean) {
  return {
    result: {
      retval: {
        client: () => ({ toString: () => "GCLIENT" }),
        freelancer: () => ({ toString: () => "GFREELANCER" }),
        arbiter: () => ({ toString: () => "GARBITER" }),
        token: () => ({ toString: () => "CTOKEN" }),
        funded: () => funded,
        milestones: () => [],
      },
    },
  };
}

let testDb: Database.Database;

beforeAll(() => {
  testDb = new Database(":memory:");
  setDb(testDb);
  initSchema();
});

afterAll(() => {
  testDb.close();
});

beforeEach(() => {
  testDb.exec("DELETE FROM events");
  resetJobContractRateLimitBuckets();
  resetEventInsertQueueForTests();
  mockGetAccount.mockReset();
  mockSimulateTransaction.mockReset();
  mockGetAccount.mockResolvedValue({
    accountId: () => "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  });
});

describe("GET /api/jobs/:contractId job state cache (#679)", () => {
  it("issues exactly one RPC simulation for concurrent requests", async () => {
    let release!: (value: unknown) => void;
    mockSimulateTransaction.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const pending = Promise.all(
      Array.from({ length: 5 }, () => request(app).get(`/api/jobs/${CONTRACT_A}`)),
    );
    // Let every request reach the handler before the simulation resolves.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release(jobResult(true));
    const responses = await pending;

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.data.funded).toBe(true);
    }
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
    expect(mockGetAccount).toHaveBeenCalledTimes(1);
  });

  it("serves repeat views from cache within the TTL", async () => {
    mockSimulateTransaction.mockResolvedValue(jobResult(true));

    await request(app).get(`/api/jobs/${CONTRACT_A}`).expect(200);
    await request(app).get(`/api/jobs/${CONTRACT_A}`).expect(200);

    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("does not cache not-found or failed lookups", async () => {
    mockSimulateTransaction.mockResolvedValueOnce({ result: { retval: null } });
    await request(app).get(`/api/jobs/${CONTRACT_A}`).expect(404);

    mockSimulateTransaction.mockResolvedValueOnce({ error: "host unreachable" });
    await request(app).get(`/api/jobs/${CONTRACT_A}`).expect(500);

    mockSimulateTransaction.mockResolvedValueOnce(jobResult(false));
    await request(app).get(`/api/jobs/${CONTRACT_A}`).expect(200);

    expect(mockSimulateTransaction).toHaveBeenCalledTimes(3);
  });

  it("purges a contract's cached state when a new event for it is stored", async () => {
    mockSimulateTransaction
      .mockResolvedValueOnce(jobResult(false))
      .mockResolvedValueOnce(jobResult(true));

    const before = await request(app).get(`/api/jobs/${CONTRACT_A}`).expect(200);
    expect(before.body.data.funded).toBe(false);
    expect(jobStateCache.has(CONTRACT_A)).toBe(true);

    await enqueueEventInsert(
      [
        {
          contractId: CONTRACT_A,
          eventType: "fund",
          ledgerSequence: 200,
          timestamp: 1_700_000_000,
          dataJson: "{}",
        },
      ],
      200,
    );

    expect(jobStateCache.has(CONTRACT_A)).toBe(false);
    const after = await request(app).get(`/api/jobs/${CONTRACT_A}`).expect(200);
    expect(after.body.data.funded).toBe(true);
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(2);
  });

  it("leaves other contracts' cached state alone", async () => {
    jobStateCache.set(CONTRACT_B, { id: CONTRACT_B });

    await enqueueEventInsert(
      [
        {
          contractId: CONTRACT_A,
          eventType: "fund",
          ledgerSequence: 201,
          timestamp: 1_700_000_000,
          dataJson: "{}",
        },
      ],
      201,
    );

    expect(jobStateCache.has(CONTRACT_B)).toBe(true);
  });

  it("does not cache a lookup that was in flight when the contract was invalidated", async () => {
    let release!: (value: string) => void;
    const lookup = getCachedJobState(
      CONTRACT_A,
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );

    invalidateJobState(CONTRACT_A);
    release("pre-event state");
    await lookup;

    expect(jobStateCache.has(CONTRACT_A)).toBe(false);
  });
});
