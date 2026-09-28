import type { NextFunction, Request, Response } from "express";
import logger from "../utils/logger.js";

type RateBucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, RateBucket>();

export function resetRefundRatioRateLimitBuckets(): void {
  buckets.clear();
}

function resolveWindowMs(): number {
  const configured = Number(process.env.REFUND_RATIO_RATE_WINDOW_MS ?? "60000");
  return Number.isFinite(configured) && configured > 0 ? configured : 60000;
}

function resolveMaxRequests(): number {
  const configured = Number(process.env.REFUND_RATIO_RATE_MAX ?? "20");
  return Number.isFinite(configured) && configured > 0 ? configured : 20;
}

/** Dedicated path rate limiter for requests hitting refund_ratio_helper. */
export function refundRatioRateLimit(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const windowMs = resolveWindowMs();
  const maxRequests = resolveMaxRequests();
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
    logger.warn("Refund ratio helper rate limit exceeded", {
      label: "refund-ratio-helper",
      ip: key,
      path: req.originalUrl,
      status: 429,
    });
    res.setHeader(
      "Retry-After",
      String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)))
    );
    res.status(429).json({
      success: false,
      error: "Too many requests, please try again later",
    });
    return;
  }

  next();
}
