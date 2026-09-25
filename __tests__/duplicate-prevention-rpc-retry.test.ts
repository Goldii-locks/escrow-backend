/**
 * Task 2 — RPC Retry Backoff for duplicate_prevention
 *
 * Confirms that:
 * - `computeDuplicatePreventionBackoffMs` produces the correct exponential
 *   delay schedule and caps at maxBackoffMs.
 * - `isDuplicatePreventionRpcRetryable` correctly classifies transient vs.
 *   permanent errors.
 * - `withDuplicatePreventionRpcRetry` retries only retryable errors, the
 *   delay between attempts is non-decreasing, and the loop stops exactly at
 *   maxRetries.
 * - Retry warn logs include the attempt number and backoff delay on every
 *   retry, confirming the increasing-frequency requirement.
 */

import { jest } from "@jest/globals";

const mockLogger = {
  info: jest.fn<(...args: unknown[]) => void>(),
  warn: jest.fn<(...args: unknown[]) => void>(),
  error: jest.fn<(...args: unknown[]) => void>(),
  debug: jest.fn<(...args: unknown[]) => void>(),
};

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: mockLogger,
}));

const {
  computeDuplicatePreventionBackoffMs,
  isDuplicatePreventionRpcRetryable,
  withDuplicatePreventionRpcRetry,
  DEFAULT_DUPLICATE_PREVENTION_RPC_RETRY_CONFIG,
} = await import("../src/indexer/duplicate-prevention.js");

// ─── Type alias to keep test code readable ───────────────────────────────────

type RetryConfig = typeof DEFAULT_DUPLICATE_PREVENTION_RPC_RETRY_CONFIG;

