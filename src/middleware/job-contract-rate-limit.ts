import type { NextFunction, Request, Response } from "express";

type RateBucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, RateBucket>();

export function resetJobContractRateLimitBuckets(): void {
  buckets.clear();
}

function resolveWindowMs(): number {
  const configured = Number(process.env.JOB_CONTRACT_RATE_WINDOW_MS ?? "60000");
  return Number.isFinite(configured) && configured > 0 ? configured : 60000;
}

function resolveMaxRequests(): number {
  const configured = Number(process.env.JOB_CONTRACT_RATE_MAX ?? "30");
  return Number.isFinite(configured) && configured > 0 ? configured : 30;
}

/** Dedicated rate limiter for GET /api/jobs/:contractId. */
export function jobContractRateLimit(
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

const whitelistBuckets = new Map<string, RateBucket>();

export function resetJobWhitelistRateLimitBuckets(): void {
  whitelistBuckets.clear();
}

function resolveWhitelistWindowMs(): number {
  const configured = Number(process.env.JOB_WHITELIST_RATE_WINDOW_MS ?? "60000");
  return Number.isFinite(configured) && configured > 0 ? configured : 60000;
}

function resolveWhitelistMaxRequests(): number {
  const configured = Number(process.env.JOB_WHITELIST_RATE_MAX ?? "30");
  return Number.isFinite(configured) && configured > 0 ? configured : 30;
}

/** Dedicated rate limiter for GET /api/jobs/:contractId/whitelist. */
export function jobWhitelistRateLimit(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const windowMs = resolveWhitelistWindowMs();
  const maxRequests = resolveWhitelistMaxRequests();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();

  let bucket = whitelistBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    whitelistBuckets.set(key, bucket);
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
