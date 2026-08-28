/**
 * Shared exponential backoff retry helper for RPC connection timeouts.
 * Used by both the indexer's event ingestion (duplicate prevention) and
 * ledger range tracking paths so both retry against the same RPC client
 * with identical, DRY backoff rules.
 */
import logger from "./logger.js";

export interface BackoffOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

export const DEFAULT_BACKOFF_OPTIONS: Required<
  Omit<BackoffOptions, "onRetry">
> = {
  maxAttempts: 5,
  initialDelayMs: 250,
  maxDelayMs: 8000,
  multiplier: 2,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Delay before a given retry attempt: initialDelayMs * multiplier^(attempt-1),
 * capped at maxDelayMs.
 */
export function computeBackoffDelayMs(
  attempt: number,
  options: Pick<
    BackoffOptions,
    "initialDelayMs" | "maxDelayMs" | "multiplier"
  > = {}
): number {
  const initialDelayMs =
    options.initialDelayMs ?? DEFAULT_BACKOFF_OPTIONS.initialDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_BACKOFF_OPTIONS.maxDelayMs;
  const multiplier = options.multiplier ?? DEFAULT_BACKOFF_OPTIONS.multiplier;

  const delayMs = initialDelayMs * Math.pow(multiplier, attempt - 1);
  return Math.min(delayMs, maxDelayMs);
}

export class RpcRetryError extends Error {
  public readonly attempts: number;
  public readonly cause: unknown;

  constructor(message: string, attempts: number, cause: unknown) {
    super(message);
    this.name = "RpcRetryError";
    this.attempts = attempts;
    this.cause = cause;
  }
}

/**
 * Retries an async RPC call with exponential backoff on failure (e.g.
 * connection timeouts / dropouts). Retries up to maxAttempts total attempts,
 * doubling the delay each time up to maxDelayMs, then throws RpcRetryError.
 */
export async function withRpcBackoff<T>(
  fn: () => Promise<T>,
  options: BackoffOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_BACKOFF_OPTIONS.maxAttempts;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt >= maxAttempts) break;

      const delayMs = computeBackoffDelayMs(attempt, options);
      options.onRetry?.(attempt, delayMs, err);
      logger.warn("RPC call failed, retrying with exponential backoff", {
        attempt,
        maxAttempts,
        delayMs,
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(delayMs);
    }
  }

  throw new RpcRetryError(
    `RPC call failed after ${maxAttempts} attempts`,
    maxAttempts,
    lastError
  );
}
