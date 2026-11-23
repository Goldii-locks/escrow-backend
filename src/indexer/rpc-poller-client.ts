import { Server } from "@stellar/stellar-sdk/rpc";
import type { Api } from "@stellar/stellar-sdk/rpc";
import logger from "../utils/logger.js";
import { rpcAllowHttp } from "../utils/rpc-allow-http.js";
import { config } from "../config.js";

/**
 * RpcPollerClient wraps the Stellar RPC Server with exponential backoff retry
 * logic for transient failures (timeouts, connection errors, rate limits).
 *
 * The backoff strategy doubles the delay on each retry up to a configurable
 * ceiling, then resets on success.
 */

export interface RpcRetryConfig {
  /** Maximum number of retry attempts per call (default: 5) */
  maxRetries: number;
  /** Initial delay in ms after first failure (default: 1000) */
  initialBackoffMs: number;
  /** Multiplier applied to backoff on each consecutive failure (default: 2) */
  backoffMultiplier: number;
  /** Ceiling delay in ms (default: 30000) */
  maxBackoffMs: number;
  /**
   * Injectable source of jitter, returning a value in [0, 1). Defaults to
   * Math.random in production; tests pass a seeded function for determinism.
   */
  random?: () => number;
}

/** A source of backoff jitter, returning a value in [0, 1). */
export type BackoffRandom = () => number;

const DEFAULT_CONFIG: RpcRetryConfig = {
  maxRetries: 5,
  initialBackoffMs: 1000,
  backoffMultiplier: 2,
  maxBackoffMs: 30_000,
};

/** Retryable error patterns for RPC connection issues (#688). */
const RETRYABLE_PATTERNS = [
  "timeout",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "socket hang up",
  "network",
  "status 429",
  "status 503",
  "status 502",
  "status 500",
  "status code 429",
  "status code 503",
  "too many requests",
  "service unavailable",
  "rate limit",
  "rate-limit",
  "ratelimit",
  "request timeout",
  "connect timeout",
  "aborterror",
];

/**
 * HTTP statuses that are always retryable when observed on an RPC error,
 * regardless of message wording.
 */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/** Extract an HTTP status code from common RPC/SDK error shapes. */
export function getErrorStatusCode(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const record = err as Record<string, unknown>;
  const candidates: unknown[] = [
    record["status"],
    record["statusCode"],
    record["code"],
    (record["response"] as Record<string, unknown> | undefined)?.["status"],
    (record["response"] as Record<string, unknown> | undefined)?.["statusCode"],
    (record["response"] as { status?: unknown } | undefined)?.status,
  ];
  for (const candidate of candidates) {
    const n = typeof candidate === "string" ? Number(candidate) : candidate;
    if (typeof n === "number" && Number.isInteger(n)) return n;
  }
  return null;
}

/**
 * Parse a `Retry-After` header value into milliseconds.
 *
 * Accepts delay-seconds (`"120"`) and HTTP-date forms. Returns `null` when
 * the value is missing or unparseable so callers fall back to backoff.
 */
export function parseRetryAfterMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value * 1000);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000;
  }
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }
  return null;
}

/**
 * Read `Retry-After` (seconds or HTTP-date) from common error shapes.
 * Checks `response.headers`, `headers`, and `retryAfter` fields,
 * case-insensitively for header names.
 */
export function getRetryAfterMs(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const record = err as Record<string, unknown>;
  const headerSources: unknown[] = [
    (record["response"] as Record<string, unknown> | undefined)?.["headers"],
    record["headers"],
  ];
  for (const source of headerSources) {
    if (typeof source !== "object" || source === null) continue;
    const headers = source as Record<string, unknown>;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "retry-after") {
        const parsed = parseRetryAfterMs(headers[key]);
        if (parsed !== null) return parsed;
      }
    }
  }
  const direct = parseRetryAfterMs(record["retryAfter"]);
  if (direct !== null) return direct;
  return parseRetryAfterMs(record["retry_after"]);
}

/** Errors that retrying cannot fix: malformed requests (#674). */
const NON_RETRYABLE_PATTERNS = [
  "status 400",
  "-32602",
  "invalid params",
  "invalid parameters",
];

const RETRYABLE_ERROR_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"]);

