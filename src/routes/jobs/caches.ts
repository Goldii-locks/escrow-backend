import NodeCache from "node-cache";
import { config } from "../../config.js";

export const WHITELIST_TTL = config.whitelistCacheTtlS;
export const whitelistCache = new NodeCache({ stdTTL: WHITELIST_TTL, useClones: false });
export const inFlightWhitelistRequests = new Map<string, Promise<string[]>>();
export function resetWhitelistCache(): void {
  whitelistCache.flushAll();
  inFlightWhitelistRequests.clear();
}

export const CLAIM_AUTO_RELEASE_TTL = config.claimAutoReleaseCacheTtlS;
export const claimAutoReleaseCache = new NodeCache({
  stdTTL: CLAIM_AUTO_RELEASE_TTL,
  useClones: false,
});
export const inFlightClaimAutoReleaseRequests = new Map<string, Promise<string>>();
export function resetClaimAutoReleaseCache(): void {
  claimAutoReleaseCache.flushAll();
  inFlightClaimAutoReleaseRequests.clear();
}

export const SUBMIT_CACHE_TTL = config.submitCacheTtlS;
export const submitCache = new NodeCache({
  stdTTL: SUBMIT_CACHE_TTL,
  useClones: false,
});
export const inFlightSubmitRequests = new Map<string, Promise<unknown>>();
export function resetSubmitCache(): void {
  submitCache.flushAll();
  inFlightSubmitRequests.clear();
}

export const BUILD_TX_CACHE_TTL = config.buildTxCacheTtlS;
export const buildTxCache = new NodeCache({
  stdTTL: BUILD_TX_CACHE_TTL,
  useClones: false,
});
export const inFlightBuildTxRequests = new Map<string, Promise<string>>();
export function resetBuildTxCache(): void {
  buildTxCache.flushAll();
  inFlightBuildTxRequests.clear();
}
export function buildTxCacheKey(
  contractId: string,
  method: string,
  sourceAddress: string,
  args: unknown[],
): string {
  return `${contractId}:${method}:${sourceAddress}:${JSON.stringify(args)}`;
}

export const TIME_REMAINING_CACHE_TTL = config.timeRemainingCacheTtlS;
export const timeRemainingCache = new NodeCache({
  stdTTL: TIME_REMAINING_CACHE_TTL,
  useClones: false,
});
export const inFlightTimeRemainingRequests = new Map<string, Promise<number>>();
export function resetTimeRemainingCache(): void {
  timeRemainingCache.flushAll();
  inFlightTimeRemainingRequests.clear();
}

export const PARTIAL_RELEASE_CACHE_TTL = config.partialReleaseCacheTtlS;
export const partialReleaseCache = new NodeCache({
  stdTTL: PARTIAL_RELEASE_CACHE_TTL,
  useClones: false,
});
export const inFlightPartialReleaseRequests = new Map<string, Promise<string>>();
export function resetPartialReleaseCache(): void {
  partialReleaseCache.flushAll();
  inFlightPartialReleaseRequests.clear();
}

// ---------------------------------------------------------------------------
// Fee preview cache (#719)
// ---------------------------------------------------------------------------

export const FEE_PREVIEW_CACHE_TTL = config.feePreviewCacheTtlS;
export const feePreviewCache = new NodeCache({
  stdTTL: FEE_PREVIEW_CACHE_TTL,
  useClones: false,
});
export const inFlightFeePreviewRequests = new Map<string, Promise<unknown>>();
export function resetFeePreviewCache(): void {
  feePreviewCache.flushAll();
  inFlightFeePreviewRequests.clear();
}

/**
 * Cache key for a partial-release build. The amount and source address are
 * part of the key because each combination produces a different unsigned
 * transaction — keying on the contract and milestone alone would serve one
 * caller another caller's XDR.
 */
export function partialReleaseCacheKey(
  contractId: string,
  index: string | number,
  amount: unknown,
  sourceAddress: string,
): string {
  return `${contractId}:${index}:${String(amount)}:${sourceAddress}`;
}

// ---------------------------------------------------------------------------
// Unsigned XDR validity window + cache freshness (#677)
// ---------------------------------------------------------------------------

/**
 * Time bound (seconds) on unsigned transactions handed to the frontend. The
 * user still has to review and sign in their wallet, so 30s routinely
 * produced txTOO_LATE. Clamped to 120–300s.
 */
export const UNSIGNED_TX_TIMEOUT_S = Math.min(
  300,
  Math.max(120, parseInt(process.env.UNSIGNED_TX_TIMEOUT_S || "180", 10) || 180),
);

/**
 * A cached unsigned XDR is only served while at least this many seconds of
 * its time bound remain; otherwise a fresh one is built.
 */
const parsedMinRemaining = parseInt(process.env.UNSIGNED_TX_MIN_REMAINING_S || "20", 10);
export const UNSIGNED_TX_MIN_REMAINING_S = Number.isNaN(parsedMinRemaining)
  ? 20
  : Math.max(0, parsedMinRemaining);

interface CachedUnsignedXdr {
  xdr: string;
  /** Unix seconds: the transaction's timeBounds.maxTime. */
  validUntil: number;
}

/** Reads `maxTime` off a built transaction, falling back to now + timeout. */
export function unsignedTxValidUntil(tx: { timeBounds?: { maxTime: string } }): number {
  const maxTime = Number(tx.timeBounds?.maxTime);
  if (Number.isFinite(maxTime) && maxTime > 0) return maxTime;
  return Math.floor(Date.now() / 1000) + UNSIGNED_TX_TIMEOUT_S;
}

/**
 * Returns the cached XDR only if it still has the minimum signing window
 * left. Stale entries are evicted so the caller rebuilds.
 */
export function getFreshCachedXdr(cache: NodeCache, key: string): string | undefined {
  const entry = cache.get<CachedUnsignedXdr>(key);
  if (entry === undefined) return undefined;
  const remaining = entry.validUntil - Date.now() / 1000;
  if (remaining < UNSIGNED_TX_MIN_REMAINING_S) {
    cache.del(key);
    return undefined;
  }
  return entry.xdr;
}

/**
 * Stores an unsigned XDR with a TTL that never outlives the point at which
 * it would stop being servable, regardless of the configured cache TTL.
 */
export function setCachedXdr(
  cache: NodeCache,
  key: string,
  xdr: string,
  validUntil: number,
  ttlSeconds: number,
): void {
  const servableFor = Math.floor(
    validUntil - Date.now() / 1000 - UNSIGNED_TX_MIN_REMAINING_S,
  );
  const ttl = Math.min(ttlSeconds, servableFor);
  if (ttl <= 0) return;
  cache.set<CachedUnsignedXdr>(key, { xdr, validUntil }, ttl);
}
