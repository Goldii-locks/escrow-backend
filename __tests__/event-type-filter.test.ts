import { jest } from "@jest/globals";
import {
  EVENT_TYPES,
  DEFAULT_BACKOFF_MS,
  MAX_BACKOFF_MS,
  BACKOFF_MULTIPLIER,
  MAX_ATTEMPTS,
  isConnectionError,
  nextBackoff,
  fetchEventsWithRetry,
  type GetEventsParams,
  type RpcGetEventsResult,
} from "../src/indexer/event_type_filter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Instant sleep (no real delays in tests). */
const noopSleep = (): Promise<void> => Promise.resolve();

/** Build a minimal success result matching RpcGetEventsResult. */
function makeSuccessResult(
  count = 0
): RpcGetEventsResult {
  return {
    events: Array.from({ length: count }, (_, i) => ({
      contractId: { contractId: () => `CONTRACT-${i}` },
      topic: [`event_${i}`],
      value: { data: i },
      ledger: 100 + i,
      ledgerClosedAt: new Date().toISOString(),
    })),
  };
}

/**
 * Stand-in for the slice of `Server` that `fetchEventsWithRetry` needs.
 *
 * A bare `jest.fn()` infers `Mock<UnknownFunction>`, which makes
 * `mockResolvedValue` expect `never` and leaves the object unassignable to the
 * `Pick<Server, "getEvents">` parameter. Typing the mock explicitly keeps both
 * the call sites and the `.mock.calls` assertions well typed.
 */
type MockEventsFn = jest.Mock<(params: GetEventsParams) => Promise<RpcGetEventsResult>>;
type MockServer = Parameters<typeof fetchEventsWithRetry>[0] & {
  getEvents: MockEventsFn;
};

/** Build a mock `Server.getEvents` that returns `result`. */
function makeSuccessServer(result: RpcGetEventsResult = makeSuccessResult()): MockServer {
  const getEvents = jest.fn() as MockEventsFn;
  getEvents.mockResolvedValue(result);
  return { getEvents } as unknown as MockServer;
}

/** Build a mock `Server.getEvents` that always throws `err`. */
function makeFailingServer(err: Error): MockServer {
  const getEvents = jest.fn() as MockEventsFn;
  getEvents.mockRejectedValue(err);
  return { getEvents } as unknown as MockServer;
}

/**
 * Build a mock server that fails `failCount` times with `err` then
 * succeeds with `successResult`.
 */
function makePartialFailServer(
  failCount: number,
  err: Error,
  successResult: RpcGetEventsResult = makeSuccessResult(1)
) {
  let calls = 0;
  const getEvents = jest.fn() as MockEventsFn;
  getEvents.mockImplementation(() => {
    calls += 1;
    if (calls <= failCount) return Promise.reject(err);
    return Promise.resolve(successResult);
  });
  return { getEvents } as unknown as MockServer;
}

const BASE_PARAMS: GetEventsParams = {
  startLedger: 42,
  contractIds: ["CONTRACT-ALPHA"],
  limit: 100,
};

// ---------------------------------------------------------------------------
// EVENT_TYPES
// ---------------------------------------------------------------------------

