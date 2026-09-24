import type { NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import logger from "../utils/logger.js";

type RateBucket = {
  count: number;
  resetAt: number;
};

const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10);

const generalMax =
  process.env.NODE_ENV === "test"
    ? 0
    : parseInt(process.env.RATE_LIMIT_MAX || "100", 10);

const strictMax =
  process.env.NODE_ENV === "test"
    ? 0
    : parseInt(process.env.RATE_LIMIT_MAX_STRICT || "10", 10);

const walletLookupBuckets = new Map<string, RateBucket>();

const rateLimitMessage = { success: false, error: "Too many requests, please try again later" };

function resolveWalletLookupMax(): number {
  const configured = Number(process.env.BY_WALLET_RATE_LIMIT_MAX ?? "30");
  return Number.isFinite(configured) && configured > 0 ? configured : 30;
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
