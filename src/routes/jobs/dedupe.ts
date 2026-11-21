import type NodeCache from "node-cache";

/**
 * Common cache + in-flight single flight deduplication pattern (#882).
 *
 * Steps:
 * 1. Checks `cache.get(key)`. If fresh (or `isFresh` is omitted), logs and returns it.
 *    If stale, evicts with `cache.del(key)`.
 * 2. Checks `inFlight.get(key)`. If in flight, logs and joins the promise.
 * 3. Otherwise, starts `produce()`, registers the promise in `inFlight`,
 *    clears `cache` on failure, deletes from `inFlight` in `finally`, and returns the result.
 */
export async function cachedSingleFlight<T>(opts: {
  cache: NodeCache;
  inFlight: Map<string, Promise<T>>;
  key: string;
  isFresh?: (v: T) => boolean;
  produce: () => Promise<T>;
  log: (source: "cache" | "in-flight" | "rpc") => void;
  onInFlightRegister?: () => void;
  onInFlightUnregister?: () => void;
  onError?: (err: unknown) => void;
}): Promise<T> {
  const cached = opts.cache.get<T>(opts.key);
  if (cached !== undefined) {
    if (!opts.isFresh || opts.isFresh(cached)) {
      opts.log("cache");
      return cached;
    }
    opts.cache.del(opts.key);
  }

  const existingInFlight = opts.inFlight.get(opts.key);
  if (existingInFlight) {
    opts.log("in-flight");
    return await existingInFlight;
  }

  opts.log("rpc");
  opts.onInFlightRegister?.();
  const promise = (async () => {
    try {
      return await opts.produce();
    } catch (err) {
      opts.cache.del(opts.key);
      opts.onError?.(err);
      throw err;
    } finally {
      opts.inFlight.delete(opts.key);
      opts.onInFlightUnregister?.();
    }
  })();

  opts.inFlight.set(opts.key, promise);
  return await promise;
}
