/**
 * Task 1 — RPC Retry Backoff for ledger_range_tracker
 *
 * Verifies that the tracker applies exponential backoff when fetchEvents
 * throws a transient RPC / connection-timeout error, that the delay grows
 * across successive attempts up to the configured ceiling, and that the
 * tracker caps retries at maxRetries before propagating the error.
 *
 * All timing is asserted against the *calls* to the injected sleep function
 * (or the fetchEvents mock) rather than wall-clock time so the suite runs
 * in milliseconds, even at high attempt counts.
 */

import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import { setDb, runMigrations } from "../src/indexer/db.js";
import {
  computeLedgerRangeRpcBackoffMs,
  isLedgerRangeRpcRetryable,
  withLedgerRangeRpcRetry,
  DEFAULT_LEDGER_RANGE_RPC_RETRY_CONFIG,
  type LedgerRangeRpcRetryConfig,
} from "../src/indexer/ledger-range-tracker.js";

// ─── logger mock ────────────────────────────────────────────────────────────

const mockLogger = {
  info: jest.fn<(...args: unknown[]) => void>(),
  warn: jest.fn<(...args: unknown[]) => void>(),
  error: jest.fn<(...args: unknown[]) => void>(),
  debug: jest.fn<(...args: unknown[]) => void>(),
};

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: mockLogger,
}));

// ─── Database setup ──────────────────────────────────────────────────────────

