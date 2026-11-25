import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import NodeCache from "node-cache";

/**
 * Bounded in-memory caches (#…).
 *
 * node-cache throws `ECACHEFULL` once a cache holds `maxKeys` entries, even
 * when an existing key is overwritten. `safeCacheSet` degrades that to a
 * skipped write so a full cache behaves like a miss instead of a 500 or an
 * indexer crash. The job-route caches read `config.cacheMaxKeys` at import
 * time, so pin it to a tiny value before the route modules load — a cache that
 * holds two keys is reachable in-process.
 */
process.env.CACHE_MAX_KEYS = "2";

const mockSendTransaction = jest.fn<() => Promise<unknown>>();
// Every parsed transaction reports the same hash so two distinct signed-XDR
// encodings of the same transaction share a submit cache key.
const TX_HASH = Buffer.alloc(32, 0xab);
const mockTx = { hash: () => TX_HASH };

jest.unstable_mockModule("../src/middleware/rateLimiter.js", () => ({
  strictLimiter: (_req: any, _res: any, next: any) => next(),
  generalLimiter: (_req: any, _res: any, next: any) => next(),
}));

// An ESM module mock replaces the whole module, so every limiter the job
// routes import has to be present or the router import fails.
jest.unstable_mockModule("../src/middleware/job-contract-rate-limit.js", () => ({
  submitRateLimit: (_req: any, _res: any, next: any) => next(),
  jobContractRateLimit: (_req: any, _res: any, next: any) => next(),
  partialReleaseRateLimit: (_req: any, _res: any, next: any) => next(),
  jobWhitelistRateLimit: (_req: any, _res: any, next: any) => next(),
  whitelistUpdateRateLimit: (_req: any, _res: any, next: any) => next(),
  buildTxRateLimit: (_req: any, _res: any, next: any) => next(),
  timeRemainingRateLimit: (_req: any, _res: any, next: any) => next(),
  createJobDraftRateLimit: (_req: any, _res: any, next: any) => next(),
  claimAutoReleaseRateLimit: (_req: any, _res: any, next: any) => next(),
  resetSubmitRateLimitBuckets: () => {},
  resetWhitelistUpdateRateLimitBuckets: () => {},
}));

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    sendTransaction = mockSendTransaction;
  },
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  Keypair: {
    random: jest.fn(() => ({
      publicKey: () => "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    })),
  },
  Account: class {},
  TransactionBuilder: { fromXDR: jest.fn(() => mockTx) },
  Contract: jest.fn(),
  Networks: {
    TESTNET: "Test SDF Network ; September 2015",
    PUBLIC: "Public Global Stellar Network ; September 2015",
  },
  BASE_FEE: "100",
  nativeToScVal: jest.fn(),
  scValToNative: jest.fn((val: unknown) => val),
  Address: { fromString: jest.fn(() => ({ toScVal: jest.fn() })) },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));

const { default: router, resetSubmitCache } = await import("../src/routes/jobs.js");
const { submitCache } = await import("../src/routes/jobs/caches.js");
const { submitCacheKey } = await import("../src/routes/jobs/submit.js");
const { safeCacheSet, isCacheFullError } = await import("../src/utils/safe-cache.js");
const { TransactionBuilder: MockTransactionBuilder } = await import(
  "@stellar/stellar-sdk"
);

// Format-valid base64 (the SDK is mocked, so the bytes need not be real XDR).
const SIGNED_XDR_A =
  "AAAAAgAAAABz9B8nR7h4qY6Ran5PlacgCUxOFxOdIQAAAAAAAAAAABAAAAAAAAAAAA==";
const SIGNED_XDR_B =
  "AAAAAgAAAABz9B8nR7h4qY6Ran5PlacgCUxOFxOdIQAAAAAAAAAAABAAAAAAAAAAAA==".replace(
    "AAAA",
    "BBBB",
  );

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", router);
  return app;
}

