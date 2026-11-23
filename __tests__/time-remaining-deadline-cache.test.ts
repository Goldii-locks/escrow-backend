import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { autoAuth } from "./helpers/api-key-helper.js";

const VALID_CONTRACT = "CARZQMYKDGA4TTIE2XBDJ42EX27VYLLJGGG4WGUIXXWIVHPDTX3UCLJA";
const url = `/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`;

const mockSimulateTransaction = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getAccount = jest.fn();
    simulateTransaction = mockSimulateTransaction;
    prepareTransaction = jest.fn();
  },
}));

const { default: router, resetTimeRemainingCache } = await import("../src/routes/jobs.js");
const { cacheTimeRemaining, getCachedTimeRemaining, timeRemainingCache } = await import(
  "../src/routes/jobs/caches.js"
);
const rateLimits = await import("../src/middleware/job-contract-rate-limit.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(autoAuth);
  app.use("/api/jobs", router);
  return app;
}

const simulateReturns = (secs: bigint) =>
  mockSimulateTransaction.mockResolvedValue({ result: { retval: nativeToScVal(secs, { type: "u64" }) } });

// Fake only Date so supertest's real timers keep working.
const FAKE_DATE_ONLY = [
  "nextTick", "setImmediate", "clearImmediate", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "queueMicrotask", "performance", "hrtime",
] as const;

beforeEach(() => {
  rateLimits.resetTimeRemainingRateLimitBuckets();
  resetTimeRemainingCache();
  mockSimulateTransaction.mockReset();
  jest.useFakeTimers({ now: 0, doNotFake: [...FAKE_DATE_ONLY] });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("time-remaining caches an absolute deadline (#879)", () => {
  it("cached at t=0 with 100s, requested at t=10s, returns 90", async () => {
    simulateReturns(100n);
    const app = buildApp();

    const first = await request(app).get(url).expect(200);
    expect(first.body.data.secondsRemaining).toBe(100);

    jest.setSystemTime(10_000);
    const second = await request(app).get(url).expect(200);

    expect(second.body.data.secondsRemaining).toBe(90);
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("counts down on every cached hit within the TTL", async () => {
    simulateReturns(100n);
    const app = buildApp();
    await request(app).get(url).expect(200);

    const seen: number[] = [];
    for (const t of [3_000, 7_000, 12_000]) {
      jest.setSystemTime(t);
      seen.push((await request(app).get(url).expect(200)).body.data.secondsRemaining);
    }

    expect(seen).toEqual([97, 93, 88]);
  });

  it("never reports a negative countdown once the deadline passes inside the TTL", () => {
    cacheTimeRemaining("k", 5, 0);
    expect(getCachedTimeRemaining("k", 4_000)).toBe(1);
    expect(getCachedTimeRemaining("k", 9_000)).toBe(0);
  });

  it("keeps 0 as 0", async () => {
    simulateReturns(0n);
    const app = buildApp();

    expect((await request(app).get(url).expect(200)).body.data.secondsRemaining).toBe(0);
    jest.setSystemTime(8_000);
    expect((await request(app).get(url).expect(200)).body.data.secondsRemaining).toBe(0);
  });

  it("serves but does not cache negative or sentinel values", async () => {
    expect(cacheTimeRemaining("neg", -1)).toBe(false);
    expect(cacheTimeRemaining("max", Number(2n ** 64n - 1n))).toBe(false);
    expect(cacheTimeRemaining("nan", Number.NaN)).toBe(false);
    expect(timeRemainingCache.keys()).toHaveLength(0);

    simulateReturns(2n ** 64n - 1n);
    const app = buildApp();
    await request(app).get(url).expect(200);
    await request(app).get(url).expect(200);

    expect(mockSimulateTransaction).toHaveBeenCalledTimes(2);
  });
});
