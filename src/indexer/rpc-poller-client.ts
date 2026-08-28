import { Server } from "@stellar/stellar-sdk/rpc";
import logger from "../utils/logger.js";

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
}

const DEFAULT_CONFIG: RpcRetryConfig = {
  maxRetries: 5,
  initialBackoffMs: 1000,
  backoffMultiplier: 2,
  maxBackoffMs: 30_000,
};

/** Retryable error patterns for RPC connection issues. */
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
  "request timeout",
  "connect timeout",
];

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return RETRYABLE_PATTERNS.some((p) => msg.includes(p.toLowerCase()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute the backoff delay for a given attempt number.
 * attempt 0 → initialBackoffMs
 * attempt 1 → initialBackoffMs * multiplier
 * etc., capped at maxBackoffMs.
 */
export function computeBackoffMs(
  attempt: number,
  config: Pick<RpcRetryConfig, "initialBackoffMs" | "backoffMultiplier" | "maxBackoffMs">
): number {
  return Math.min(
    config.initialBackoffMs * Math.pow(config.backoffMultiplier, attempt),
    config.maxBackoffMs
  );
}

/**
 * Execute an async operation with exponential backoff retry.
 * Returns the result on success, or throws after exhausting retries.
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

      if (!isRetryableError(lastError) || attempt >= cfg.maxRetries) {
        throw lastError;
      }

      const delay = computeBackoffMs(attempt, cfg);
      logger.warn(`${context} failed, retrying`, {
        attempt: attempt + 1,
        maxRetries: cfg.maxRetries,
        backoffMs: delay,
        error: lastError.message,
      });
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * RpcPollerClient wraps a Stellar RPC Server with retry logic for
 * getLatestLedger and getEvents calls.
 */
export class RpcPollerClient {
  private server: Server;
  private config: RpcRetryConfig;

  constructor(rpcUrl: string, config: Partial<RpcRetryConfig> = {}) {
    this.server = new Server(rpcUrl);
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async getLatestLedger(): Promise<{ sequence: number }> {
    return withRetry(
      () => this.server.getLatestLedger(),
      this.config,
      "getLatestLedger"
    );
  }

  async getEvents(params: {
    startLedger: number;
    filters: any[];
    limit: number;
  }): Promise<any> {
    return withRetry(
      () => this.server.getEvents(params),
      this.config,
      "getEvents"
    );
  }

  /** Expose the underlying Server for callers that need raw access. */
  get underlyingServer(): Server {
    return this.server;
  }
}
