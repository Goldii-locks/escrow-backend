import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import Database from "better-sqlite3";
import { Keypair, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { autoAuth } from "./helpers/api-key-helper.js";
import { tokenVecScVal } from "./helpers/scval-fixtures.js";

/**
 * Error and cache branches of the whitelist, partial-release, time-remaining
 * and history routes (issue #672). Every failure case asserts the exact
 * response body, that no raw upstream error text reaches the client, and that
 * the failed result was not cached (a follow-up request reaches the RPC again).
 */

const VALID_CONTRACT = "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";
const TOKEN_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));
const ADMIN = Keypair.random().publicKey();
const SOURCE = Keypair.random().publicKey();
const RAW_ERROR = "host unreachable: secret-internal-detail";

const mockGetAccount = jest.fn<() => Promise<unknown>>();
const mockSimulateTransaction = jest.fn<() => Promise<unknown>>();
const mockPrepareTransaction = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getAccount = mockGetAccount;
    simulateTransaction = mockSimulateTransaction;
    prepareTransaction = mockPrepareTransaction;
  },
}));

const {
  default: router,
  whitelistCache,
  resetWhitelistCache,
  timeRemainingCache,
  resetTimeRemainingCache,
  partialReleaseCache,
  resetPartialReleaseCache,
} = await import("../src/routes/jobs.js");
const rateLimits = await import("../src/middleware/job-contract-rate-limit.js");
const { setDb, initSchema } = await import("../src/indexer/db.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(autoAuth);
  app.use("/api/jobs", router);
  return app;
}

function expectNoLeak(res: request.Response) {
  expect(res.text).not.toContain("secret-internal-detail");
  expect(res.text).not.toContain("host unreachable");
  expect(res.text).not.toContain("stack");
}

const account = {
  accountId: () => SOURCE,
  sequenceNumber: () => "1",
  incrementSequenceNumber: () => {},
};

beforeEach(() => {
  rateLimits.resetJobWhitelistRateLimitBuckets();
  rateLimits.resetWhitelistUpdateRateLimitBuckets();
  rateLimits.resetPartialReleaseRateLimitBuckets();
  rateLimits.resetTimeRemainingRateLimitBuckets();
  rateLimits.resetJobContractRateLimitBuckets();
  resetWhitelistCache();
  resetTimeRemainingCache();
  resetPartialReleaseCache();
  mockGetAccount.mockReset();
  mockSimulateTransaction.mockReset();
  mockPrepareTransaction.mockReset();
  mockGetAccount.mockResolvedValue(account);
});

// ---------------------------------------------------------------------------
// GET /:contractId/whitelist
// ---------------------------------------------------------------------------

