import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";

/**
 * Rate limiting for the unauthenticated email-notification endpoints (#…).
 *
 * The endpoints take no wallet credential, so their only abuse control is a
 * rate limit. Two independent budgets apply to POST /api/notifications/email:
 *
 *  - per client IP, so one host cannot enumerate addresses; and
 *  - per email address, so one address cannot be spammed from many hosts.
 *
 * Both windows and maxima come from config.ts (EMAIL_PER_IP_RATE_MAX,
 * EMAIL_PER_ADDRESS_RATE_MAX, EMAIL_RATE_WINDOW_MS) so a deployment can tune
 * them without a code change. Implemented with in-process buckets like the
 * by-wallet limiter rather than express-rate-limit so the address budget can
 * key on the request body.
 */

interface RateBucket {
  count: number;
  resetAt: number;
}

const ipBuckets = new Map<string, RateBucket>();
const addressBuckets = new Map<string, RateBucket>();

/** Clear every bucket. Test-only. */
export function resetEmailRateLimitBuckets(): void {
  ipBuckets.clear();
  addressBuckets.clear();
}

export const EMAIL_RATE_LIMIT_MESSAGE = {
  success: false,
  error: "Too many requests, please try again later",
} as const;

export function normalizeEmailAddress(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Increment a bucket and report whether the caller is still within budget. */
function consume(
  buckets: Map<string, RateBucket>,
  key: string,
  windowMs: number,
  max: number,
): boolean {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count <= max;
}

/** Per-IP budget for the notification routes. */
export function emailIpRateLimiter(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const key = req.ip || req.socket.remoteAddress || "unknown";
  if (
    !consume(
      ipBuckets,
      key,
      config.emailRateWindowMs,
      config.emailPerIpRateMax,
    )
  ) {
    res.status(429).json(EMAIL_RATE_LIMIT_MESSAGE);
    return;
  }
  next();
}

/**
 * Per-email-address budget for POST /api/notifications/email. Must run after
 * the JSON body parser so `req.body.email` is available; an absent/invalid
 * address shares a single bucket so it still cannot be used to bypass the
 * limiter.
 */
export function emailAddressRateLimiter(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const key = normalizeEmailAddress(req.body?.email);
  if (
    !consume(
      addressBuckets,
      key,
      config.emailRateWindowMs,
      config.emailPerAddressRateMax,
    )
  ) {
    res.status(429).json(EMAIL_RATE_LIMIT_MESSAGE);
    return;
  }
  next();
}
