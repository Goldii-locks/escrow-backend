import type { NextFunction, Request, Response } from "express";

type RateBucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, RateBucket>();

export function resetInterestYieldRateLimitBuckets(): void {
  buckets.clear();
}

function resolveWindowMs(): number {
  const configured = Number(process.env.INTEREST_YIELD_RATE_WINDOW_MS ?? "60000");
  return Number.isFinite(configured) && configured > 0 ? configured : 60000;
}

function resolveMaxRequests(): number {
  const configured = Number(process.env.INTEREST_YIELD_RATE_MAX ?? "30");
  return Number.isFinite(configured) && configured > 0 ? configured : 30;
}

/**
 * Dedicated rate limiter for POST /api/estimate/interest-yield.
 *
 * Follows the same per-path bucket pattern as the job-contract rate limiters:
 * a rolling window keyed by client IP, standard X-RateLimit-* headers, and a
 * 429 `{ success: false, error: ... }` body once the threshold is exceeded.
 */
export function interestYieldRateLimit(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const windowMs = resolveWindowMs();
  const maxRequests = resolveMaxRequests();
  const key = req.ip || req.socket.remoteAddress || "unknown";
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
    res.status(429).json({
      success: false,
      error: "Too many requests, please try again later",
    });
    return;
  }

  next();
}
