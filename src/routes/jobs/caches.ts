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

