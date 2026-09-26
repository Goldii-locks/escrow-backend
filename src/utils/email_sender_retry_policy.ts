/**
 * Email Sender Service — retry backoff policy and queue
 *
 * The schedule worker must not hammer a failing provider, and it must not
 * strand an alert by giving up too early either. This module turns the
 * deployment's thresholds into an explicit, inspectable backoff schedule and
 * provides the queue that applies it.
 *
 * All time is passed in by the caller, so the queue is fully deterministic in
 * tests and never depends on a wall clock inside the module.
 */

export const EMAIL_RETRY_ERRORS = {
  INVALID_CONFIG: "ESR_INVALID_CONFIG",
  INVALID_ATTEMPT: "ESR_INVALID_ATTEMPT",
  UNKNOWN_ENTRY: "ESR_UNKNOWN_ENTRY",
} as const;

export type EmailRetryErrorCode =
  (typeof EMAIL_RETRY_ERRORS)[keyof typeof EMAIL_RETRY_ERRORS];

export type RetryPolicyConfig = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
  jitterRatio?: number;
};

export type RetryPolicy = {
  /** Total attempts allowed, including the first send. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  /** Fraction of the nominal delay that jitter may add or remove (0 - 0.5). */
  jitterRatio: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitterRatio: 0.2,
};

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Resolve the effective policy. Explicit arguments win, then the deployment's
 * environment variables, then the defaults; anything invalid falls back.
 */
export function resolveRetryPolicy(config: RetryPolicyConfig = {}): RetryPolicy {
  const candidate: RetryPolicyConfig = {
    maxAttempts: config.maxAttempts ?? envNumber("EMAIL_SENDER_RETRY_MAX_ATTEMPTS") ?? DEFAULT_RETRY_POLICY.maxAttempts,
    baseDelayMs: config.baseDelayMs ?? envNumber("EMAIL_SENDER_RETRY_BASE_DELAY_MS") ?? DEFAULT_RETRY_POLICY.baseDelayMs,
    maxDelayMs: config.maxDelayMs ?? envNumber("EMAIL_SENDER_RETRY_MAX_DELAY_MS") ?? DEFAULT_RETRY_POLICY.maxDelayMs,
    multiplier: config.multiplier ?? envNumber("EMAIL_SENDER_RETRY_MULTIPLIER") ?? DEFAULT_RETRY_POLICY.multiplier,
    jitterRatio: config.jitterRatio ?? envNumber("EMAIL_SENDER_RETRY_JITTER_RATIO") ?? DEFAULT_RETRY_POLICY.jitterRatio,
  };

  const invalid = (message: string): never => {
    throw new Error(`${EMAIL_RETRY_ERRORS.INVALID_CONFIG}: ${message}`);
  };

  const maxAttempts = candidate.maxAttempts!;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    invalid("maxAttempts must be a positive integer");
  }
  if (maxAttempts > 20) invalid("maxAttempts must not exceed 20");

  const baseDelayMs = candidate.baseDelayMs!;
  if (!Number.isFinite(baseDelayMs) || baseDelayMs <= 0) {
    invalid("baseDelayMs must be greater than zero");
  }

  const maxDelayMs = candidate.maxDelayMs!;
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < baseDelayMs) {
    invalid("maxDelayMs must be greater than or equal to baseDelayMs");
  }

  const multiplier = candidate.multiplier!;
  if (!Number.isFinite(multiplier) || multiplier < 1) {
    invalid("multiplier must be at least 1");
  }

  const jitterRatio = candidate.jitterRatio!;
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 0.5) {
    invalid("jitterRatio must be between 0 and 0.5");
  }

  return { maxAttempts, baseDelayMs, maxDelayMs, multiplier, jitterRatio };
}

/**
 * The delay to wait after `attempt` has failed (attempt is 1-based, so attempt
 * 1 is the first send). The nominal delay grows by `multiplier` per attempt and
 * is capped at `maxDelayMs`; `random` defaults to `Math.random` and only
 * perturbs the result by +/- `jitterRatio`.
 */