describe("DuplicatePrevention — RPC retry backoff (#Task2)", () => {
  beforeEach(() => jest.clearAllMocks());

  // ─── computeDuplicatePreventionBackoffMs ──────────────────────────────────

  describe("computeDuplicatePreventionBackoffMs – delay schedule", () => {
    const cfg: Pick<
      RetryConfig,
      "initialBackoffMs" | "backoffMultiplier" | "maxBackoffMs"
    > = {
      initialBackoffMs: 100,
      backoffMultiplier: 2,
      maxBackoffMs: 1_600,
    };

    it("returns initialBackoffMs on attempt 0", () => {
      expect(computeDuplicatePreventionBackoffMs(0, cfg)).toBe(100);
    });

    it("doubles the delay on each attempt", () => {
      expect(computeDuplicatePreventionBackoffMs(1, cfg)).toBe(200);
      expect(computeDuplicatePreventionBackoffMs(2, cfg)).toBe(400);
      expect(computeDuplicatePreventionBackoffMs(3, cfg)).toBe(800);
      expect(computeDuplicatePreventionBackoffMs(4, cfg)).toBe(1_600);
    });

    it("caps the delay at maxBackoffMs", () => {
      expect(computeDuplicatePreventionBackoffMs(5, cfg)).toBe(1_600);
      expect(computeDuplicatePreventionBackoffMs(20, cfg)).toBe(1_600);
    });

    it("produces a strictly non-decreasing sequence", () => {
      const delays = Array.from({ length: 10 }, (_, i) =>
        computeDuplicatePreventionBackoffMs(i, cfg),
      );
      for (let i = 1; i < delays.length; i++) {
        expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
      }
    });

    it("uses the exported DEFAULT_DUPLICATE_PREVENTION_RPC_RETRY_CONFIG defaults", () => {
      const d = DEFAULT_DUPLICATE_PREVENTION_RPC_RETRY_CONFIG;
      expect(computeDuplicatePreventionBackoffMs(0, d)).toBe(d.initialBackoffMs);
      const last = computeDuplicatePreventionBackoffMs(d.maxRetries, d);
      expect(last).toBeLessThanOrEqual(d.maxBackoffMs);
    });
  });

  // ─── isDuplicatePreventionRpcRetryable ────────────────────────────────────

  describe("isDuplicatePreventionRpcRetryable – error classification", () => {
    const retryable = [
      "Connection timeout",
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "socket hang up",
      "network error occurred",
      "status 429",
      "status 503",
      "status 502",
      "request timeout",
      "connect timeout",
      "connection reset by peer",
      "connection refused",
      "connection dropped",
    ];

    const nonRetryable = [
      "SQLITE_CONSTRAINT: UNIQUE constraint failed",
      "Invalid ledger sequence",
      "Authorization error",
      "Not found",
      "Unexpected JSON token",
    ];

    it.each(retryable)("classifies '%s' as retryable", (msg) => {
      expect(isDuplicatePreventionRpcRetryable(new Error(msg))).toBe(true);
    });

    it.each(nonRetryable)("classifies '%s' as non-retryable", (msg) => {
      expect(isDuplicatePreventionRpcRetryable(new Error(msg))).toBe(false);
    });

    it("returns false for non-Error types", () => {
      expect(isDuplicatePreventionRpcRetryable("timeout")).toBe(false);
      expect(isDuplicatePreventionRpcRetryable(null)).toBe(false);
      expect(isDuplicatePreventionRpcRetryable(408)).toBe(false);
    });
  });

  // ─── withDuplicatePreventionRpcRetry – retry loop ────────────────────────

  describe("withDuplicatePreventionRpcRetry – retry behaviour", () => {
    // Use tiny delays so tests finish instantly.
    const fastCfg: RetryConfig = {
      maxRetries: 4,
      initialBackoffMs: 1,
      backoffMultiplier: 2,
      maxBackoffMs: 8,
    };

    it("returns the result immediately on first success", async () => {
      const fn = jest.fn<() => Promise<number>>().mockResolvedValue(42);
      const result = await withDuplicatePreventionRpcRetry(fn, fastCfg);
      expect(result).toBe(42);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries on transient errors and returns on the first success", async () => {
      const fn = jest
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValue("success");

      const result = await withDuplicatePreventionRpcRetry(fn, fastCfg);
      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry on a non-retryable error", async () => {
      const fn = jest
        .fn<() => Promise<string>>()
        .mockRejectedValue(new Error("SQLITE_CONSTRAINT"));

      await expect(
        withDuplicatePreventionRpcRetry(fn, fastCfg),
      ).rejects.toThrow("SQLITE_CONSTRAINT");

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("exhausts maxRetries and re-throws on repeated transient errors", async () => {
      const fn = jest
        .fn<() => Promise<string>>()
        .mockRejectedValue(new Error("timeout"));

      await expect(
        withDuplicatePreventionRpcRetry(fn, fastCfg),
      ).rejects.toThrow("timeout");

      // 1 original attempt + maxRetries retries
      expect(fn).toHaveBeenCalledTimes(fastCfg.maxRetries + 1);
    });

    it("emits a warn log on every retry attempt", async () => {
      const fn = jest
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValue("done");

      await withDuplicatePreventionRpcRetry(fn, fastCfg, "dp_test_ctx");

      const warnCalls = mockLogger.warn.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" &&
          (call[0] as string).includes("retrying with backoff"),
      );
      expect(warnCalls).toHaveLength(2);
    });

    it("retry warn logs carry attempt number, maxRetries, backoffMs, and error", async () => {
      const fn = jest
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error("socket hang up"))
        .mockResolvedValue("ok");

      await withDuplicatePreventionRpcRetry(fn, fastCfg, "dp_ctx");

      const [_msg, meta] = mockLogger.warn.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(meta).toMatchObject({
        attempt: 1,
        maxRetries: fastCfg.maxRetries,
        backoffMs: expect.any(Number),
        error: "socket hang up",
      });
    });

    it("backoff delays are non-decreasing across all retry attempts", async () => {
      const delays: number[] = [];
      mockLogger.warn.mockImplementation((_msg: unknown, meta?: unknown) => {
        const m = meta as { backoffMs?: number } | undefined;
        if (m?.backoffMs !== undefined) delays.push(m.backoffMs);
      });

      const fn = jest
        .fn<() => Promise<string>>()
        .mockRejectedValue(new Error("request timeout"));

      await expect(
        withDuplicatePreventionRpcRetry(fn, fastCfg),
      ).rejects.toThrow();

      expect(delays.length).toBe(fastCfg.maxRetries);
      for (let i = 1; i < delays.length; i++) {
        expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
      }
    });

    it("delays never exceed maxBackoffMs", async () => {
      const capCfg: RetryConfig = {
        maxRetries: 6,
        initialBackoffMs: 1,
        backoffMultiplier: 2,
        maxBackoffMs: 4,
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
        withDuplicatePreventionRpcRetry(fn, capCfg),
      ).rejects.toThrow();

      expect(delays.length).toBe(capCfg.maxRetries);
      delays.forEach((d) => expect(d).toBeLessThanOrEqual(capCfg.maxBackoffMs));
    });

    it("succeeds after the last retry without logging further after success", async () => {
      const fn = jest
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error("connection reset"))
        .mockRejectedValueOnce(new Error("connection reset"))
        .mockRejectedValueOnce(new Error("connection reset"))
        .mockResolvedValue("finally");

      const result = await withDuplicatePreventionRpcRetry(fn, fastCfg);
      expect(result).toBe("finally");
      // 3 retries → 3 warn logs, no error after that
      const warnCalls = mockLogger.warn.mock.calls.filter(
        (c) =>
          typeof c[0] === "string" &&
          (c[0] as string).includes("retrying with backoff"),
      );
      expect(warnCalls).toHaveLength(3);
    });
  });
});