describe("safeCacheSet – ECACHEFULL handling", () => {
  it("stores a value and returns true while the cache has room", () => {
    const cache = new NodeCache({ maxKeys: 5 });
    expect(safeCacheSet(cache, "k1", { v: 1 })).toBe(true);
    expect(cache.get("k1")).toEqual({ v: 1 });
  });

  it("returns false instead of throwing once the cache is full", () => {
    const cache = new NodeCache({ maxKeys: 2 });
    expect(safeCacheSet(cache, "k1", 1)).toBe(true);
    expect(safeCacheSet(cache, "k2", 2)).toBe(true);

    // A third distinct key overflows the cache.
    expect(() => safeCacheSet(cache, "k3", 3)).not.toThrow();
    expect(safeCacheSet(cache, "k3", 3)).toBe(false);
    expect(cache.get("k3")).toBeUndefined();
  });

  it("degrades an overwrite of an existing key on a full cache to a skip", () => {
    const cache = new NodeCache({ maxKeys: 2 });
    safeCacheSet(cache, "k1", 1);
    safeCacheSet(cache, "k2", 2);

    // node-cache refuses even an overwrite at maxKeys; safeCacheSet absorbs it.
    expect(safeCacheSet(cache, "k1", 99)).toBe(false);
    expect(cache.get("k1")).toBe(1);
  });

  it("swallows non-ECACHEFULL errors without throwing", () => {
    const broken = {
      set: () => {
        throw new Error("boom");
      },
    } as unknown as NodeCache;

    expect(safeCacheSet(broken, "k", 1)).toBe(false);
  });

  it("isCacheFullError identifies the node-cache ECACHEFULL error only", () => {
    const full = new NodeCache({ maxKeys: 1 });
    full.set("a", 1);
    let thrown: unknown;
    try {
      full.set("b", 2);
    } catch (err) {
      thrown = err;
    }
    expect(isCacheFullError(thrown)).toBe(true);
    expect(isCacheFullError(new Error("other"))).toBe(false);
    expect(isCacheFullError(undefined)).toBe(false);
  });
});

describe("submitCache is bounded by config.cacheMaxKeys", () => {
  it("creates every job-route cache with the configured maxKeys", () => {
    expect(submitCache.options.maxKeys).toBe(2);
  });
});

describe("submitCacheKey – keyed by transaction hash", () => {
  it("returns a fixed-length hex transaction hash rather than the raw XDR", () => {
    const key = submitCacheKey(SIGNED_XDR_A);
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe(SIGNED_XDR_A);
  });

  it("maps two encodings of the same transaction to the same key", () => {
    expect(submitCacheKey(SIGNED_XDR_A)).toBe(submitCacheKey(SIGNED_XDR_B));
  });

  it("falls back to a bounded sha256 key for malformed XDR", () => {
    const fromXdr = MockTransactionBuilder.fromXDR as ReturnType<typeof jest.fn>;
    fromXdr.mockImplementationOnce(() => {
      throw new Error("bad xdr");
    });
    const key = submitCacheKey("not-valid-xdr");
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(fromXdr).toHaveBeenCalled();
  });
});

describe("POST /api/jobs/submit – full cache does not break requests", () => {
  beforeEach(() => {
    mockSendTransaction.mockReset();
    resetSubmitCache();
  });

  it("still serves a fresh submission when the cache is full", async () => {
    // Fill the tiny cache to maxKeys with unrelated entries.
    safeCacheSet(submitCache, "full-1", { id: "x" });
    safeCacheSet(submitCache, "full-2", { id: "y" });
    expect(submitCache.keys()).toHaveLength(2);

    mockSendTransaction.mockResolvedValue({ id: "tx-1", status: "PENDING" });

    const res = await request(buildApp())
      .post("/api/jobs/submit")
      .send({ signedXdr: SIGNED_XDR_A })
      .expect(200);

    expect(res.body).toEqual({
      success: true,
      data: { id: "tx-1", status: "PENDING" },
    });
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    // The overflowing write was skipped, not thrown; the cache stayed at maxKeys.
    expect(submitCache.keys()).toHaveLength(2);
  });
});

describe("POST /api/jobs/submit – dedupe by transaction hash", () => {
  beforeEach(() => {
    mockSendTransaction.mockReset();
    resetSubmitCache();
  });

  it("serves two encodings of the same transaction from one network call", async () => {
    mockSendTransaction.mockResolvedValue({ id: "tx-dup", status: "PENDING" });
    const app = buildApp();

    const first = await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: SIGNED_XDR_A })
      .expect(200);

    const second = await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: SIGNED_XDR_B })
      .expect(200);

    expect(first.body.data).toEqual({ id: "tx-dup", status: "PENDING" });
    expect(second.body.data).toEqual({ id: "tx-dup", status: "PENDING" });
    // Same transaction hash → the second request was a cache hit.
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });
});
