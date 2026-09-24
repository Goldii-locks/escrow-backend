import { Request, Response, NextFunction } from 'express';

/**
 * Minimal in-memory sliding-window rate limiter.
 *
 * Used to guard client requests that hit the `stablecoin_cents_multiplier`
 * precision conversion helper. Requests exceeding the configured threshold
 * are rejected with HTTP 429.
 */
export interface RateLimitOptions {
  /** Length of the window in milliseconds. */
  windowMs: number;
  /** Maximum number of requests allowed per window per client. */
  max: number;
  /** Optional message returned in the 429 body. */
  message?: string;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

const DEFAULT_MESSAGE = 'Too many requests, please try again later.';

/**
 * Builds an Express middleware that rate limits requests by client key.
 *
 * The client key is derived from the authenticated user when available,
 * otherwise it falls back to the request IP so unauthenticated callers are
 * still throttled.
 */
export function createRateLimiter(options: RateLimitOptions) {
  const { windowMs, max, message = DEFAULT_MESSAGE } = options;
  const hits = new Map<string, WindowEntry>();

  return function rateLimiter(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    const key = clientKey(req);

    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;

    const remaining = Math.max(0, max - entry.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: message });
      return;
    }

    next();
  };
}

function clientKey(req: Request): string {
  const user = (req as Request & { user?: { id?: string | number } }).user;
  if (user && user.id !== undefined && user.id !== null) {
    return `user:${user.id}`;
  }
  return `ip:${req.ip ?? 'unknown'}`;
}

/**
 * Rate limiter applied to client requests hitting the
 * `stablecoin_cents_multiplier` conversion helper.
 *
 * Thresholds are configurable via environment variables so deployments can
 * tune them without a code change.
 */
export const stablecoinCentsMultiplierRateLimiter = createRateLimiter({
  windowMs: Number(process.env.STABLECOIN_CENTS_MULTIPLIER_RATE_WINDOW_MS) || 60_000,
  max: Number(process.env.STABLECOIN_CENTS_MULTIPLIER_RATE_MAX) || 60,
  message: 'Too many stablecoin_cents_multiplier requests, please try again later.',
});