export function isRetryableError(err: unknown): boolean {
  if (!err) return false;
  const record = (typeof err === "object" ? err : {}) as {
    name?: unknown;
    code?: unknown;
    error?: { code?: unknown };
  };

  // Aborted requests and dropped connections are transient.
  if (
    record.name === "AbortError" ||
    (typeof record.code === "string" && RETRYABLE_ERROR_CODES.has(record.code))
  ) {
    return true;
  }

  // An HTTP status decides on its own: 429/5xx retry, any other 4xx does not.
  const status = getErrorStatusCode(err);
  if (status !== null) {
    if (RETRYABLE_STATUS_CODES.has(status)) return true;
    if (status >= 400 && status < 500) return false;
  }

  // JSON-RPC invalid params (-32602) is a malformed request, never transient.
  if (record.code === -32602 || record.error?.code === -32602) return false;

  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err !== null && "message" in err
        ? String((err as { message?: unknown }).message ?? "")
        : String(err ?? "");
  if (!msg) return false;
  const lower = msg.toLowerCase();
  if (NON_RETRYABLE_PATTERNS.some((p) => lower.includes(p))) return false;
  return RETRYABLE_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute the backoff delay for a given attempt number using full jitter:
 * `random() * min(initial * multiplier^attempt, max)`.
 *
 * attempt 0 → up to initialBackoffMs
 * attempt 1 → up to initialBackoffMs * multiplier
 * etc., capped at maxBackoffMs.
 *
 * Jitter de-synchronises retries from callers that hit a 429/503 at the same
 * time (the poller, admin backfills, reconciliation and other instances).
 * The random source is injectable; it defaults to `() => 1` so callers that
 * want the deterministic upper bound (and the existing tests) keep it.
 */
export function computeBackoffMs(
  attempt: number,
  config: Pick<RpcRetryConfig, "initialBackoffMs" | "backoffMultiplier" | "maxBackoffMs">,
  random: BackoffRandom = () => 1
): number {
  const cap = Math.min(
    config.initialBackoffMs * Math.pow(config.backoffMultiplier, attempt),
    config.maxBackoffMs
  );
  const sample = random();
  const fraction = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 1;
  return cap * fraction;
}

/**
 * Execute an async operation with exponential backoff retry (#688).
 *
 * This is the indexer's single retry policy: every RPC call (`getEvents`,
 * `getLatestLedger`) goes through here. 429 responses honour `Retry-After`
 * when present (seconds or HTTP-date); otherwise the exponential backoff
 * applies. Returns the result on success, or throws after exhausting retries.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RpcRetryConfig> = {},
  context: string = "rpc_call"
): Promise<T> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Preserve transport metadata (status / headers) that `new Error()`
      // would drop, so Retry-After extraction still works for plain objects.
      if (!(err instanceof Error) && typeof err === "object" && err !== null) {
        Object.assign(
          lastError as unknown as Record<string, unknown>,
          err as Record<string, unknown>
        );
      }

      if (!isRetryableError(err) || attempt >= cfg.maxRetries) {
        throw lastError;
      }

      const backoff = computeBackoffMs(attempt, cfg, cfg.random ?? Math.random);
      const retryAfter = getRetryAfterMs(err);
      const delay =
        retryAfter !== null
          ? Math.min(Math.max(retryAfter, backoff), cfg.maxBackoffMs)
          : backoff;
      logger.warn(`${context} failed, retrying`, {
        attempt: attempt + 1,
        maxRetries: cfg.maxRetries,
        backoffMs: delay,
        retryAfterMs: retryAfter,
        statusCode: getErrorStatusCode(err),
        error: lastError.message,
      });
      await sleep(delay);
    }
  }

  throw lastError;
}


/**
 * Minimal surface of the Stellar RPC Server used by this client. Declaring it
 * structurally lets tests inject a stub server without a live RPC endpoint.
 */
export interface RpcServerLike {
  getLatestLedger(): Promise<{ sequence: number }>;
  getEvents(params: RpcGetEventsParams): Promise<Api.GetEventsResponse>;
}

export interface RpcGetEventsParams {
  /** Inclusive first ledger. Mutually exclusive with `cursor`. */
  startLedger?: number;
  /** Paging cursor returned by a previous getEvents call. */
  cursor?: string;
  filters?: Api.EventFilter[];
  limit?: number;
}

export interface RpcPollerClientOptions extends Partial<RpcRetryConfig> {
  /** Inject a server stub instead of connecting to `rpcUrl`. */
  server?: RpcServerLike;
}

/**
 * RpcPollerClient wraps a Stellar RPC Server with retry logic for
 * getLatestLedger and getEvents calls. Turning an `Api.EventResponse` into an
 * `EventRow` lives only in the poller (`toEventRow`), so there is one decoder.
 */
export class RpcPollerClient {
  private server: RpcServerLike;
  private config: RpcRetryConfig;

  constructor(rpcUrl: string, options: RpcPollerClientOptions = {}) {
    this.server =
      options.server ??
      new Server(rpcUrl, {
        allowHttp: rpcAllowHttp(rpcUrl),
        timeout: config.rpcTimeoutMs,
      });
    this.config = {
      maxRetries: options.maxRetries ?? DEFAULT_CONFIG.maxRetries,
      initialBackoffMs:
        options.initialBackoffMs ?? DEFAULT_CONFIG.initialBackoffMs,
      backoffMultiplier:
        options.backoffMultiplier ?? DEFAULT_CONFIG.backoffMultiplier,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULT_CONFIG.maxBackoffMs,
      random: options.random,
    };
  }

  /**
   * The underlying RPC server. Prefer `getEvents()` / `getLatestLedger()`
   * so calls share this client's single retry policy (#688).
   */
  get rpcServer(): RpcServerLike {
    return this.server;
  }

  async getLatestLedger(): Promise<{ sequence: number }> {
    return withRetry(
      () => this.server.getLatestLedger(),
      this.config,
      "getLatestLedger"
    );
  }

  async getEvents(params: RpcGetEventsParams): Promise<Api.GetEventsResponse> {
    return withRetry(
      () => this.server.getEvents(params),
      this.config,
      "getEvents"
    );
  }

  /** Expose the underlying Server for callers that need raw access. */
  get underlyingServer(): RpcServerLike {
    return this.server;
  }
}
