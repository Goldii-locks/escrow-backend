import { jest } from "@jest/globals";
import {
  collectRpcHealthMetrics,
  getIndexerMetricsMonitor,
  resetIndexerMetricsCollectorState,
} from "../src/indexer/indexer_metrics_collector.js";
import type { RpcServerLike } from "../src/indexer/rpc-poller-client.js";
import logger from "../src/utils/logger.js";

/** Winston's logger methods are overloaded, so spies are handled untyped. */
function spyOnLogger(method: "debug" | "warn" | "error"): any {
  return jest
    .spyOn(logger, method)
    .mockImplementation((() => logger) as never);
}

function stubServer(getLatestLedger: RpcServerLike["getLatestLedger"]): RpcServerLike {
  return {
    getLatestLedger,
    getEvents: async () => ({ events: [] }),
  };
}

describe("indexer_metrics_collector – RPC health check backoff retry (#334)", () => {
  let warnSpy: any;
  let debugSpy: any;
  let errorSpy: any;

  beforeEach(() => {
    warnSpy = spyOnLogger("warn");
    debugSpy = spyOnLogger("debug");
    errorSpy = spyOnLogger("error");
    resetIndexerMetricsCollectorState();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    debugSpy.mockRestore();
    errorSpy.mockRestore();
    resetIndexerMetricsCollectorState();
  });

  it("returns the latest ledger without retrying on first success", async () => {
    let calls = 0;
    const server = stubServer(async () => {
      calls++;
      return { sequence: 42 };
    });

    const metrics = await collectRpcHealthMetrics(server, { initialBackoffMs: 10 });

    expect(calls).toBe(1);
    expect(metrics.latestLedgerSequence).toBe(42);
    expect(metrics.collectedAt).toBeDefined();
  });

  it("retries transient RPC timeouts with increasing backoff up to maxRetries", async () => {
    let calls = 0;
    const server = stubServer(async () => {
      calls++;
      if (calls <= 2) throw new Error("ETIMEDOUT");
      return { sequence: 99 };
    });

    const metrics = await collectRpcHealthMetrics(server, {
      maxRetries: 3,
      initialBackoffMs: 10,
      backoffMultiplier: 2,
    });

    expect(calls).toBe(3);
    expect(metrics.latestLedgerSequence).toBe(99);

    const retryWarnings = (warnSpy.mock.calls as any[][]).filter((call) =>
      String(call[0]).includes("rpc_health_check failed, retrying"),
    );
    expect(retryWarnings).toHaveLength(2);
    // Backoff doubles on each successive attempt.
    expect(retryWarnings[0][1].backoffMs).toBe(10);
    expect(retryWarnings[1][1].backoffMs).toBe(20);

    expect(getIndexerMetricsMonitor().getConsecutiveFailures()).toBe(0);
  });

  it("stops retrying non-retryable errors immediately", async () => {
    let calls = 0;
    const server = stubServer(async () => {
      calls++;
      throw new Error("invalid request");
    });

    await expect(
      collectRpcHealthMetrics(server, { maxRetries: 5, initialBackoffMs: 10 }),
    ).rejects.toThrow("invalid request");

    expect(calls).toBe(1);
    expect(getIndexerMetricsMonitor().getConsecutiveFailures()).toBe(1);
  });

  it("records an rpc_timeout failure on the shared monitor once retries are exhausted", async () => {
    const server = stubServer(async () => {
      throw new Error("connect timeout");
    });

    await expect(
      collectRpcHealthMetrics(server, { maxRetries: 2, initialBackoffMs: 10 }),
    ).rejects.toThrow("connect timeout");

    const monitor = getIndexerMetricsMonitor();
    expect(monitor.getConsecutiveFailures()).toBe(1);

    const failureLogs = (errorSpy.mock.calls as any[][]).filter(
      (call) => call[1]?.failureType === "rpc_timeout",
    );
    expect(failureLogs).toHaveLength(1);
    expect(failureLogs[0][1].operation).toBe("rpc_health_check");
  });
});