describe("LedgerRangeTracker — RPC retry backoff (#Task1)", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
    runMigrations();
  });

  afterAll(() => {
    testDb.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── computeLedgerRangeRpcBackoffMs ───────────────────────────────────────

  describe("computeLedgerRangeRpcBackoffMs – exponential delay schedule", () => {
    const cfg: Pick<
      LedgerRangeRpcRetryConfig,
      "initialBackoffMs" | "backoffMultiplier" | "maxBackoffMs"
    > = {
      initialBackoffMs: 100,
      backoffMultiplier: 2,
      maxBackoffMs: 1_600,
    };

    it("returns initialBackoffMs on attempt 0", () => {
      expect(computeLedgerRangeRpcBackoffMs(0, cfg)).toBe(100);
    });

    it("doubles the delay on each successive attempt", () => {
      expect(computeLedgerRangeRpcBackoffMs(1, cfg)).toBe(200);
      expect(computeLedgerRangeRpcBackoffMs(2, cfg)).toBe(400);
      expect(computeLedgerRangeRpcBackoffMs(3, cfg)).toBe(800);
    });

    it("caps the delay at maxBackoffMs", () => {
      expect(computeLedgerRangeRpcBackoffMs(4, cfg)).toBe(1_600);
      expect(computeLedgerRangeRpcBackoffMs(10, cfg)).toBe(1_600);
    });

    it("the delay sequence is strictly non-decreasing up to the cap", () => {
      const delays = Array.from({ length: 8 }, (_, i) =>
        computeLedgerRangeRpcBackoffMs(i, cfg),
      );
      for (let i = 1; i < delays.length; i++) {
        expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
      }
    });

    it("uses DEFAULT_LEDGER_RANGE_RPC_RETRY_CONFIG values", () => {
      const d = DEFAULT_LEDGER_RANGE_RPC_RETRY_CONFIG;
      // attempt 0 → initialBackoffMs
      expect(computeLedgerRangeRpcBackoffMs(0, d)).toBe(d.initialBackoffMs);
      // attempt maxRetries → capped at maxBackoffMs
      const last = computeLedgerRangeRpcBackoffMs(d.maxRetries, d);
      expect(last).toBeLessThanOrEqual(d.maxBackoffMs);
    });
  });

  // ─── isLedgerRangeRpcRetryable ────────────────────────────────────────────

  describe("isLedgerRangeRpcRetryable – error classification", () => {
    const retryable = [
      "Connection timeout",
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "socket hang up",
      "network error",
      "status 429",
      "status 503",
      "status 502",
      "request timeout",
      "connect timeout",
      "connection reset",
      "connection refused",
      "connection dropped",
    ];

    const nonRetryable = [
      "Invalid ledger sequence",
      "Authentication failed",
      "Not found",
      "SQLITE_CONSTRAINT",
      "Unexpected token",
    ];

    it.each(retryable)("classifies %s as retryable", (msg) => {
      expect(isLedgerRangeRpcRetryable(new Error(msg))).toBe(true);
    });

    it.each(nonRetryable)("classifies %s as non-retryable", (msg) => {
      expect(isLedgerRangeRpcRetryable(new Error(msg))).toBe(false);
    });

    it("returns false for non-Error values", () => {
      expect(isLedgerRangeRpcRetryable("timeout")).toBe(false);
      expect(isLedgerRangeRpcRetryable(null)).toBe(false);
      expect(isLedgerRangeRpcRetryable(429)).toBe(false);
    });
  });

  // ─── withLedgerRangeRpcRetry – retry logic ────────────────────────────────

  describe("withLedgerRangeRpcRetry – retry loop", () => {
    // Collapse all sleeps to 0 ms so tests run instantly.
    const fastConfig: LedgerRangeRpcRetryConfig = {
      maxRetries: 4,
      initialBackoffMs: 1,
      backoffMultiplier: 2,
      maxBackoffMs: 8,
    };

    it("returns the result immediately on first success", async () => {
      const fn = jest.fn<() => Promise<string>>().mockResolvedValue("ok");
      const result = await withLedgerRangeRpcRetry(fn, fastConfig);
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries on transient errors and succeeds on the next attempt", async () => {
      const fn = jest
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValue("recovered");

      const result = await withLedgerRangeRpcRetry(fn, fastConfig);
      expect(result).toBe("recovered");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry on a non-retryable error", async () => {
      const fn = jest
        .fn<() => Promise<string>>()
        .mockRejectedValue(new Error("Authentication failed"));

      await expect(
        withLedgerRangeRpcRetry(fn, fastConfig),
      ).rejects.toThrow("Authentication failed");

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries up to maxRetries and then throws on repeated transient failures", async () => {
      const fn = jest
        .fn<() => Promise<string>>()
        .mockRejectedValue(new Error("timeout"));

      await expect(
        withLedgerRangeRpcRetry(fn, fastConfig),
      ).rejects.toThrow("timeout");

      // 1 original + maxRetries retries
      expect(fn).toHaveBeenCalledTimes(fastConfig.maxRetries + 1);
    });

    it("emits a warn log on every retry attempt with the backoff delay", async () => {
      const fn = jest
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValue("ok");

      await withLedgerRangeRpcRetry(fn, fastConfig, "test_ctx");

      const warnCalls = mockLogger.warn.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" &&
          (call[0] as string).includes("retrying with backoff"),
      );
      expect(warnCalls).toHaveLength(2);
      // Each warn log must include the attempt number and backoff delay
      expect(warnCalls[0][1]).toMatchObject({
        attempt: 1,
        backoffMs: expect.any(Number),
        error: "ECONNREFUSED",
      });
      expect(warnCalls[1][1]).toMatchObject({
        attempt: 2,
        backoffMs: expect.any(Number),
      });
    });

    it("delay increases across successive attempts (non-decreasing)", async () => {
      // Capture the `backoffMs` from every warn log to assert the schedule.
      const delays: number[] = [];
      mockLogger.warn.mockImplementation((_msg: unknown, meta?: unknown) => {
        const m = meta as { backoffMs?: number } | undefined;
        if (m?.backoffMs !== undefined) delays.push(m.backoffMs);
      });

      const fn = jest
        .fn<() => Promise<string>>()
        .mockRejectedValue(new Error("connection timeout"));

      await expect(
        withLedgerRangeRpcRetry(fn, fastConfig),
      ).rejects.toThrow();

      // We should have recorded maxRetries delay values.
      expect(delays.length).toBe(fastConfig.maxRetries);
      for (let i = 1; i < delays.length; i++) {
        expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
      }
    });

    it("caps the delay at maxBackoffMs even after many failures", async () => {
      const capConfig: LedgerRangeRpcRetryConfig = {
        maxRetries: 6,
        initialBackoffMs: 1,
        backoffMultiplier: 2,
        maxBackoffMs: 8, // deliberately low
      };

      const delays: number[] = [];
      mockLogger.warn.mockImplementation((_msg: unknown, meta?: unknown) => {
        const m = meta as { backoffMs?: number } | undefined;
        if (m?.backoffMs !== undefined) delays.push(m.backoffMs);
      });

      const fn = jest
        .fn<() => Promise<string>>()
        .mockRejectedValue(new Error("ETIMEDOUT"));

      await expect(
        withLedgerRangeRpcRetry(fn, capConfig),
      ).rejects.toThrow();

      // All delays at or after the cap must equal maxBackoffMs
      const atCap = delays.filter((d) => d >= capConfig.maxBackoffMs);
      expect(atCap.length).toBeGreaterThan(0);
      atCap.forEach((d) => expect(d).toBe(capConfig.maxBackoffMs));
    });
  });

  // ─── LedgerRangeTracker.processRange integrates retry ────────────────────

  describe("LedgerRangeTracker.processRange – fetchEvents retry integration", () => {
    // Import lazily so the logger mock is in place.
    let LedgerRangeTracker: typeof import("../src/indexer/ledger-range-tracker.js").LedgerRangeTracker;
    let resetLedgerRangeTrackerState: typeof import("../src/indexer/ledger-range-tracker.js").resetLedgerRangeTrackerState;

    beforeAll(async () => {
      const mod = await import("../src/indexer/ledger-range-tracker.js");
      LedgerRangeTracker = mod.LedgerRangeTracker;
      resetLedgerRangeTrackerState = mod.resetLedgerRangeTrackerState;
    });

    beforeEach(() => {
      testDb.exec("DROP TABLE IF EXISTS events");
      testDb.exec("DROP TABLE IF EXISTS indexer_state");
      testDb.exec("DROP TABLE IF EXISTS schema_migrations");
      testDb.exec("DROP TABLE IF EXISTS monitored_contracts");
      testDb.exec("DROP TABLE IF EXISTS webhook_subscriptions");
      runMigrations();
      resetLedgerRangeTrackerState();
      jest.clearAllMocks();
    });

    it("recovers from a single transient RPC timeout in fetchEvents", async () => {
      let calls = 0;
      const tracker = new LedgerRangeTracker({
        name: "retry-single",
        rpcRetryConfig: {
          maxRetries: 3,
          initialBackoffMs: 1,
          backoffMultiplier: 2,
          maxBackoffMs: 4,
        },
      });

      const result = await tracker.processRange({
        startLedger: 10,
        endLedger: 11,
        fetchEvents: async (_page) => {
          calls += 1;
          if (calls === 1) throw new Error("ECONNRESET");
          return [
            {
              contractId: "C1",
              eventType: "initialized",
              ledgerSequence: _page.startLedger,
              timestamp: 1000,
              dataJson: "{}",
            },
          ];
        },
      });

      expect(result.status).toBe("success");
      // fetchEvents was called twice (1 failure + 1 success)
      expect(calls).toBe(2);
      expect(result.failureMonitor ?? tracker.failureMonitor.getConsecutiveFailures()).toBe(0);
    });

    it("exhausts retries and propagates the error after maxRetries transient failures", async () => {
      const tracker = new LedgerRangeTracker({
        name: "retry-exhaust",
        rpcRetryConfig: {
          maxRetries: 2,
          initialBackoffMs: 1,
          backoffMultiplier: 2,
          maxBackoffMs: 4,
        },
      });

      let calls = 0;
      await expect(
        tracker.processRange({
          startLedger: 1,
          endLedger: 2,
          fetchEvents: async () => {
            calls += 1;
            throw new Error("connection timeout");
          },
        }),
      ).rejects.toThrow("connection timeout");

      // 1 original + 2 retries = 3 total calls
      expect(calls).toBe(3);
    });

    it("does not retry non-retryable fetchEvents errors", async () => {
      const tracker = new LedgerRangeTracker({
        name: "retry-no-retry",
        rpcRetryConfig: {
          maxRetries: 3,
          initialBackoffMs: 1,
          backoffMultiplier: 2,
          maxBackoffMs: 4,
        },
      });

      let calls = 0;
      await expect(
        tracker.processRange({
          startLedger: 5,
          endLedger: 6,
          fetchEvents: async () => {
            calls += 1;
            throw new Error("Invalid contract address");
          },
        }),
      ).rejects.toThrow("Invalid contract address");

      // No retry — exactly 1 call
      expect(calls).toBe(1);
    });

    it("emits warn log for each retry attempt during fetchEvents", async () => {
      const tracker = new LedgerRangeTracker({
        name: "retry-logs",
        rpcRetryConfig: {
          maxRetries: 3,
          initialBackoffMs: 1,
          backoffMultiplier: 2,
          maxBackoffMs: 8,
        },
      });

      let attempt = 0;
      await expect(
        tracker.processRange({
          startLedger: 1,
          endLedger: 1,
          fetchEvents: async () => {
            attempt++;
            throw new Error("socket hang up");
          },
        }),
      ).rejects.toThrow();

      const retryCalls = mockLogger.warn.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" &&
          (call[0] as string).includes("retrying with backoff"),
      );
      // 3 retries → 3 warn logs
      expect(retryCalls.length).toBe(3);
    });
  });
});
