import type { NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { config } from "../config.js";
import logger from "../utils/logger.js";

type RateBucket = {
  count: number;
  resetAt: number;
};

const windowMs = config.rateLimitWindowMs;

const generalMax =
  process.env.NODE_ENV === "test" ? 0 : config.rateLimitMax;

const strictMax =
  process.env.NODE_ENV === "test" ? 0 : config.rateLimitMaxStrict;

const walletLookupBuckets = new Map<string, RateBucket>();

const rateLimitMessage = { success: false, error: "Too many requests, please try again later" };

function resolveWalletLookupMax(): number {
  try {
    return config.byWalletRateLimitMax;
  } catch {
    return 30;
  }
}

export function resetByWalletRateLimitBuckets(): void {
  walletLookupBuckets.clear();
}

export const generalLimiter = rateLimit({
  windowMs,
  max: generalMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitMessage,
});

export const strictLimiter = rateLimit({
  windowMs,
  max: strictMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitMessage,
});

export function walletLookupLimiter(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const walletLookupMax = resolveWalletLookupMax();

  let bucket = walletLookupBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    walletLookupBuckets.set(key, bucket);
  }

  bucket.count += 1;

  const remaining = Math.max(0, walletLookupMax - bucket.count);
  res.setHeader("X-RateLimit-Limit", String(walletLookupMax));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count > walletLookupMax) {
    const address = typeof req.params?.address === "string" ? req.params.address : undefined;
    logger.warn("Rate limit exceeded", { label: "by-wallet", address, status: 429 });
    res.status(429).json(rateLimitMessage);
    return;
  }

  next();
}
