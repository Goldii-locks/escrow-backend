import type { NextFunction, Request, Response } from "express";
import logger from "../utils/logger.js";

type RateBucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, RateBucket>();

export function resetFinancialReportExporterRateLimitBuckets(): void {
  buckets.clear();
}

function resolveWindowMs(): number {
  const configured = Number(process.env.FINANCIAL_REPORT_EXPORTER_RATE_WINDOW_MS ?? "60000");
  return Number.isFinite(configured) && configured > 0 ? configured : 60000;
}

function resolveMaxRequests(): number {
  const configured = Number(process.env.FINANCIAL_REPORT_EXPORTER_RATE_MAX ?? "20");
  return Number.isFinite(configured) && configured > 0 ? configured : 20;
}

/**
 * Dedicated path rate limiter for requests hitting financial_report_exporter.
 *
 * The exporter streams a whole transaction-log spreadsheet, so it is far more
 * expensive than a normal read: the default allowance is deliberately lower
 * than the generic API limiter and is configurable per deployment through
 * FINANCIAL_REPORT_EXPORTER_RATE_MAX / FINANCIAL_REPORT_EXPORTER_RATE_WINDOW_MS.
 */
export function financialReportExporterRateLimit(
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
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfterSeconds));
    logger.warn("Financial report exporter rate limit exceeded", {
      label: "financial-report-exporter",
      ip: key,
      status: 429,
      retryAfterSeconds,
    });
    res.status(429).json({
      success: false,
      error: "Too many requests, please try again later",
      retryAfterSeconds,
    });
    return;
  }

  next();
}