describe("GET /:contractId/whitelist", () => {
  it("deduplicates concurrent requests onto one in-flight simulation", async () => {
    let release!: (v: unknown) => void;
    mockSimulateTransaction.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const app = buildApp();
    const first = request(app).get(`/api/jobs/${VALID_CONTRACT}/whitelist`).then((r) => r);
    const second = request(app).get(`/api/jobs/${VALID_CONTRACT}/whitelist`).then((r) => r);
    // Let both requests reach the handler before the simulation settles.
    await new Promise((r) => setTimeout(r, 50));
    release({ result: { retval: tokenVecScVal(TOKEN_CONTRACT) } });

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.body).toEqual({ success: true, data: { tokens: [TOKEN_CONTRACT] } });
    expect(r2.body).toEqual({ success: true, data: { tokens: [TOKEN_CONTRACT] } });
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns 500 for a malformed retval and does not cache it", async () => {
    mockSimulateTransaction.mockResolvedValue({ result: { retval: xdr.ScVal.scvU32(5) } });
    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
      .expect(500);
    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expect(whitelistCache.get(VALID_CONTRACT)).toBeUndefined();
  });

  it("still returns and caches [] for an uninitialized contract (contract error #2)", async () => {
    mockSimulateTransaction.mockResolvedValue({ error: "HostError: contract error #2" });
    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
      .expect(200);
    expect(res.body).toEqual({ success: true, data: { tokens: [] } });
    expect(whitelistCache.get(VALID_CONTRACT)).toEqual([]);
  });

  it("returns a clean 500 for a non-Error rejection and caches nothing", async () => {
    mockGetAccount.mockRejectedValue({ reason: RAW_ERROR });
    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}/whitelist`)
      .expect(500);
    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expectNoLeak(res);
    expect(whitelistCache.get(VALID_CONTRACT)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /:contractId/whitelist/update – single-token form
// ---------------------------------------------------------------------------

describe("POST /:contractId/whitelist/update (single token)", () => {
  const body = { token: TOKEN_CONTRACT, action: "add", adminAddress: ADMIN };

  it.each([
    ["Unauthorized: invalid authentication", 401, "Unauthorized"],
    ["contract not found", 404, "Job not found"],
    [RAW_ERROR, 500, "Internal server error"],
  ])("maps a prepare failure %j to %i without caching", async (raw, status, error) => {
    whitelistCache.set(VALID_CONTRACT, ["CACHED"]);
    mockPrepareTransaction.mockRejectedValue(new Error(raw));

    const res = await request(buildApp())
      .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
      .send(body)
      .expect(status);

    expect(res.body).toEqual({ success: false, error });
    expectNoLeak(res);
    // A failed update must leave the cached token list untouched.
    expect(whitelistCache.get(VALID_CONTRACT)).toEqual(["CACHED"]);
  });

  it("returns a clean 500 for a non-Error rejection", async () => {
    whitelistCache.set(VALID_CONTRACT, ["CACHED"]);
    mockPrepareTransaction.mockRejectedValue(RAW_ERROR);
    const res = await request(buildApp())
      .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
      .send(body)
      .expect(500);
    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expectNoLeak(res);
    expect(whitelistCache.get(VALID_CONTRACT)).toEqual(["CACHED"]);
  });

  it("treats 'account not found' as a 500, not a missing job", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("account not found"));
    const res = await request(buildApp())
      .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
      .send(body)
      .expect(500);
    expect(res.body).toEqual({ success: false, error: "Internal server error" });
  });
});

// ---------------------------------------------------------------------------
// POST /:contractId/whitelist/update – bulk form
// ---------------------------------------------------------------------------

describe("POST /:contractId/whitelist/update (bulk)", () => {
  const body = { addresses: [TOKEN_CONTRACT] };

  it.each([
    ["contract not found", 404, "Job not found"],
    ["contract error #1", 404, "Job not found"],
    [RAW_ERROR, 500, "Internal server error"],
  ])("maps a simulation error %j to %i without caching", async (raw, status, error) => {
    whitelistCache.set(VALID_CONTRACT, ["CACHED"]);
    mockSimulateTransaction.mockResolvedValue({ error: raw });

    const res = await request(buildApp())
      .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
      .send(body)
      .expect(status);

    expect(res.body).toEqual({ success: false, error });
    expectNoLeak(res);
    expect(whitelistCache.get(VALID_CONTRACT)).toEqual(["CACHED"]);
  });

  it.each([
    ["Unauthorized", 401, "Unauthorized"],
    ["job not found", 404, "Job not found"],
    [RAW_ERROR, 500, "Internal server error"],
  ])("maps a thrown error %j to %i without caching", async (raw, status, error) => {
    whitelistCache.set(VALID_CONTRACT, ["CACHED"]);
    mockSimulateTransaction.mockRejectedValue(new Error(raw));

    const res = await request(buildApp())
      .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
      .send(body)
      .expect(status);

    expect(res.body).toEqual({ success: false, error });
    expectNoLeak(res);
    expect(whitelistCache.get(VALID_CONTRACT)).toEqual(["CACHED"]);
  });
});

describe("POST /:contractId/whitelist/update (bulk extras)", () => {
  it("accepts the tokens alias and treats an uninitialized contract as updatable", async () => {
    whitelistCache.set(VALID_CONTRACT, ["STALE"]);
    mockSimulateTransaction.mockResolvedValue({ error: "HostError: contract error #2 NotInitialized" });
    const res = await request(buildApp())
      .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
      .send({ tokens: [TOKEN_CONTRACT] })
      .expect(400);
    // The alias validates and the uninitialized contract is no error; the
    // bulk form itself is then refused, since it is never executed on-chain
    // (#613).
    expect(res.body).toEqual({
      success: false,
      error:
        "Bulk whitelist update is not supported: submit one { token, action, adminAddress } request per address to receive a signable transaction",
    });
  });

  it("returns a clean 500 for a non-Error rejection without caching", async () => {
    whitelistCache.set(VALID_CONTRACT, ["CACHED"]);
    mockSimulateTransaction.mockRejectedValue(RAW_ERROR);
    const res = await request(buildApp())
      .post(`/api/jobs/${VALID_CONTRACT}/whitelist/update`)
      .send({ addresses: [TOKEN_CONTRACT] })
      .expect(500);
    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expectNoLeak(res);
    expect(whitelistCache.get(VALID_CONTRACT)).toEqual(["CACHED"]);
  });
});

// ---------------------------------------------------------------------------
// POST /:contractId/milestones/:index/partial-release
// ---------------------------------------------------------------------------

describe("POST /:contractId/milestones/:index/partial-release", () => {
  const url = `/api/jobs/${VALID_CONTRACT}/milestones/0/partial-release`;
  const body = { amount: "100", sourceAddress: SOURCE };

  it.each([
    ["contract error #4", 422, "Contract execution reverted (error code 4)"],
    ["contract not found", 404, "Contract not found on network"],
    ["wasm trap: unreachable", 422, "Contract execution reverted"],
    [RAW_ERROR, 500, "Internal server error"],
  ])("maps a prepare failure %j to %i and does not cache it", async (raw, status, error) => {
    mockPrepareTransaction.mockRejectedValue(new Error(raw));
    const app = buildApp();

    const res = await request(app).post(url).send(body).expect(status);
    expect(res.body).toEqual({ success: false, error });
    expectNoLeak(res);
    expect(partialReleaseCache.keys()).toHaveLength(0);

    // The failure was not cached: a retry reaches the RPC again and succeeds.
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAA" });
    const retry = await request(app).post(url).send(body).expect(200);
    expect(retry.body).toEqual({ success: true, data: { xdr: "AAAA" } });
    expect(mockPrepareTransaction).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent identical requests onto one prepare call", async () => {
    let release!: (v: unknown) => void;
    mockPrepareTransaction.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const app = buildApp();
    const first = request(app).post(url).send(body).then((r) => r);
    const second = request(app).post(url).send(body).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    release({ toXDR: () => "AAAA" });

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.body).toEqual({ success: true, data: { xdr: "AAAA" } });
    expect(r2.body).toEqual({ success: true, data: { xdr: "AAAA" } });
    expect(mockPrepareTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns a clean 500 when a non-Error value escapes, and caches nothing", async () => {
    mockPrepareTransaction.mockResolvedValue({
      toXDR: () => {
        throw RAW_ERROR;
      },
    });
    const res = await request(buildApp()).post(url).send(body).expect(500);
    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expectNoLeak(res);
    expect(partialReleaseCache.keys()).toHaveLength(0);
  });

  it("returns a clean 500 when an unexpected error escapes, and caches nothing", async () => {
    // A prepared tx whose toXDR throws is not a classified prepare failure,
    // so it reaches the route's unexpected-error handler.
    mockPrepareTransaction.mockResolvedValue({
      toXDR: () => {
        throw new Error(RAW_ERROR);
      },
    });

    const res = await request(buildApp()).post(url).send(body).expect(500);
    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expectNoLeak(res);
    expect(partialReleaseCache.keys()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /:contractId/milestones/:index/time-remaining
// ---------------------------------------------------------------------------

describe("GET /:contractId/milestones/:index/time-remaining", () => {
  const url = `/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`;

  it("serves a cached value without calling the RPC", async () => {
    timeRemainingCache.set(`${VALID_CONTRACT}:0`, 42);
    const res = await request(buildApp()).get(url).expect(200);
    expect(res.body).toEqual({ success: true, data: { secondsRemaining: 42 } });
    expect(mockSimulateTransaction).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent requests onto one in-flight simulation", async () => {
    let release!: (v: unknown) => void;
    mockSimulateTransaction.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const app = buildApp();
    const first = request(app).get(url).then((r) => r);
    const second = request(app).get(url).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    release({ result: { retval: nativeToScVal(99n, { type: "u64" }) } });

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.body).toEqual({ success: true, data: { secondsRemaining: 99 } });
    expect(r2.body).toEqual({ success: true, data: { secondsRemaining: 99 } });
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["contract not found", 404, "Job not found"],
    ["contract error #7", 422, "Contract execution reverted (error code 7)"],
    [RAW_ERROR, 500, "Internal server error"],
  ])("maps a simulation error %j to %i and does not cache it", async (raw, status, error) => {
    mockSimulateTransaction.mockResolvedValue({ error: raw });
    const app = buildApp();

    const res = await request(app).get(url).expect(status);
    expect(res.body).toEqual({ success: false, error });
    expectNoLeak(res);
    expect(timeRemainingCache.keys()).toHaveLength(0);

    await request(app).get(url).expect(status);
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(2);
  });

  it.each([3600n, 0n])("decodes a u64 retval of %s seconds (#599)", async (secs) => {
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: nativeToScVal(secs, { type: "u64" }) },
    });
    const res = await request(buildApp()).get(url).expect(200);
    expect(res.body).toEqual({ success: true, data: { secondsRemaining: Number(secs) } });
    expect(timeRemainingCache.get(`${VALID_CONTRACT}:0`)).toBe(Number(secs));
  });

  it("returns 500 for a non-numeric retval and does not cache it", async () => {
    mockSimulateTransaction.mockResolvedValue({ result: { retval: xdr.ScVal.scvSymbol("x") } });
    const res = await request(buildApp()).get(url).expect(500);
    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expect(timeRemainingCache.keys()).toHaveLength(0);
  });

  it("returns 500 for an empty retval and does not cache it", async () => {
    mockSimulateTransaction.mockResolvedValue({ result: {} });
    const res = await request(buildApp()).get(url).expect(500);
    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expect(timeRemainingCache.keys()).toHaveLength(0);
  });

  it("returns a clean 500 for an unexpected error and does not cache it", async () => {
    mockGetAccount.mockRejectedValue(new Error(RAW_ERROR));
    const res = await request(buildApp()).get(url).expect(500);
    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expectNoLeak(res);
    expect(timeRemainingCache.keys()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /:contractId/history
// ---------------------------------------------------------------------------

describe("GET /:contractId/history", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    setDb(db);
    initSchema();
  });

  afterEach(() => {
    db.close();
  });

  // Paging is validated by the shared history query schema (#612), which
  // reports the offending field in the standard ValidationError shape.
  it.each([
    ["page=0", "page"],
    ["page=abc", "page"],
    ["limit=0", "limit"],
    ["limit=101", "limit"],
  ])("rejects %s with 400", async (query, field) => {
    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}/history?${query}`)
      .expect(400);
    expect(res.body).toMatchObject({
      success: false,
      error: "ValidationError",
      details: expect.arrayContaining([expect.objectContaining({ field })]),
    });
  });

  it("returns a clean 500 when the database query fails", async () => {
    db.exec("DROP TABLE events");
    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}/history`)
      .expect(500);
    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expect(res.text).not.toContain("no such table");
  });
});
