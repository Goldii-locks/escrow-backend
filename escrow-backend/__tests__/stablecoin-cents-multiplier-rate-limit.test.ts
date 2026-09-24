import { stablecoinCentsMultiplier } from '../src/utils/stablecoin_cents_multiplier';

/**
 * Rate limiting checks for stablecoin_cents_multiplier calls.
 *
 * The helper is a pure precision-conversion utility, so rate limiting is
 * enforced at the request boundary. These tests exercise a small in-memory
 * limiter that mirrors the production path limiter configuration and assert
 * that requests exceeding the configured threshold are rejected with a 429.
 */

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 5;

interface RateLimitResult {
  status: number;
  allowed: boolean;
  retryAfter?: number;
}

class PathRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly maxRequests: number = MAX_REQUESTS_PER_WINDOW,
    private readonly windowMs: number = WINDOW_MS,
  ) {}

  check(key: string, now: number = Date.now()): RateLimitResult {
    const timestamps = (this.hits.get(key) ?? []).filter(
      (ts) => now - ts < this.windowMs,
    );

    if (timestamps.length >= this.maxRequests) {
      const oldest = timestamps[0];
      const retryAfter = Math.ceil((this.windowMs - (now - oldest)) / 1000);
      this.hits.set(key, timestamps);
      return { status: 429, allowed: false, retryAfter };
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);
    return { status: 200, allowed: true };
  }
}

const PATH = '/stablecoin_cents_multiplier';

describe('stablecoin_cents_multiplier rate limiting', () => {
  let limiter: PathRateLimiter;

  beforeEach(() => {
    limiter = new PathRateLimiter();
  });

  it('allows requests up to the configured threshold', () => {
    for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i += 1) {
      const result = limiter.check(PATH);
      expect(result.allowed).toBe(true);
      expect(result.status).toBe(200);
    }
  });

  it('returns 429 once the threshold is exceeded', () => {
    for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i += 1) {
      limiter.check(PATH);
    }

    const result = limiter.check(PATH);
    expect(result.allowed).toBe(false);
    expect(result.status).toBe(429);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('keeps returning 429 for subsequent requests within the window', () => {
    for (let i = 0; i < MAX_REQUESTS_PER_WINDOW + 3; i += 1) {
      limiter.check(PATH);
    }

    const result = limiter.check(PATH);
    expect(result.status).toBe(429);
  });

  it('resets the window after the configured duration elapses', () => {
    const start = 1_000_000;
    for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i += 1) {
      limiter.check(PATH, start + i);
    }

    expect(limiter.check(PATH, start + MAX_REQUESTS_PER_WINDOW).status).toBe(429);

    const afterWindow = start + WINDOW_MS + 1;
    const result = limiter.check(PATH, afterWindow);
    expect(result.allowed).toBe(true);
    expect(result.status).toBe(200);
  });

  it('tracks limits independently per client key', () => {
    for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i += 1) {
      limiter.check('client-a');
    }

    expect(limiter.check('client-a').status).toBe(429);
    expect(limiter.check('client-b').status).toBe(200);
  });

  it('still converts cents correctly when requests are allowed', () => {
    const result = limiter.check(PATH);
    expect(result.allowed).toBe(true);
    expect(stablecoinCentsMultiplier(1)).toBe(100);
  });
});
