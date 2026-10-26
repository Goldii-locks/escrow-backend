import type { NextFunction, Request, Response } from "express";

export type RateBucket = { count: number; resetAt: number };

export interface RouteLimiterOptions {
  name?: string;
  envPrefix: string;
  defaultMax: number;
  defaultWindowMs: number;
}

export type RouteLimiterMiddleware = ((req: Request, res: Response, next: NextFunction) => void) & {
  middleware: RouteLimiterMiddleware;
  reset: () => void;
  buckets: Map<string, RateBucket>;
  sweep: () => void;
};

export function makeRouteLimiter(options: RouteLimiterOptions): RouteLimiterMiddleware {
  const { envPrefix, defaultMax, defaultWindowMs } = options;
  const buckets = new Map<string, RateBucket>();
  let sweepTimer: NodeJS.Timeout | null = null;

  function sweep(now = Date.now()): void {
    for (const [key, bucket] of buckets.entries()) {
      if (now >= bucket.resetAt) buckets.delete(key);
    }
    if (buckets.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  function ensureSweepTimer(windowMs: number): void {
    if (!sweepTimer) {
      sweepTimer = setInterval(() => sweep(), windowMs);
      if (typeof sweepTimer.unref === "function") sweepTimer.unref();
    }
  }

  const resolveWindowMs = (): number => {
    const configured = Number(process.env[`${envPrefix}_WINDOW_MS`] ?? defaultWindowMs);
    return Number.isFinite(configured) && configured > 0 ? configured : defaultWindowMs;
  };

  const resolveMaxRequests = (): number => {
    const configured = Number(process.env[`${envPrefix}_MAX`] ?? defaultMax);
    return Number.isFinite(configured) && configured > 0 ? configured : defaultMax;
  };

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const windowMs = resolveWindowMs();
    const maxRequests = resolveMaxRequests();
    ensureSweepTimer(windowMs);

    const key = req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, maxRequests - bucket.count);
    res.setHeader("X-RateLimit-Limit", String(maxRequests));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > maxRequests) {
      res.status(429).json({ success: false, error: "Too many requests, please try again later" });
      return;
    }

    next();
  };

  middleware.middleware = middleware as RouteLimiterMiddleware;
  middleware.buckets = buckets;
  middleware.sweep = sweep;
  middleware.reset = () => {
    buckets.clear();
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  };

  return middleware as RouteLimiterMiddleware;
}

export const jobContractRateLimit = makeRouteLimiter({ envPrefix: "JOB_CONTRACT_RATE", defaultMax: 30, defaultWindowMs: 60000 });
export const resetJobContractRateLimitBuckets = (): void => jobContractRateLimit.reset();
export const partialReleaseRateLimit = makeRouteLimiter({ envPrefix: "PARTIAL_RELEASE_RATE", defaultMax: 10, defaultWindowMs: 60000 });
export const resetPartialReleaseRateLimitBuckets = (): void => partialReleaseRateLimit.reset();
export const partialPaymentAllocatorRateLimit = makeRouteLimiter({ envPrefix: "PARTIAL_PAYMENT_ALLOCATOR_RATE", defaultMax: 50, defaultWindowMs: 60000 });
export const resetPartialPaymentAllocatorRateLimitBuckets = (): void => partialPaymentAllocatorRateLimit.reset();
export const whitelistUpdateRateLimit = makeRouteLimiter({ envPrefix: "JOB_WHITELIST_UPDATE_RATE", defaultMax: 10, defaultWindowMs: 60000 });
export const resetWhitelistUpdateRateLimitBuckets = (): void => whitelistUpdateRateLimit.reset();
export const jobWhitelistRateLimit = makeRouteLimiter({ envPrefix: "JOB_WHITELIST_RATE", defaultMax: 20, defaultWindowMs: 60000 });
export const resetJobWhitelistRateLimitBuckets = (): void => jobWhitelistRateLimit.reset();
export const timeRemainingRateLimit = makeRouteLimiter({ envPrefix: "TIME_REMAINING_RATE", defaultMax: 60, defaultWindowMs: 60000 });
export const resetTimeRemainingRateLimitBuckets = (): void => timeRemainingRateLimit.reset();
export const buildTxRateLimit = makeRouteLimiter({ envPrefix: "BUILD_TX_RATE", defaultMax: 20, defaultWindowMs: 60000 });
export const resetBuildTxRateLimitBuckets = (): void => buildTxRateLimit.reset();
export const createJobDraftRateLimit = makeRouteLimiter({ envPrefix: "CREATE_JOB_DRAFT_RATE", defaultMax: 5, defaultWindowMs: 60000 });
export const resetCreateJobDraftRateLimitBuckets = (): void => createJobDraftRateLimit.reset();
export const claimAutoReleaseRateLimit = makeRouteLimiter({ envPrefix: "CLAIM_AUTO_RELEASE_RATE", defaultMax: 10, defaultWindowMs: 60000 });
export const resetClaimAutoReleaseRateLimitBuckets = (): void => claimAutoReleaseRateLimit.reset();
export const submitRateLimit = makeRouteLimiter({ envPrefix: "SUBMIT_RATE", defaultMax: 5, defaultWindowMs: 60000 });
export const resetSubmitRateLimitBuckets = (): void => submitRateLimit.reset();
