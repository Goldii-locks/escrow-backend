/**
 * Bounded-cache write helper (#…).
 *
 * Every in-memory NodeCache is created with `maxKeys` so a burst of distinct
 * keys (one per wallet, contract, token or transaction) cannot grow a cache
 * without bound and exhaust the process heap.
 *
 * node-cache throws `ECACHEFULL` once a cache holds `maxKeys` entries, even
 * when an existing key is being overwritten. A full cache is not an
 * application error: the write is skipped and the entry simply behaves like a
 * miss on the next read, exactly as if its TTL had elapsed. Routing every
 * write through `safeCacheSet` keeps that failure mode from surfacing as a
 * 500 or crashing the indexer.
 */

import type NodeCache from "node-cache";
import logger from "./logger.js";

/** True when `err` is node-cache's "cache is full" error. */
export function isCacheFullError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // node-cache sets `name` and `errorcode` to the error key (it never sets
  // `code`), so both are checked.
  const tagged = err as Error & { errorcode?: string };
  return err.name === "ECACHEFULL" || tagged.errorcode === "ECACHEFULL";
}

/**
 * Write `value` into `cache`, swallowing `ECACHEFULL` (logged at debug level)
 * so a full cache degrades to a skipped write rather than a thrown error.
 * Returns `true` when the value was stored.
 */
export function safeCacheSet<T>(
  cache: NodeCache,
  key: string,
  value: T,
  ttl?: number,
): boolean {
  try {
    if (ttl === undefined) cache.set(key, value);
    else cache.set(key, value, ttl);
    return true;
  } catch (err) {
    if (isCacheFullError(err)) {
      logger.debug("Cache is full – skipping write", { key });
    } else {
      logger.debug("Cache write failed", {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  }
}
