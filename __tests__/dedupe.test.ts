import { jest } from "@jest/globals";
import NodeCache from "node-cache";
import { cachedSingleFlight } from "../src/routes/jobs/dedupe.js";

describe("cachedSingleFlight (#882)", () => {
  let cache: NodeCache;
  let inFlight: Map<string, Promise<any>>;

  beforeEach(() => {
    cache = new NodeCache({ stdTTL: 60, useClones: false });
    inFlight = new Map();
  });

  afterEach(() => {
    cache.flushAll();
    inFlight.clear();
  });

  it("serves a cache hit, logs 'cache', and does not call produce", async () => {
    cache.set("job:1", { data: "cached-val" });
    const log = jest.fn();
    const produce = jest.fn(async () => ({ data: "fresh-val" }));

    const result = await cachedSingleFlight({
      cache,
      inFlight,
      key: "job:1",
      produce,
      log,
    });

    expect(result).toEqual({ data: "cached-val" });
    expect(log).toHaveBeenCalledWith("cache");
    expect(produce).not.toHaveBeenCalled();
    expect(inFlight.size).toBe(0);
  });

  it("joins an in-flight request, logs 'in-flight', and calls produce only once", async () => {
    const log1 = jest.fn();
    const log2 = jest.fn();
    let resolveProduce!: (val: { data: string }) => void;
    const producePromise = new Promise<{ data: string }>((resolve) => {
      resolveProduce = resolve;
    });
    const produce = jest.fn(() => producePromise);

    const call1 = cachedSingleFlight({
      cache,
      inFlight,
      key: "job:2",
      produce,
      log: log1,
    });

    const call2 = cachedSingleFlight({
      cache,
      inFlight,
      key: "job:2",
      produce,
      log: log2,
    });

    expect(log1).toHaveBeenCalledWith("rpc");
    expect(log2).toHaveBeenCalledWith("in-flight");
    expect(inFlight.has("job:2")).toBe(true);

    resolveProduce({ data: "joined-val" });

    const [res1, res2] = await Promise.all([call1, call2]);

    expect(res1).toEqual({ data: "joined-val" });
    expect(res2).toEqual({ data: "joined-val" });
    expect(produce).toHaveBeenCalledTimes(1);
    expect(inFlight.has("job:2")).toBe(false);
  });

  it("clears both cache and inFlight on produce failure, and propagates the error", async () => {
    cache.set("job:3", { data: "stale-or-partial" });
    const log = jest.fn();
    const produceError = new Error("RPC failure");
    const produce = jest.fn(async () => {
      throw produceError;
    });

    await expect(
      cachedSingleFlight({
        cache,
        inFlight,
        key: "job:3",
        // Force miss so produce runs
        isFresh: () => false,
        produce,
        log,
      }),
    ).rejects.toThrow("RPC failure");

    expect(cache.get("job:3")).toBeUndefined();
    expect(inFlight.has("job:3")).toBe(false);
    expect(log).toHaveBeenCalledWith("rpc");
  });

  it("evicts expired/stale cache entry when isFresh returns false, calls produce, and logs 'rpc'", async () => {
    cache.set("job:4", { data: "expired-entry", validUntil: 100 });
    const log = jest.fn();
    const produce = jest.fn(async () => ({ data: "fresh-entry", validUntil: 200 }));
    const isFresh = jest.fn((val: any) => val.validUntil > 150);

    const result = await cachedSingleFlight({
      cache,
      inFlight,
      key: "job:4",
      isFresh,
      produce,
      log,
    });

    expect(isFresh).toHaveBeenCalledWith({ data: "expired-entry", validUntil: 100 });
    expect(log).toHaveBeenCalledWith("rpc");
    expect(produce).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ data: "fresh-entry", validUntil: 200 });
    expect(inFlight.has("job:4")).toBe(false);
  });
});
