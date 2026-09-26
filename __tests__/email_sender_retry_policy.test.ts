import {
  DEFAULT_RETRY_POLICY,
  EMAIL_RETRY_ERRORS,
  EmailRetryQueue,
  buildRetrySchedule,
  resolveRetryPolicy,
  retryDelayMs,
  shouldRetry,
  totalBackoffMs,
} from "../src/utils/email_sender_retry_policy.js";

const ORIGINAL_ENV = { ...process.env };

/** A random source that yields the nominal delay exactly. */
const nominal = () => 0.5;
const minimal = () => 0;
const maximal = () => 1;

const POLICY = resolveRetryPolicy({
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitterRatio: 0.2,
});

describe("email_sender_retry_policy", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe("resolveRetryPolicy", () => {
    it("falls back to the documented defaults", () => {
      for (const key of [
        "EMAIL_SENDER_RETRY_MAX_ATTEMPTS",
        "EMAIL_SENDER_RETRY_BASE_DELAY_MS",
        "EMAIL_SENDER_RETRY_MAX_DELAY_MS",
        "EMAIL_SENDER_RETRY_MULTIPLIER",
        "EMAIL_SENDER_RETRY_JITTER_RATIO",
      ]) {
        delete process.env[key];
      }
      expect(resolveRetryPolicy()).toEqual(DEFAULT_RETRY_POLICY);
    });

    it("reads deployment thresholds from the environment", () => {
      process.env.EMAIL_SENDER_RETRY_MAX_ATTEMPTS = "3";
      process.env.EMAIL_SENDER_RETRY_BASE_DELAY_MS = "1000";
      process.env.EMAIL_SENDER_RETRY_MAX_DELAY_MS = "8000";
      process.env.EMAIL_SENDER_RETRY_MULTIPLIER = "3";
      process.env.EMAIL_SENDER_RETRY_JITTER_RATIO = "0";

      expect(resolveRetryPolicy()).toEqual({
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 8000,
        multiplier: 3,
        jitterRatio: 0,
      });
    });

    it("prefers explicit arguments over the environment", () => {
      process.env.EMAIL_SENDER_RETRY_MAX_ATTEMPTS = "9";
      expect(resolveRetryPolicy({ maxAttempts: 2 }).maxAttempts).toBe(2);
    });

    it("ignores a non-numeric environment value", () => {
      process.env.EMAIL_SENDER_RETRY_MAX_ATTEMPTS = "many";
      expect(resolveRetryPolicy().maxAttempts).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
    });

    it("rejects inconsistent thresholds", () => {
      expect(() => resolveRetryPolicy({ maxAttempts: 0 })).toThrow(EMAIL_RETRY_ERRORS.INVALID_CONFIG);
      expect(() => resolveRetryPolicy({ maxAttempts: 21 })).toThrow(/must not exceed 20/);
      expect(() => resolveRetryPolicy({ baseDelayMs: 0 })).toThrow(/baseDelayMs/);
      expect(() => resolveRetryPolicy({ baseDelayMs: 5000, maxDelayMs: 1000 })).toThrow(/maxDelayMs/);
      expect(() => resolveRetryPolicy({ multiplier: 0.5 })).toThrow(/multiplier/);
      expect(() => resolveRetryPolicy({ jitterRatio: 0.9 })).toThrow(/jitterRatio/);
    });
  });

  describe("retryDelayMs — delays scale with the configuration thresholds", () => {
    it("grows by the multiplier on each attempt", () => {
      // 500, 1000, 2000, 4000 for a 2x multiplier.
      expect(retryDelayMs(1, POLICY, nominal)).toBe(500);
      expect(retryDelayMs(2, POLICY, nominal)).toBe(1000);
      expect(retryDelayMs(3, POLICY, nominal)).toBe(2000);
      expect(retryDelayMs(4, POLICY, nominal)).toBe(4000);
    });

    it("caps the delay at maxDelayMs", () => {
      const capped = resolveRetryPolicy({ maxAttempts: 8, baseDelayMs: 500, maxDelayMs: 3000, multiplier: 2, jitterRatio: 0 });
      // 500, 1000, 2000, then capped at 3000.
      expect(buildRetrySchedule(capped)).toEqual([500, 1000, 2000, 3000, 3000, 3000, 3000]);
    });

    it("honours a 1x multiplier as a constant delay", () => {
      const flat = resolveRetryPolicy({ maxAttempts: 4, baseDelayMs: 750, maxDelayMs: 10_000, multiplier: 1, jitterRatio: 0 });
      expect(buildRetrySchedule(flat)).toEqual([750, 750, 750]);
    });

    it("brackets the nominal delay with jitter", () => {
      const nominalDelay = retryDelayMs(3, POLICY, nominal);
      expect(retryDelayMs(3, POLICY, minimal)).toBeLessThan(nominalDelay);
      expect(retryDelayMs(3, POLICY, maximal)).toBeGreaterThan(nominalDelay);
      // +/- 20% of 2000 -> 1600 .. 2400
      expect(retryDelayMs(3, POLICY, minimal)).toBe(1600);
      expect(retryDelayMs(3, POLICY, maximal)).toBe(2400);
    });

    it("never exceeds maxDelayMs even at maximum jitter", () => {
      const nearCap = resolveRetryPolicy({ maxAttempts: 6, baseDelayMs: 500, maxDelayMs: 2000, multiplier: 2, jitterRatio: 0.5 });
      expect(retryDelayMs(5, nearCap, maximal)).toBe(2000);
    });

    it("is deterministic when jitter is disabled", () => {
      const noJitter = resolveRetryPolicy({ jitterRatio: 0 });
      expect(retryDelayMs(4, noJitter, maximal)).toBe(retryDelayMs(4, noJitter, minimal));
    });

    it("rejects an invalid attempt number", () => {
      expect(() => retryDelayMs(0, POLICY)).toThrow(EMAIL_RETRY_ERRORS.INVALID_ATTEMPT);
    });
  });

  describe("schedule helpers", () => {
    it("builds the full nominal schedule and totals it", () => {
      expect(buildRetrySchedule(POLICY)).toEqual([500, 1000, 2000, 4000]);
      expect(totalBackoffMs(POLICY)).toBe(7500);
    });

    it("limits retries to maxAttempts", () => {
      expect(shouldRetry(1, POLICY)).toBe(true);
      expect(shouldRetry(4, POLICY)).toBe(true);
      expect(shouldRetry(5, POLICY)).toBe(false);
    });
  });

  describe("EmailRetryQueue", () => {
    it("enqueues items as immediately due", () => {
      const queue = new EmailRetryQueue<string>(POLICY, nominal);
      queue.enqueue("a", 1000, "a");
      queue.enqueue("b", 1000, "b");

      expect(queue.size()).toBe(2);
      expect(queue.due(999)).toEqual([]);
      expect(queue.due(1000).map((entry) => entry.id)).toEqual(["a", "b"]);
    });

    it("reschedules a failure using the backoff schedule", () => {
      const queue = new EmailRetryQueue<string>(POLICY, nominal);
      queue.enqueue("a", 0, "a");

      const first = queue.markFailed("a", 0);
      expect(first.attempts).toBe(1);
      expect(first.status).toBe("pending");
      expect(first.dueAt).toBe(500); // 500 * 2^0

      expect(queue.due(499)).toEqual([]);
      expect(queue.due(500).map((entry) => entry.id)).toEqual(["a"]);

      const second = queue.markFailed("a", 500);
      expect(second.dueAt).toBe(1500); // 500 + 1000

      const third = queue.markFailed("a", 1500);
      expect(third.dueAt).toBe(3500); // 1500 + 2000

      const fourth = queue.markFailed("a", 3500);
      expect(fourth.dueAt).toBe(7500); // 3500 + 4000
    });

    it("exhausts an entry once maxAttempts failures are recorded", () => {
      const queue = new EmailRetryQueue<string>(POLICY, nominal);
      queue.enqueue("a", 0, "a");

      let now = 0;
      for (let attempt = 0; attempt < POLICY.maxAttempts; attempt += 1) {
        const entry = queue.markFailed("a", now, `smtp-${attempt}`);
        now = entry.dueAt;
      }

      const entry = queue.get("a")!;
      expect(entry.attempts).toBe(5);
      expect(entry.status).toBe("exhausted");
      expect(entry.dueAt).toBe(Number.POSITIVE_INFINITY);
      expect(entry.lastError).toBe("smtp-4");
      expect(queue.size()).toBe(0);
      expect(queue.due(Number.MAX_SAFE_INTEGER)).toEqual([]);
    });

    it("removes a delivered entry from the pending set", () => {
      const queue = new EmailRetryQueue<string>(POLICY, nominal);
      queue.enqueue("a", 0, "a");
      queue.markFailed("a", 0);
      queue.markDelivered("a");

      expect(queue.size()).toBe(0);
      expect(queue.stats()).toEqual({ pending: 0, delivered: 1, exhausted: 0, attempts: 2 });
    });

    it("counts outcomes across a mix of entries", () => {
      const queue = new EmailRetryQueue<string>(resolveRetryPolicy({ maxAttempts: 2, jitterRatio: 0 }), nominal);
      queue.enqueue("a", 0, "a");
      queue.enqueue("b", 0, "b");
      queue.enqueue("c", 0, "c");

      queue.markDelivered("a");
      queue.markFailed("b", 0);
      queue.markFailed("b", 1);
      queue.markFailed("c", 0);

      expect(queue.stats()).toEqual({ pending: 1, delivered: 1, exhausted: 1, attempts: 4 });
    });

    it("rejects an unknown entry id", () => {
      const queue = new EmailRetryQueue<string>(POLICY, nominal);
      expect(() => queue.markFailed("nope", 0)).toThrow(EMAIL_RETRY_ERRORS.UNKNOWN_ENTRY);
      expect(() => queue.markDelivered("nope")).toThrow(EMAIL_RETRY_ERRORS.UNKNOWN_ENTRY);
    });

    it("generates sequential ids when none is supplied", () => {
      const queue = new EmailRetryQueue<string>(POLICY, nominal);
      expect(queue.enqueue("a", 0).id).toBe("mail-1");
      expect(queue.enqueue("b", 0).id).toBe("mail-2");
    });
  });
});