describe("EVENT_TYPES", () => {
  it("contains the expected event type strings", () => {
    expect(EVENT_TYPES).toContain("initialized");
    expect(EVENT_TYPES).toContain("funded");
    expect(EVENT_TYPES).toContain("delivered");
    expect(EVENT_TYPES).toContain("approved");
    expect(EVENT_TYPES).toContain("dispute_raised");
    expect(EVENT_TYPES).toContain("dispute_resolved");
    expect(EVENT_TYPES).toContain("partial_release");
    expect(EVENT_TYPES).toContain("auto_release_claimed");
    expect(EVENT_TYPES).toContain("token_whitelisted");
    expect(EVENT_TYPES).toContain("token_removed");
  });

  it("contains exactly 10 event types", () => {
    expect(EVENT_TYPES.length).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// isConnectionError
// ---------------------------------------------------------------------------

describe("isConnectionError", () => {
  const connectionErrors = [
    "connect ECONNREFUSED 127.0.0.1:26657",
    "read ECONNRESET",
    "connection timeout after 30000ms",
    "ETIMEDOUT",
    "getaddrinfo ENOTFOUND soroban-testnet.stellar.org",
    "EHOSTUNREACH",
    "Network Error occurred",
    "socket hang up",
    "fetch failed",
    "request timeout",
    "getaddrinfo ENOTFOUND host",
    "connect ECONNREFUSED",
  ];

  const nonConnectionErrors = [
    "start is after end",
    "Contract not found",
    "Invalid request body",
    "Internal Server Error",
    "400 Bad Request",
    "rate limit exceeded",
    "Unknown event type",
  ];

  connectionErrors.forEach((msg) => {
    it(`classifies "${msg}" as a connection error`, () => {
      expect(isConnectionError(new Error(msg))).toBe(true);
    });
  });

  nonConnectionErrors.forEach((msg) => {
    it(`does NOT classify "${msg}" as a connection error`, () => {
      expect(isConnectionError(new Error(msg))).toBe(false);
    });
  });

  it("returns false for non-Error values", () => {
    expect(isConnectionError("string error")).toBe(false);
    expect(isConnectionError(42)).toBe(false);
    expect(isConnectionError(null)).toBe(false);
    expect(isConnectionError(undefined)).toBe(false);
    expect(isConnectionError({ message: "ECONNREFUSED" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// nextBackoff
// ---------------------------------------------------------------------------

describe("nextBackoff", () => {
  it("doubles the current backoff", () => {
    expect(nextBackoff(1_000)).toBe(2_000);
    expect(nextBackoff(2_000)).toBe(4_000);
    expect(nextBackoff(16_000)).toBe(32_000);
  });

  it("never exceeds MAX_BACKOFF_MS", () => {
    expect(nextBackoff(MAX_BACKOFF_MS)).toBe(MAX_BACKOFF_MS);
    expect(nextBackoff(MAX_BACKOFF_MS * 10)).toBe(MAX_BACKOFF_MS);
  });

  it("applies BACKOFF_MULTIPLIER correctly", () => {
    expect(nextBackoff(1_000)).toBe(1_000 * BACKOFF_MULTIPLIER);
  });

  it("respects the DEFAULT_BACKOFF_MS starting point", () => {
    expect(nextBackoff(DEFAULT_BACKOFF_MS)).toBe(
      DEFAULT_BACKOFF_MS * BACKOFF_MULTIPLIER
    );
  });
});

// ---------------------------------------------------------------------------
// fetchEventsWithRetry – success path
// ---------------------------------------------------------------------------

describe("fetchEventsWithRetry – success path", () => {
  it("returns the result on the first attempt", async () => {
    const expected = makeSuccessResult(3);
    const server = makeSuccessServer(expected);

    const result = await fetchEventsWithRetry(server, BASE_PARAMS, {
      sleep: noopSleep,
    });

    expect(result).toBe(expected);
    expect(server.getEvents).toHaveBeenCalledTimes(1);
  });

  it("sends a wildcard topic filter, not EVENT_TYPES", async () => {
    const server = makeSuccessServer();

    await fetchEventsWithRetry(server, BASE_PARAMS, { sleep: noopSleep });

    const callArgs = server.getEvents.mock.calls[0][0] as unknown as {
      filters: Array<{ topics: string[][] }>;
    };

    // Soroban RPC only accepts "*" or a base64 XDR ScVal per topic segment.
    expect(callArgs.filters[0].topics).toEqual([["*"]]);

    // Guard against a regression to the raw-ASCII filter that made getEvents
    // reject every poll: the bare strings must not reappear in the request.
    expect(callArgs.filters[0].topics[0]).not.toEqual([...EVENT_TYPES]);
    for (const eventType of EVENT_TYPES) {
      expect(callArgs.filters[0].topics.flat()).not.toContain(eventType);
    }
  });

  it("still sends type 'contract' and the caller's contractIds", async () => {
    const server = makeSuccessServer();

    await fetchEventsWithRetry(server, BASE_PARAMS, { sleep: noopSleep });

    const callArgs = server.getEvents.mock.calls[0][0] as unknown as {
      filters: Array<{ type: string; contractIds: string[] }>;
    };
    expect(callArgs.filters).toHaveLength(1);
    expect(callArgs.filters[0].type).toBe("contract");
    expect(callArgs.filters[0].contractIds).toEqual(BASE_PARAMS.contractIds);
  });

  it("passes contractIds and startLedger from params", async () => {
    const server = makeSuccessServer();
    const params: GetEventsParams = {
      startLedger: 999,
      contractIds: ["C1", "C2"],
      limit: 50,
    };

    await fetchEventsWithRetry(server, params, { sleep: noopSleep });

    const callArgs = server.getEvents.mock.calls[0][0] as unknown as {
      startLedger: number;
      limit: number;
      filters: Array<{ contractIds: string[] }>;
    };
    expect(callArgs.startLedger).toBe(999);
    expect(callArgs.limit).toBe(50);
    expect(callArgs.filters[0].contractIds).toEqual(["C1", "C2"]);
  });

  it("defaults limit to 100 when not specified", async () => {
    const server = makeSuccessServer();

    await fetchEventsWithRetry(
      server,
      { startLedger: 1, contractIds: ["C"] },
      { sleep: noopSleep }
    );

    const callArgs = server.getEvents.mock.calls[0][0] as unknown as { limit: number };
    expect(callArgs.limit).toBe(100);
  });

  it("returns empty events array when RPC returns no events", async () => {
    const server = makeSuccessServer(makeSuccessResult(0));

    const result = await fetchEventsWithRetry(server, BASE_PARAMS, {
      sleep: noopSleep,
    });

    expect(result.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// fetchEventsWithRetry – non-connection errors propagate immediately
// ---------------------------------------------------------------------------

describe("fetchEventsWithRetry – non-connection error propagation", () => {
  it("throws immediately on a non-connection error without retrying", async () => {
    const err = new Error("start is after end");
    const server = makeFailingServer(err);

    await expect(
      fetchEventsWithRetry(server, BASE_PARAMS, { sleep: noopSleep })
    ).rejects.toThrow("start is after end");

    // Only one call – no retries for non-connection errors
    expect(server.getEvents).toHaveBeenCalledTimes(1);
  });

  it("propagates the original error object", async () => {
    const original = new Error("Invalid contract ID");
    const server = makeFailingServer(original);

    await expect(
      fetchEventsWithRetry(server, BASE_PARAMS, { sleep: noopSleep })
    ).rejects.toBe(original);
  });
});

// ---------------------------------------------------------------------------
// fetchEventsWithRetry – retry on connection errors
// ---------------------------------------------------------------------------

describe("fetchEventsWithRetry – retry on connection errors", () => {
  it("retries on ECONNREFUSED and succeeds on second attempt", async () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:26657");
    const expected = makeSuccessResult(2);
    const server = makePartialFailServer(1, err, expected);

    const result = await fetchEventsWithRetry(server, BASE_PARAMS, {
      sleep: noopSleep,
    });

    expect(result).toBe(expected);
    expect(server.getEvents).toHaveBeenCalledTimes(2);
  });

  it("retries up to maxAttempts and then throws the last error", async () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:26657");
    const server = makeFailingServer(err);

    await expect(
      fetchEventsWithRetry(server, BASE_PARAMS, {
        maxAttempts: 3,
        sleep: noopSleep,
      })
    ).rejects.toThrow("connect ECONNREFUSED");

    expect(server.getEvents).toHaveBeenCalledTimes(3);
  });

  it("does not exceed MAX_ATTEMPTS by default", async () => {
    const err = new Error("ETIMEDOUT");
    const server = makeFailingServer(err);

    await expect(
      fetchEventsWithRetry(server, BASE_PARAMS, { sleep: noopSleep })
    ).rejects.toThrow();

    expect(server.getEvents).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it("succeeds on the last possible attempt", async () => {
    const err = new Error("ETIMEDOUT");
    const expected = makeSuccessResult(1);
    const server = makePartialFailServer(MAX_ATTEMPTS - 1, err, expected);

    const result = await fetchEventsWithRetry(server, BASE_PARAMS, {
      sleep: noopSleep,
    });

    expect(result).toBe(expected);
    expect(server.getEvents).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it("retries on ECONNRESET", async () => {
    const server = makePartialFailServer(
      2,
      new Error("read ECONNRESET"),
      makeSuccessResult(1)
    );

    await fetchEventsWithRetry(server, BASE_PARAMS, { sleep: noopSleep });

    expect(server.getEvents).toHaveBeenCalledTimes(3);
  });

  it("retries on fetch failed", async () => {
    const server = makePartialFailServer(
      1,
      new Error("fetch failed"),
      makeSuccessResult(1)
    );

    await fetchEventsWithRetry(server, BASE_PARAMS, { sleep: noopSleep });

    expect(server.getEvents).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// fetchEventsWithRetry – exponential backoff timing
// ---------------------------------------------------------------------------

describe("fetchEventsWithRetry – exponential backoff timing", () => {
  it("waits DEFAULT_BACKOFF_MS before the first retry", async () => {
    const sleepDelays: number[] = [];
    const err = new Error("connect ECONNREFUSED");
    const server = makePartialFailServer(1, err, makeSuccessResult());

    await fetchEventsWithRetry(server, BASE_PARAMS, {
      sleep: (ms) => {
        sleepDelays.push(ms);
        return Promise.resolve();
      },
    });

    expect(sleepDelays).toHaveLength(1);
    expect(sleepDelays[0]).toBe(DEFAULT_BACKOFF_MS);
  });

  it("doubles the backoff on each consecutive failure", async () => {
    const sleepDelays: number[] = [];
    const err = new Error("connect ECONNREFUSED");

    // Fail 4 times, then succeed on attempt 5
    const server = makePartialFailServer(4, err, makeSuccessResult());

    await fetchEventsWithRetry(server, BASE_PARAMS, {
      maxAttempts: 5,
      initialBackoffMs: 1_000,
      sleep: (ms) => {
        sleepDelays.push(ms);
        return Promise.resolve();
      },
    });

    // After attempt 1 → sleep 1000, attempt 2 → sleep 2000, attempt 3 → sleep 4000, attempt 4 → sleep 8000
    expect(sleepDelays).toHaveLength(4);
    expect(sleepDelays[0]).toBe(1_000);
    expect(sleepDelays[1]).toBe(2_000);
    expect(sleepDelays[2]).toBe(4_000);
    expect(sleepDelays[3]).toBe(8_000);
  });

  it("backoff increases by BACKOFF_MULTIPLIER each step", async () => {
    const sleepDelays: number[] = [];
    const err = new Error("ETIMEDOUT");

    // Always fail so we collect all backoffs up to maxAttempts
    const server = makeFailingServer(err);

    await fetchEventsWithRetry(server, BASE_PARAMS, {
      maxAttempts: 5,
      initialBackoffMs: 500,
      sleep: (ms) => {
        sleepDelays.push(ms);
        return Promise.resolve();
      },
    }).catch(() => {
      // Expected to throw after exhausting retries
    });

    // 4 sleeps for attempts 1–4 (attempt 5 is the last, no sleep after it)
    expect(sleepDelays).toHaveLength(4);
    for (let i = 1; i < sleepDelays.length; i++) {
      expect(sleepDelays[i]).toBe(
        Math.min(sleepDelays[i - 1] * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS)
      );
    }
  });

  it("caps backoff at MAX_BACKOFF_MS when growth would exceed it", async () => {
    const sleepDelays: number[] = [];
    const err = new Error("ETIMEDOUT");
    const server = makeFailingServer(err);

    // Start near the cap so it hits it quickly
    const startingBackoff = MAX_BACKOFF_MS / 2;

    await fetchEventsWithRetry(server, BASE_PARAMS, {
      maxAttempts: 4,
      initialBackoffMs: startingBackoff,
      sleep: (ms) => {
        sleepDelays.push(ms);
        return Promise.resolve();
      },
    }).catch(() => {});

    // sleepDelays[0] = MAX_BACKOFF_MS / 2  (first delay = initialBackoffMs)
    // sleepDelays[1] = MAX_BACKOFF_MS      (doubled, but capped)
    // sleepDelays[2] = MAX_BACKOFF_MS      (already at cap)
    expect(sleepDelays[0]).toBe(startingBackoff);
    expect(sleepDelays[1]).toBe(MAX_BACKOFF_MS);
    expect(sleepDelays[2]).toBe(MAX_BACKOFF_MS);
  });

  it("backoff sequence grows strictly until the cap, then stays flat", async () => {
    const sleepDelays: number[] = [];
    const err = new Error("connect ECONNREFUSED");
    const server = makeFailingServer(err);

    await fetchEventsWithRetry(server, BASE_PARAMS, {
      maxAttempts: 6,
      initialBackoffMs: DEFAULT_BACKOFF_MS,
      sleep: (ms) => {
        sleepDelays.push(ms);
        return Promise.resolve();
      },
    }).catch(() => {});

    // Verify strictly increasing or plateau at MAX_BACKOFF_MS
    for (let i = 1; i < sleepDelays.length; i++) {
      expect(sleepDelays[i]).toBeGreaterThanOrEqual(sleepDelays[i - 1]);
      expect(sleepDelays[i]).toBeLessThanOrEqual(MAX_BACKOFF_MS);
    }
  });
});

// ---------------------------------------------------------------------------
// fetchEventsWithRetry – custom maxAttempts
// ---------------------------------------------------------------------------

describe("fetchEventsWithRetry – maxAttempts option", () => {
  it("respects maxAttempts = 1 (no retries)", async () => {
    const err = new Error("ETIMEDOUT");
    const server = makeFailingServer(err);

    await expect(
      fetchEventsWithRetry(server, BASE_PARAMS, {
        maxAttempts: 1,
        sleep: noopSleep,
      })
    ).rejects.toThrow();

    expect(server.getEvents).toHaveBeenCalledTimes(1);
  });

  it("respects maxAttempts = 2 (exactly one retry)", async () => {
    const err = new Error("ETIMEDOUT");
    const server = makeFailingServer(err);

    await fetchEventsWithRetry(server, BASE_PARAMS, {
      maxAttempts: 2,
      sleep: noopSleep,
    }).catch(() => {});

    expect(server.getEvents).toHaveBeenCalledTimes(2);
  });

  it("respects a custom high maxAttempts value", async () => {
    const err = new Error("connect ECONNREFUSED");
    const server = makePartialFailServer(7, err, makeSuccessResult(1));

    const result = await fetchEventsWithRetry(server, BASE_PARAMS, {
      maxAttempts: 10,
      sleep: noopSleep,
    });

    expect(result.events).toHaveLength(1);
    expect(server.getEvents).toHaveBeenCalledTimes(8); // 7 failures + 1 success
  });
});

// ---------------------------------------------------------------------------
// fetchEventsWithRetry – retry frequency increases test (acceptance criteria)
// ---------------------------------------------------------------------------

describe("fetchEventsWithRetry – retry frequency increases up to max attempts", () => {
  it("verifies each successive wait is longer than the previous (growing backoff)", async () => {
    const delays: number[] = [];
    const err = new Error("connect ECONNREFUSED 127.0.0.1:26657");
    const server = makeFailingServer(err);

    await fetchEventsWithRetry(server, BASE_PARAMS, {
      maxAttempts: 5,
      initialBackoffMs: 100,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    }).catch(() => {});

    // Must have exactly 4 delays (before attempts 2, 3, 4, 5)
    expect(delays).toHaveLength(4);

    // Each delay must be strictly larger than the previous (until cap)
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
  });

  it("total sleep time increases exponentially across failed attempts", async () => {
    const delays: number[] = [];
    const err = new Error("ETIMEDOUT");
    const server = makeFailingServer(err);

    await fetchEventsWithRetry(server, BASE_PARAMS, {
      maxAttempts: 5,
      initialBackoffMs: 1_000,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    }).catch(() => {});

    // Expected: 1000, 2000, 4000, 8000
    expect(delays[0]).toBe(1_000);
    expect(delays[1]).toBe(2_000);
    expect(delays[2]).toBe(4_000);
    expect(delays[3]).toBe(8_000);

    const totalSleep = delays.reduce((a, b) => a + b, 0);
    expect(totalSleep).toBe(15_000);
  });

  it("call count matches maxAttempts exactly on total failure", async () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:26657");
    const callTimes: number[] = [];
    let fakeNow = 0;

    const server = {
      getEvents: jest.fn().mockImplementation(() => {
        callTimes.push(fakeNow);
        fakeNow += 1;
        return Promise.reject(err);
      }),
    } as unknown as MockServer;

    await fetchEventsWithRetry(server, BASE_PARAMS, {
      maxAttempts: MAX_ATTEMPTS,
      sleep: (ms) => {
        fakeNow += ms;
        return Promise.resolve();
      },
    }).catch(() => {});

    expect(callTimes).toHaveLength(MAX_ATTEMPTS);
  });

  it("stops retrying and throws after maxAttempts connection errors", async () => {
    let callCount = 0;
    const err = new Error("socket hang up");

    const server = {
      getEvents: jest.fn().mockImplementation(() => {
        callCount++;
        return Promise.reject(err);
      }),
    } as unknown as MockServer;

    const maxAttempts = 4;

    await expect(
      fetchEventsWithRetry(server, BASE_PARAMS, {
        maxAttempts,
        sleep: noopSleep,
      })
    ).rejects.toThrow("socket hang up");

    expect(callCount).toBe(maxAttempts);
  });
});

// ---------------------------------------------------------------------------
// fetchEventsWithRetry – mixed error scenarios
// ---------------------------------------------------------------------------

describe("fetchEventsWithRetry – mixed error scenarios", () => {
  it("stops retrying immediately when a non-connection error follows connection errors", async () => {
    let callCount = 0;
    const connectionErr = new Error("ETIMEDOUT");
    const nonConnectionErr = new Error("Contract not found");

    const server = {
      getEvents: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 2) return Promise.reject(connectionErr);
        return Promise.reject(nonConnectionErr);
      }),
    } as unknown as MockServer;

    await expect(
      fetchEventsWithRetry(server, BASE_PARAMS, { sleep: noopSleep })
    ).rejects.toThrow("Contract not found");

    // 2 connection retries + 1 non-connection call = 3 total
    expect(callCount).toBe(3);
  });

  it("handles alternating errors by only stopping on non-connection errors", async () => {
    let callCount = 0;
    const connErr = new Error("fetch failed");
    const badErr = new Error("400 Bad Request");

    const server = {
      getEvents: jest.fn().mockImplementation(() => {
        callCount++;
        // Fail with connection error first, then bad request
        if (callCount === 1) return Promise.reject(connErr);
        return Promise.reject(badErr);
      }),
    } as unknown as MockServer;

    await expect(
      fetchEventsWithRetry(server, BASE_PARAMS, { sleep: noopSleep })
    ).rejects.toThrow("400 Bad Request");

    expect(callCount).toBe(2);
  });
});
