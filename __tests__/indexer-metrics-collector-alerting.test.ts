import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import { setDb, runMigrations, closeDb, insertEvent } from "../src/indexer/db.js";
import {
  IndexerMetricsFailureMonitor,
  DEFAULT_METRICS_FAILURE_THRESHOLD,
  DEFAULT_METRICS_STALL_THRESHOLD_MS,
  collectIndexerMetrics,
  getIndexerMetricsAlertConfig,
  getIndexerMetricsMonitor,
  resetIndexerMetricsCollectorState,
} from "../src/indexer/indexer_metrics_collector.js";
import logger from "../src/utils/logger.js";

/** Winston's logger methods are overloaded, so spies are handled untyped. */
function spyOnLogger(method: "debug" | "info" | "warn" | "error"): any {
  return jest
    .spyOn(logger, method)
    .mockImplementation((() => logger) as never);
}

/** Warning calls that are threshold alerts, not config warnings. */
function alertWarnings(spy: any): any[][] {
  return (spy.mock.calls as any[][]).filter((call) =>
    String(call[0]).includes("indexer_metrics_collector alert:"),
  );
}

describe("indexer_metrics_collector – threshold alerting (#338)", () => {
  const envKeys = [
    "INDEXER_METRICS_FAILURE_THRESHOLD",
    "INDEXER_METRICS_STALL_THRESHOLD_MS",
  ];
  const savedEnv: Record<string, string | undefined> = {};

  let warnSpy: any;
  let errorSpy: any;
  let infoSpy: any;

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    warnSpy = spyOnLogger("warn");
    errorSpy = spyOnLogger("error");
    infoSpy = spyOnLogger("info");
    resetIndexerMetricsCollectorState();
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    infoSpy.mockRestore();
    resetIndexerMetricsCollectorState();
  });

  describe("configuration", () => {
    it("uses documented defaults when nothing is configured", () => {
      expect(getIndexerMetricsAlertConfig()).toEqual({
        failureThreshold: DEFAULT_METRICS_FAILURE_THRESHOLD,
        stallThresholdMs: DEFAULT_METRICS_STALL_THRESHOLD_MS,
      });
      expect(DEFAULT_METRICS_FAILURE_THRESHOLD).toBe(3);
      expect(DEFAULT_METRICS_STALL_THRESHOLD_MS).toBe(120_000);
    });

    it("reads thresholds from the environment", () => {
      process.env.INDEXER_METRICS_FAILURE_THRESHOLD = "7";
      process.env.INDEXER_METRICS_STALL_THRESHOLD_MS = "5000";

      expect(getIndexerMetricsAlertConfig()).toEqual({
        failureThreshold: 7,
        stallThresholdMs: 5000,
      });
    });

    it("falls back and warns on an invalid threshold instead of throwing", () => {
      process.env.INDEXER_METRICS_FAILURE_THRESHOLD = "not-a-number";

      expect(getIndexerMetricsAlertConfig().failureThreshold).toBe(
        DEFAULT_METRICS_FAILURE_THRESHOLD,
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "indexer_metrics_collector ignoring invalid threshold config",
        expect.objectContaining({
          variable: "INDEXER_METRICS_FAILURE_THRESHOLD",
          received: "not-a-number",
        }),
      );
    });

    it("rejects zero, negative, and fractional thresholds", () => {
      for (const bad of ["0", "-2", "1.5"]) {
        process.env.INDEXER_METRICS_FAILURE_THRESHOLD = bad;
        expect(getIndexerMetricsAlertConfig().failureThreshold).toBe(
          DEFAULT_METRICS_FAILURE_THRESHOLD,
        );
      }
    });

    it("picks up env thresholds when collector state is reset", () => {
      process.env.INDEXER_METRICS_FAILURE_THRESHOLD = "4";
      resetIndexerMetricsCollectorState();

      expect(getIndexerMetricsMonitor().failureThreshold).toBe(4);
    });
  });

  describe("consecutive failure alerts", () => {
    it("warns only once the configured error count is reached", () => {
      const monitor = new IndexerMetricsFailureMonitor({ failureThreshold: 3 });

      monitor.recordFailure("collection", { error: "boom-1" });
      expect(alertWarnings(warnSpy)).toHaveLength(0);

      monitor.recordFailure("collection", { error: "boom-2" });
      expect(alertWarnings(warnSpy)).toHaveLength(0);
      expect(monitor.isAlertActive()).toBe(false);

      monitor.recordFailure("collection", { error: "boom-3" });
      expect(alertWarnings(warnSpy)).toHaveLength(1);
      expect(monitor.isAlertActive()).toBe(true);
      expect(monitor.getConsecutiveFailures()).toBe(3);
    });

    it("includes the failure count, threshold and cause in the alert", () => {
      const monitor = new IndexerMetricsFailureMonitor({ failureThreshold: 2 });

      monitor.recordFailure("collection", { error: "db is locked" });
      monitor.recordFailure("collection", {
        error: "db is locked",
        operation: "collect_metrics",
      });

      const [message, meta] = alertWarnings(warnSpy)[0];
      expect(message).toBe(
        "indexer_metrics_collector alert: consecutive failure threshold reached",
      );
      expect(meta).toMatchObject({
        collector: "indexer_metrics_collector",
        failureType: "collection",
        operation: "collect_metrics",
        consecutiveFailures: 2,
        threshold: 2,
        error: "db is locked",
      });
    });

    it("keeps alerting while failures continue past the threshold", () => {
      const monitor = new IndexerMetricsFailureMonitor({ failureThreshold: 2 });

      for (let i = 0; i < 4; i++) {
        monitor.recordFailure("query", { error: `boom-${i}` });
      }

      // Failures 2, 3 and 4 are all at or above the threshold.
      expect(alertWarnings(warnSpy)).toHaveLength(3);
      expect(monitor.getConsecutiveFailures()).toBe(4);
    });

    it("logs an error for every failure regardless of the threshold", () => {
      const monitor = new IndexerMetricsFailureMonitor({ failureThreshold: 10 });

      monitor.recordFailure("collection", { error: "one" });
      monitor.recordFailure("collection", { error: "two" });

      expect(errorSpy).toHaveBeenCalledTimes(2);
      expect((errorSpy.mock.calls as any[][])[0][0]).toBe(
        "indexer_metrics_collector operation failed",
      );
      expect(alertWarnings(warnSpy)).toHaveLength(0);
    });

    it("honours a threshold of 1 by alerting on the first failure", () => {
      const monitor = new IndexerMetricsFailureMonitor({ failureThreshold: 1 });

      monitor.recordFailure("collection", { error: "immediate" });

      expect(alertWarnings(warnSpy)).toHaveLength(1);
    });

    it("resets the counter and clears the alert after a success", () => {
      const monitor = new IndexerMetricsFailureMonitor({ failureThreshold: 2 });

      monitor.recordFailure("collection", { error: "boom" });
      monitor.recordFailure("collection", { error: "boom" });
      expect(monitor.isAlertActive()).toBe(true);

      monitor.recordSuccess();

      expect(monitor.getConsecutiveFailures()).toBe(0);
      expect(monitor.isAlertActive()).toBe(false);
      expect(infoSpy).toHaveBeenCalledWith(
        "indexer_metrics_collector recovered after failures",
        expect.objectContaining({ collector: "indexer_metrics_collector" }),
      );
    });

    it("requires the full count again after a recovery", () => {
      const monitor = new IndexerMetricsFailureMonitor({ failureThreshold: 3 });

      monitor.recordFailure("collection");
      monitor.recordFailure("collection");
      monitor.recordSuccess();
      monitor.recordFailure("collection");
      monitor.recordFailure("collection");

      expect(alertWarnings(warnSpy)).toHaveLength(0);
      expect(monitor.getConsecutiveFailures()).toBe(2);
    });

    it("does not log a recovery message when nothing had failed", () => {
      const monitor = new IndexerMetricsFailureMonitor({ failureThreshold: 3 });

      monitor.recordSuccess();

      expect(infoSpy).not.toHaveBeenCalled();
    });

    it("clears all state on reset", () => {
      const monitor = new IndexerMetricsFailureMonitor({ failureThreshold: 1 });
      monitor.recordFailure("collection");

      monitor.reset();

      expect(monitor.getConsecutiveFailures()).toBe(0);
      expect(monitor.isAlertActive()).toBe(false);
      expect(monitor.getLastSuccessfulAt()).toBeNull();
    });
  });

  describe("stall alerts", () => {
    it("does not report a stall before any successful collection", () => {
      const monitor = new IndexerMetricsFailureMonitor({ stallThresholdMs: 1 });

      expect(monitor.checkStall()).toBe(false);
      expect(alertWarnings(warnSpy)).toHaveLength(0);
    });

    it("does not report a stall inside the configured window", () => {
      const monitor = new IndexerMetricsFailureMonitor({
        stallThresholdMs: 60_000,
      });
      monitor.recordSuccess();

      expect(monitor.checkStall()).toBe(false);
      expect(alertWarnings(warnSpy)).toHaveLength(0);
    });

    it("warns once the stall window has elapsed", async () => {
      const monitor = new IndexerMetricsFailureMonitor({ stallThresholdMs: 5 });
      monitor.recordSuccess();

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(monitor.checkStall()).toBe(true);
      const alerts = alertWarnings(warnSpy);
      expect(alerts).toHaveLength(1);
      expect(alerts[0][0]).toBe(
        "indexer_metrics_collector alert: collection stall threshold reached",
      );
      expect(alerts[0][1]).toMatchObject({
        failureType: "stall",
        stallThresholdMs: 5,
      });
      expect(alerts[0][1].elapsedMs).toBeGreaterThanOrEqual(5);
    });

    it("does not touch the failure counter when stalling", async () => {
      const monitor = new IndexerMetricsFailureMonitor({
        failureThreshold: 3,
        stallThresholdMs: 5,
      });
      monitor.recordSuccess();
      await new Promise((resolve) => setTimeout(resolve, 20));

      monitor.checkStall();

      expect(monitor.getConsecutiveFailures()).toBe(0);
      expect(monitor.isAlertActive()).toBe(false);
    });
  });

  describe("collectIndexerMetrics integration", () => {
    let testDb: Database.Database;

    beforeEach(() => {
      testDb = new Database(":memory:");
      setDb(testDb);
      runMigrations();
    });

    afterEach(() => {
      closeDb();
    });

    it("records a success and leaves the alert clear on a healthy collection", () => {
      insertEvent("contract-1", "funded", 10, 1_700_000_000, "{}");

      const metrics = collectIndexerMetrics(testDb);

      expect(metrics.totalEvents).toBe(1);
      expect(getIndexerMetricsMonitor().getConsecutiveFailures()).toBe(0);
      expect(getIndexerMetricsMonitor().getLastSuccessfulAt()).not.toBeNull();
      expect(alertWarnings(warnSpy)).toHaveLength(0);
    });

    it("warns after the configured number of consecutive collection failures", () => {
      process.env.INDEXER_METRICS_FAILURE_THRESHOLD = "3";
      resetIndexerMetricsCollectorState();

      // Drop the table the very first query depends on.
      testDb.exec("DROP TABLE indexer_state");

      for (let attempt = 1; attempt <= 3; attempt++) {
        expect(() => collectIndexerMetrics(testDb)).toThrow();
        expect(getIndexerMetricsMonitor().getConsecutiveFailures()).toBe(attempt);
        expect(alertWarnings(warnSpy)).toHaveLength(attempt < 3 ? 0 : 1);
      }

      expect(getIndexerMetricsMonitor().isAlertActive()).toBe(true);
      expect(errorSpy).toHaveBeenCalledTimes(3);
    });

    it("respects a custom failure threshold from the environment", () => {
      process.env.INDEXER_METRICS_FAILURE_THRESHOLD = "2";
      resetIndexerMetricsCollectorState();
      testDb.exec("DROP TABLE indexer_state");

      expect(() => collectIndexerMetrics(testDb)).toThrow();
      expect(alertWarnings(warnSpy)).toHaveLength(0);

      expect(() => collectIndexerMetrics(testDb)).toThrow();
      expect(alertWarnings(warnSpy)).toHaveLength(1);
    });

    it("clears the alert once a collection succeeds again", () => {
      process.env.INDEXER_METRICS_FAILURE_THRESHOLD = "1";
      resetIndexerMetricsCollectorState();

      const broken = new Database(":memory:");
      expect(() => collectIndexerMetrics(broken)).toThrow();
      broken.close();
      expect(getIndexerMetricsMonitor().isAlertActive()).toBe(true);

      collectIndexerMetrics(testDb);

      expect(getIndexerMetricsMonitor().isAlertActive()).toBe(false);
      expect(getIndexerMetricsMonitor().getConsecutiveFailures()).toBe(0);
    });

    it("still collects when optional tables are missing", () => {
      testDb.exec("DROP TABLE monitored_contracts");
      testDb.exec("DROP TABLE webhook_subscriptions");

      const metrics = collectIndexerMetrics(testDb);

      expect(metrics.activeContractsCount).toBe(0);
      expect(metrics.totalSubscriptions).toBe(0);
      expect(getIndexerMetricsMonitor().getConsecutiveFailures()).toBe(0);
      expect(alertWarnings(warnSpy)).toHaveLength(0);
    });
  });
});
