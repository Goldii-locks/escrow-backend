import { z } from "zod";

// ---------------------------------------------------------------------------
// Centralized numeric environment-variable parsing (#624)
// ---------------------------------------------------------------------------
// Bare `parseInt(process.env.<NAME> || "default", 10)` silently turns typos such as
// RATE_LIMIT_MAX=100r (or an empty-but-set value) into NaN or a truncated
// number. NodeCache({ stdTTL: NaN }) and setTimeout(fn, NaN) then misbehave
// in hard-to-diagnose ways (a NaN poll interval hot-loops against the RPC).
//
// Every numeric setting lives here behind live getters, so tests can override
// values via process.env without re-importing modules. Invalid values throw
// with the variable named; validateConfigAtStartup() touches every setting so
// a bad value fails fast at boot instead of at first use.

const intSchema = z.coerce.number().int();

function readIntEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = intSchema.safeParse(raw);
  const value = parsed.success ? parsed.data : NaN;
  if (!parsed.success || !Number.isFinite(value)) {
    throw new Error(
      `Invalid numeric environment variable ${name}=${JSON.stringify(raw)}: ` +
        `expected an integer (default ${fallback})`,
    );
  }
  if (value < min) {
    throw new Error(
      `Invalid numeric environment variable ${name}=${JSON.stringify(raw)}: ` +
        `must be >= ${min} (default ${fallback})`,
    );
  }
  return value;
}

/** First set (non-empty) variable wins; validation errors name that variable. */
function readFirstIntEnv(names: string[], fallback: number, min = 0): number {
  for (const name of names) {
    const raw = process.env[name];
    if (raw !== undefined && raw !== "") return readIntEnv(name, fallback, min);
  }
  return fallback;
}

const IS_TEST_ENV = process.env.NODE_ENV === "test";

function testAwareFallback(testValue: number, prodValue: number): number {
  return IS_TEST_ENV ? testValue : prodValue;
}

export const config = {
  // RPC / Stellar
  get rpcTimeoutMs(): number {
    return readIntEnv("RPC_TIMEOUT_MS", 10000, 1);
  },

  // Route cache TTLs (seconds)
  get whitelistCacheTtlS(): number {
    return readIntEnv("WHITELIST_CACHE_TTL_S", 60);
  },
  get claimAutoReleaseCacheTtlS(): number {
    return readIntEnv("CLAIM_AUTO_RELEASE_CACHE_TTL_S", 60);
  },
  get submitCacheTtlS(): number {
    return readIntEnv("SUBMIT_CACHE_TTL_S", 30);
  },
  get buildTxCacheTtlS(): number {
    return readIntEnv("BUILD_TX_CACHE_TTL_S", 30);
  },
  get timeRemainingCacheTtlS(): number {
    return readIntEnv("TIME_REMAINING_CACHE_TTL_S", 15);
  },
  get partialReleaseCacheTtlS(): number {
    return readIntEnv("PARTIAL_RELEASE_CACHE_TTL_S", 30);
  },
  get feePreviewCacheTtlS(): number {
    return readIntEnv("FEE_PREVIEW_CACHE_TTL_S", 30);
  },

  // Rate limiting
  get rateLimitWindowMs(): number {
    return readIntEnv("RATE_LIMIT_WINDOW_MS", 60000, 1);
  },
  get rateLimitMax(): number {
    return readIntEnv("RATE_LIMIT_MAX", 100);
  },
  get rateLimitMaxStrict(): number {
    return readIntEnv("RATE_LIMIT_MAX_STRICT", 10);
  },
  get byWalletRateLimitMax(): number {
    return readIntEnv("BY_WALLET_RATE_LIMIT_MAX", 30, 1);
  },

  // Indexer RPC retry/backoff
  get indexerRpcMaxRetries(): number {
    return readIntEnv("INDEXER_RPC_MAX_RETRIES", 5);
  },
  get indexerRpcInitialBackoffMs(): number {
    return readIntEnv(
      "INDEXER_RPC_INITIAL_BACKOFF_MS",
      testAwareFallback(1, 1000),
      1,
    );
  },
  get indexerRpcBackoffMultiplier(): number {
    return readIntEnv("INDEXER_RPC_BACKOFF_MULTIPLIER", 2, 1);
  },
  get indexerRpcMaxBackoffMs(): number {
    return readIntEnv(
      "INDEXER_RPC_MAX_BACKOFF_MS",
      testAwareFallback(5, 30000),
      1,
    );
  },

  // Indexer runner failure/stall tracking
  get indexerRunnerFailureThreshold(): number {
    return readFirstIntEnv(
      ["INDEXER_RUNNER_FAILURE_THRESHOLD", "POLLER_FAILURE_THRESHOLD"],
      3,
      1,
    );
  },
  get indexerRunnerStallThresholdMs(): number {
    return readFirstIntEnv(
      ["INDEXER_RUNNER_STALL_THRESHOLD_MS", "POLLER_STALL_THRESHOLD_MS"],
      120000,
      1,
    );
  },

  // Poll loop intervals
  get pollIntervalMs(): number {
    return readIntEnv("POLL_INTERVAL_MS", 15000, 1);
  },
  get pollIntervalMaxMs(): number {
    return readIntEnv("POLL_INTERVAL_MAX_MS", 120000, 1);
  },
  get pollDiagnosticLogMinIntervalMs(): number {
    return readIntEnv("POLL_DIAGNOSTIC_LOG_MIN_INTERVAL_MS", 60000, 1);
  },
  get maxLedgersPerImport(): number {
    return readIntEnv("MAX_LEDGERS_PER_IMPORT", 10000, 1);
  },

  // Readiness probe (#622)
  get readyMaxPollAgeMs(): number {
    return readIntEnv(
      "READY_MAX_POLL_AGE_MS",
      readIntEnv("POLL_INTERVAL_MAX_MS", 120000, 1) * 3,
      1,
    );
  },

  // Graceful shutdown (#623)
  get shutdownTimeoutMs(): number {
    return readIntEnv("SHUTDOWN_TIMEOUT_MS", 10000, 1);
  },
} as const;

/** Throw at startup when any numeric env var is invalid, naming the variable. */
export function validateConfigAtStartup(): void {
  // Accessing each property invokes its getter, which throws on invalid input.
  for (const key of Object.keys(config) as Array<keyof typeof config>) {
    void config[key];
  }
}