export function retryDelayMs(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`${EMAIL_RETRY_ERRORS.INVALID_ATTEMPT}: attempt must be a positive integer`);
  }

  const nominal = Math.min(
    policy.baseDelayMs * policy.multiplier ** (attempt - 1),
    policy.maxDelayMs
  );

  if (policy.jitterRatio === 0) return Math.round(nominal);

  const factor = 1 - policy.jitterRatio + random() * policy.jitterRatio * 2;
  return Math.round(Math.min(nominal * factor, policy.maxDelayMs));
}

/** True while another attempt is still allowed. */
export function shouldRetry(attempt: number, policy: RetryPolicy): boolean {
  return attempt < policy.maxAttempts;
}

/** The nominal (un-jittered) backoff schedule between successive attempts. */
export function buildRetrySchedule(policy: RetryPolicy): number[] {
  const schedule: number[] = [];
  for (let attempt = 1; attempt < policy.maxAttempts; attempt += 1) {
    schedule.push(retryDelayMs(attempt, policy, () => 0.5));
  }
  return schedule;
}

/** Total wall-clock time the full schedule would consume, ignoring send time. */
export function totalBackoffMs(policy: RetryPolicy): number {
  return buildRetrySchedule(policy).reduce((total, delay) => total + delay, 0);
}

export type RetryEntryStatus = "pending" | "due" | "delivered" | "exhausted";

export type RetryEntry<T> = {
  id: string;
  item: T;
  attempts: number;
  dueAt: number;
  status: RetryEntryStatus;
  lastError: string | null;
};

/**
 * A bounded retry queue for the schedule worker. The caller drives time, so a
 * test can advance the queue without sleeping.
 */
export class EmailRetryQueue<T> {
  private readonly entries = new Map<string, RetryEntry<T>>();
  private sequence = 0;

  constructor(
    private readonly policy: RetryPolicy,
    private readonly random: () => number = Math.random
  ) {
    if (!policy || !Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
      throw new Error(`${EMAIL_RETRY_ERRORS.INVALID_CONFIG}: a resolved policy is required`);
    }
  }

  /** Add an item that is due immediately. */
  enqueue(item: T, nowMs: number, id?: string): RetryEntry<T> {
    this.sequence += 1;
    const entry: RetryEntry<T> = {
      id: id ?? `mail-${this.sequence}`,
      item,
      attempts: 0,
      dueAt: nowMs,
      status: "pending",
      lastError: null,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  get(id: string): RetryEntry<T> | undefined {
    return this.entries.get(id);
  }

  /** Entries whose next attempt is due at or before `nowMs`. */
  due(nowMs: number): RetryEntry<T>[] {
    return [...this.entries.values()]
      .filter((entry) => entry.status === "pending" && entry.dueAt <= nowMs)
      .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
  }

  size(): number {
    return [...this.entries.values()].filter(
      (entry) => entry.status === "pending" || entry.status === "due"
    ).length;
  }

  /**
   * Record a failed attempt. The entry is rescheduled with the policy's backoff
   * while attempts remain, otherwise it is marked exhausted.
   */
  markFailed(id: string, nowMs: number, error?: string): RetryEntry<T> {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new Error(`${EMAIL_RETRY_ERRORS.UNKNOWN_ENTRY}: no queued entry "${id}"`);
    }

    entry.attempts += 1;
    entry.lastError = error ?? null;

    if (shouldRetry(entry.attempts, this.policy)) {
      entry.dueAt = nowMs + retryDelayMs(entry.attempts, this.policy, this.random);
      entry.status = "pending";
    } else {
      entry.dueAt = Number.POSITIVE_INFINITY;
      entry.status = "exhausted";
    }

    return entry;
  }

  /** Record a successful attempt; the entry leaves the queue. */
  markDelivered(id: string): RetryEntry<T> {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new Error(`${EMAIL_RETRY_ERRORS.UNKNOWN_ENTRY}: no queued entry "${id}"`);
    }
    entry.attempts += 1;
    entry.status = "delivered";
    entry.dueAt = Number.POSITIVE_INFINITY;
    return entry;
  }

  stats(): { pending: number; delivered: number; exhausted: number; attempts: number } {
    const all = [...this.entries.values()];
    return {
      pending: all.filter((entry) => entry.status === "pending" || entry.status === "due").length,
      delivered: all.filter((entry) => entry.status === "delivered").length,
      exhausted: all.filter((entry) => entry.status === "exhausted").length,
      attempts: all.reduce((total, entry) => total + entry.attempts, 0),
    };
  }
}
