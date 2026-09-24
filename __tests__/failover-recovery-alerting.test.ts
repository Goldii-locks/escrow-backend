import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import { setDb, runMigrations, closeDb } from "../src/indexer/db.js";
import {
  FailoverRecoveryFailureMonitor,
  IndexerFailoverRecoveryFailureMonitor,
  DEFAULT_FAILOVER_RECOVERY_FAILURE_THRESHOLD,
  DEFAULT_FAILOVER_FAILURE_THRESHOLD,
  DEFAULT_FAILOVER_RECOVERY_STALL_THRESHOLD_MS,
  DEFAULT_FAILOVER_STALL_THRESHOLD_MS,
  getFailoverRecoveryAlertConfig,
  getFailoverAlertConfig,
  getIndexerFailoverRecoveryAlertConfig,
  getFailoverRecoveryFailureMonitor,
  getIndexerFailoverRecoveryFailureMonitor,
  resetFailoverRecoveryFailureMonitorState,
  resetFailoverRecoveryAlertState,
  resetIndexerFailoverRecoveryFailureState,
  recordFailoverRecoveryFailure,
  recordFailoverRecoverySuccess,
  checkFailoverRecoveryStall,
  startFailoverRecovery,
  resetFailoverRecovery,
  initializeNodeHealthTables,
  createFailoverServer,
  recordNodeHealth,
  failoverToNode,
  recordNodeFailure,
  recordNodeSuccess,
  FailoverRecoverySchemaError,
  type FailoverRecoveryFailureType,
} from "../src/indexer/failover-recovery.js";
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
    String(call[0]).includes("indexer_failover_recovery alert:"),
  );
}

describe("indexer_failover_recovery alerting notifications (#415)", () => {
  const envKeys = [
    "FAILOVER_RECOVERY_FAILURE_THRESHOLD",
    "INDEXER_FAILOVER_RECOVERY_FAILURE_THRESHOLD",
    "FAILOVER_FAILURE_THRESHOLD",
    "FAILOVER_RECOVERY_STALL_THRESHOLD_MS",
    "INDEXER_FAILOVER_RECOVERY_STALL_THRESHOLD_MS",
    "FAILOVER_STALL_THRESHOLD_MS",
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
    resetFailoverRecoveryFailureMonitorState();
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    infoSpy.mockRestore();
    resetFailoverRecoveryFailureMonitorState();
  });

  describe("configuration and environment variables", () => {
    it("uses documented defaults when nothing is configured", () => {
      expect(getFailoverRecoveryAlertConfig()).toEqual({
        failureThreshold: DEFAULT_FAILOVER_RECOVERY_FAILURE_THRESHOLD,
        stallThresholdMs: DEFAULT_FAILOVER_RECOVERY_STALL_THRESHOLD_MS,
      });
      expect(DEFAULT_FAILOVER_RECOVERY_FAILURE_THRESHOLD).toBe(3);
      expect(DEFAULT_FAILOVER_FAILURE_THRESHOLD).toBe(3);
      expect(DEFAULT_FAILOVER_RECOVERY_STALL_THRESHOLD_MS).toBe(120_000);
      expect(DEFAULT_FAILOVER_STALL_THRESHOLD_MS).toBe(120_000);
      expect(getFailoverAlertConfig()).toEqual(getFailoverRecoveryAlertConfig());
      expect(getIndexerFailoverRecoveryAlertConfig()).toEqual(getFailoverRecoveryAlertConfig());
    });

    it("reads thresholds from primary environment variables", () => {
      process.env.FAILOVER_RECOVERY_FAILURE_THRESHOLD = "5";
      process.env.FAILOVER_RECOVERY_STALL_THRESHOLD_MS = "60000";

      expect(getFailoverRecoveryAlertConfig()).toEqual({
        failureThreshold: 5,
        stallThresholdMs: 60_000,
      });
    });

    it("reads thresholds from secondary and fallback environment variable names", () => {
      process.env.INDEXER_FAILOVER_RECOVERY_FAILURE_THRESHOLD = "4";
      process.env.INDEXER_FAILOVER_RECOVERY_STALL_THRESHOLD_MS = "45000";

      expect(getFailoverRecoveryAlertConfig()).toEqual({
        failureThreshold: 4,
        stallThresholdMs: 45_000,
      });

      delete process.env.INDEXER_FAILOVER_RECOVERY_FAILURE_THRESHOLD;
      delete process.env.INDEXER_FAILOVER_RECOVERY_STALL_THRESHOLD_MS;
      process.env.FAILOVER_FAILURE_THRESHOLD = "7";
      process.env.FAILOVER_STALL_THRESHOLD_MS = "30000";

      expect(getFailoverRecoveryAlertConfig()).toEqual({
        failureThreshold: 7,
        stallThresholdMs: 30_000,
      });
    });

    it("falls back to defaults and warns on non-numeric threshold values", () => {
      process.env.FAILOVER_RECOVERY_FAILURE_THRESHOLD = "invalid_threshold";

      expect(getFailoverRecoveryAlertConfig().failureThreshold).toBe(
        DEFAULT_FAILOVER_RECOVERY_FAILURE_THRESHOLD,
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "indexer_failover_recovery ignoring invalid threshold config",
        expect.objectContaining({
          variable: "FAILOVER_RECOVERY_FAILURE_THRESHOLD",
          received: "invalid_threshold",
          fallback: DEFAULT_FAILOVER_RECOVERY_FAILURE_THRESHOLD,
        }),
      );
    });

    it("rejects zero, negative, and fractional threshold values", () => {
      for (const badValue of ["0", "-5", "2.7"]) {
        process.env.FAILOVER_RECOVERY_FAILURE_THRESHOLD = badValue;
        expect(getFailoverRecoveryAlertConfig().failureThreshold).toBe(
          DEFAULT_FAILOVER_RECOVERY_FAILURE_THRESHOLD,
        );
      }
    });

    it("picks up updated environment values when monitor state is reset", () => {
      process.env.FAILOVER_RECOVERY_FAILURE_THRESHOLD = "6";
      resetFailoverRecoveryFailureMonitorState();

      const monitor = getFailoverRecoveryFailureMonitor();
      expect(monitor.getFailureThreshold()).toBe(6);
    });
  });

  describe("consecutive failure alerts", () => {
    it("does not warn below the configured error count", () => {
      const monitor = new FailoverRecoveryFailureMonitor({ failureThreshold: 3 });

      monitor.recordFailure("node_failure", { error: "err-1" });
      expect(alertWarnings(warnSpy)).toHaveLength(0);
      expect(monitor.isAlertActive()).toBe(false);
      expect(monitor.getConsecutiveFailures()).toBe(1);

      monitor.recordFailure("node_failure", { error: "err-2" });
      expect(alertWarnings(warnSpy)).toHaveLength(0);
      expect(monitor.isAlertActive()).toBe(false);
      expect(monitor.getConsecutiveFailures()).toBe(2);
    });

    it("asserts warnings trigger after configured error counts (validation check)", () => {
      const monitor = new FailoverRecoveryFailureMonitor({ failureThreshold: 3 });

      monitor.recordFailure("node_failure", { error: "err-1" });
      monitor.recordFailure("node_failure", { error: "err-2" });
      expect(alertWarnings(warnSpy)).toHaveLength(0);

      // 3rd failure reaches the threshold
      monitor.recordFailure("node_failure", {
        error: "err-3",
        operation: "poll_rpc",
        nodeUrl: "https://rpc1.stellar.org",
      });

      const warnings = alertWarnings(warnSpy);
      expect(warnings).toHaveLength(1);
      expect(monitor.isAlertActive()).toBe(true);
      expect(monitor.getConsecutiveFailures()).toBe(3);

      const [message, payload] = warnings[0];
      expect(message).toBe(
        "indexer_failover_recovery alert: consecutive failure threshold reached",
      );
      expect(payload).toMatchObject({
        component: "indexer_failover_recovery",
        failureType: "node_failure",
        operation: "poll_rpc",
        nodeUrl: "https://rpc1.stellar.org",
        consecutiveFailures: 3,
        threshold: 3,
        error: "err-3",
      });
      expect(payload.action).toMatch(/Inspect/);
    });

    it("triggers immediately on failure count of 1 when threshold is 1", () => {
      const monitor = new FailoverRecoveryFailureMonitor({ failureThreshold: 1 });

      monitor.recordFailure("failover", { error: "failover crashed" });

      expect(alertWarnings(warnSpy)).toHaveLength(1);
      expect(monitor.isAlertActive()).toBe(true);
    });

    it("logs an error on every failure regardless of threshold", () => {
      const monitor = new FailoverRecoveryFailureMonitor({ failureThreshold: 5 });

      monitor.recordFailure("schema", { error: "table missing" });
      monitor.recordFailure("retry", { error: "timeout" });

      expect(errorSpy).toHaveBeenCalledTimes(2);
      expect(errorSpy.mock.calls[0][0]).toBe("indexer_failover_recovery operation failed");
      expect(errorSpy.mock.calls[1][0]).toBe("indexer_failover_recovery operation failed");
      expect(alertWarnings(warnSpy)).toHaveLength(0);
    });

    it("does not emit duplicate threshold alerts while already over the limit", () => {
      const monitor = new FailoverRecoveryFailureMonitor({ failureThreshold: 2 });

      for (let i = 1; i <= 5; i++) {
        monitor.recordFailure("operation", { error: `err-${i}` });
      }

      expect(alertWarnings(warnSpy)).toHaveLength(1);
      expect(monitor.getConsecutiveFailures()).toBe(5);
      expect(monitor.isAlertActive()).toBe(true);
    });

    it("emits alerts on every failure past threshold when repeatAlerts is enabled", () => {
      const monitor = new FailoverRecoveryFailureMonitor({
        failureThreshold: 2,
        repeatAlerts: true,
      });

      for (let i = 1; i <= 4; i++) {
        monitor.recordFailure("operation", { error: `err-${i}` });
      }

      // Reached at 2, repeated at 3 and 4 => 3 warnings
      expect(alertWarnings(warnSpy)).toHaveLength(3);
      expect(monitor.getConsecutiveFailures()).toBe(4);
    });

    it("clears alert and logs recovery message on recordSuccess", () => {
      const monitor = new FailoverRecoveryFailureMonitor({ failureThreshold: 2 });

      monitor.recordFailure("health_record", { error: "bad write" });
      monitor.recordFailure("health_record", { error: "bad write" });
      expect(monitor.isAlertActive()).toBe(true);

      monitor.recordSuccess({ operation: "write_health" });

      expect(monitor.getConsecutiveFailures()).toBe(0);
      expect(monitor.isAlertActive()).toBe(false);
      expect(monitor.getLastSuccessfulAt()).toBeGreaterThan(0);
      expect(infoSpy).toHaveBeenCalledWith(
        "indexer_failover_recovery recovered after consecutive failures",
        expect.objectContaining({
          component: "indexer_failover_recovery",
          operation: "write_health",
        }),
      );
    });

    it("does not log recovery message when no failure had occurred", () => {
      const monitor = new FailoverRecoveryFailureMonitor({ failureThreshold: 3 });

      monitor.recordSuccess();

      expect(infoSpy).not.toHaveBeenCalled();
      expect(monitor.getLastSuccessfulAt()).toBeGreaterThan(0);
    });

    it("requires the full threshold count again after a recovery", () => {
      const monitor = new FailoverRecoveryFailureMonitor({ failureThreshold: 2 });

      monitor.recordFailure("node_failure", { error: "1" });
      monitor.recordFailure("node_failure", { error: "2" });
      expect(alertWarnings(warnSpy)).toHaveLength(1);

      monitor.recordSuccess();
      warnSpy.mockClear();

      monitor.recordFailure("node_failure", { error: "3" });
      expect(alertWarnings(warnSpy)).toHaveLength(0);

      monitor.recordFailure("node_failure", { error: "4" });
      expect(alertWarnings(warnSpy)).toHaveLength(1);
    });

    it("tracks consecutive failures across multiple failure types", () => {
      const monitor = new FailoverRecoveryFailureMonitor({ failureThreshold: 4 });
      const types: FailoverRecoveryFailureType[] = [
        "node_failure",
        "failover",
        "health_record",
        "retry",
      ];

      for (const t of types) {
        monitor.recordFailure(t, { error: `err-${t}` });
      }

      expect(alertWarnings(warnSpy)).toHaveLength(1);
      expect(monitor.getConsecutiveFailures()).toBe(4);
    });

    it("resets all state cleanly on reset()", () => {
      const monitor = new FailoverRecoveryFailureMonitor({ failureThreshold: 2 });
      monitor.recordFailure("node_failure", { error: "1" });
      monitor.recordFailure("node_failure", { error: "2" });
      expect(monitor.isAlertActive()).toBe(true);

      monitor.reset();

      expect(monitor.getConsecutiveFailures()).toBe(0);
      expect(monitor.getLastSuccessfulAt()).toBeNull();
      expect(monitor.isAlertActive()).toBe(false);
    });
  });

  describe("stall alerts", () => {
    it("does not report a stall if no successful operation has occurred yet", () => {
      const monitor = new FailoverRecoveryFailureMonitor({ stallThresholdMs: 1 });

      expect(monitor.checkStall()).toBe(false);
      expect(alertWarnings(warnSpy)).toHaveLength(0);
    });

    it("does not report a stall when within the stall window", () => {
      const monitor = new FailoverRecoveryFailureMonitor({ stallThresholdMs: 60_000 });
      monitor.recordSuccess();

      expect(monitor.checkStall()).toBe(false);
      expect(alertWarnings(warnSpy)).toHaveLength(0);
    });

    it("emits a warning alert once the stall window elapses", async () => {
      const monitor = new FailoverRecoveryFailureMonitor({ stallThresholdMs: 10 });
      monitor.recordSuccess();

      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(monitor.checkStall()).toBe(true);

      const warnings = alertWarnings(warnSpy);
      expect(warnings).toHaveLength(1);
      const [message, payload] = warnings[0];
      expect(message).toBe("indexer_failover_recovery alert: stall threshold reached");
      expect(payload).toMatchObject({
        component: "indexer_failover_recovery",
        failureType: "stall",
        stallThresholdMs: 10,
      });
      expect(payload.elapsedMs).toBeGreaterThanOrEqual(10);
      expect(payload.action).toMatch(/stall window/);
    });

    it("does not re-emit stall warning during the same stall period", async () => {
      const monitor = new FailoverRecoveryFailureMonitor({ stallThresholdMs: 5 });
      monitor.recordSuccess();

      await new Promise((resolve) => setTimeout(resolve, 15));

      expect(monitor.checkStall()).toBe(true);
      expect(monitor.checkStall()).toBe(true);

      expect(alertWarnings(warnSpy)).toHaveLength(1);
    });

    it("stall check does not modify consecutive failure counter", async () => {
      const monitor = new FailoverRecoveryFailureMonitor({ stallThresholdMs: 5 });
      monitor.recordSuccess();
      monitor.recordFailure("node_failure", { error: "failed once" });
      expect(monitor.getConsecutiveFailures()).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 15));
      monitor.checkStall();

      expect(monitor.getConsecutiveFailures()).toBe(1);
    });
  });

  describe("singleton helpers and module aliases", () => {
    it("provides alias IndexerFailoverRecoveryFailureMonitor", () => {
      expect(IndexerFailoverRecoveryFailureMonitor).toBe(FailoverRecoveryFailureMonitor);
    });

    it("provides global singleton access and reset functions", () => {
      const monitor = getFailoverRecoveryFailureMonitor();
      expect(getIndexerFailoverRecoveryFailureMonitor()).toBe(monitor);

      recordFailoverRecoveryFailure("node_failure", { error: "test" });
      expect(monitor.getConsecutiveFailures()).toBe(1);

      recordFailoverRecoverySuccess();
      expect(monitor.getConsecutiveFailures()).toBe(0);

      resetFailoverRecoveryAlertState();
      expect(getFailoverRecoveryFailureMonitor().getLastSuccessfulAt()).toBeNull();

      resetIndexerFailoverRecoveryFailureState();
      expect(getFailoverRecoveryFailureMonitor()).toBeDefined();
    });

    it("allows checkFailoverRecoveryStall via module helper", async () => {
      process.env.FAILOVER_RECOVERY_STALL_THRESHOLD_MS = "5";
      resetFailoverRecoveryFailureMonitorState();

      recordFailoverRecoverySuccess();
      await new Promise((r) => setTimeout(r, 15));

      expect(checkFailoverRecoveryStall()).toBe(true);
      expect(alertWarnings(warnSpy)).toHaveLength(1);
    });
  });

  describe("integration with failover recovery operations", () => {
    let testDb: Database.Database;

    beforeEach(() => {
      testDb = new Database(":memory:");
      setDb(testDb);
      runMigrations();
      initializeNodeHealthTables();
      resetFailoverRecovery();
    });

    afterEach(() => {
      resetFailoverRecovery();
      try {
        closeDb();
      } catch {
        // ignore already closed
      }
    });

    it("records failure when startFailoverRecovery fails schema validation", () => {
      const badDb = new Database(":memory:");
      setDb(badDb);

      expect(() => startFailoverRecovery({ targetDb: badDb })).toThrow(
        FailoverRecoverySchemaError,
      );

      const monitor = getFailoverRecoveryFailureMonitor();
      expect(monitor.getConsecutiveFailures()).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        "indexer_failover_recovery operation failed",
        expect.objectContaining({
          component: "indexer_failover_recovery",
          failureType: "schema",
          operation: "startFailoverRecovery",
        }),
      );
      badDb.close();
    });

    it("records success when startFailoverRecovery validates schema cleanly", () => {
      // Simulate prior failure
      recordFailoverRecoveryFailure("schema", { error: "prior error" });
      expect(getFailoverRecoveryFailureMonitor().getConsecutiveFailures()).toBe(1);

      const report = startFailoverRecovery({ targetDb: testDb });
      expect(report.valid).toBe(true);
      expect(getFailoverRecoveryFailureMonitor().getConsecutiveFailures()).toBe(0);
      expect(getFailoverRecoveryFailureMonitor().getLastSuccessfulAt()).toBeGreaterThan(0);
    });

    it("records failure when createFailoverServer is called with empty nodes", async () => {
      const result = await createFailoverServer([], (url) => url);
      expect(result).toBeNull();

      expect(getFailoverRecoveryFailureMonitor().getConsecutiveFailures()).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        "indexer_failover_recovery operation failed",
        expect.objectContaining({
          failureType: "failover",
          operation: "createFailoverServer",
        }),
      );
    });

    it("records failure in catch block when recordNodeHealth database write throws", async () => {
      testDb.close(); // Force DB error

      const success = await recordNodeHealth({
        nodeUrl: "https://node.example.com",
        isHealthy: true,
        failureCount: 0,
        lastFailureAt: null,
        lastSuccessAt: Date.now(),
        nextRetryAt: null,
        backoffDurationMs: 1000,
        consecutiveSuccesses: 1,
      });

      expect(success).toBe(false);
      expect(getFailoverRecoveryFailureMonitor().getConsecutiveFailures()).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        "indexer_failover_recovery operation failed",
        expect.objectContaining({
          failureType: "health_record",
          operation: "recordNodeHealth",
        }),
      );
    });

    it("records failure in catch block when failoverToNode database write throws", async () => {
      testDb.close(); // Force DB error

      const result = await failoverToNode("https://node.example.com");

      expect(result).toBeNull();
      expect(getFailoverRecoveryFailureMonitor().getConsecutiveFailures()).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        "indexer_failover_recovery operation failed",
        expect.objectContaining({
          failureType: "failover",
          operation: "failoverToNode",
        }),
      );
    });

    it("records failure in catch block when recordNodeFailure database write throws", async () => {
      testDb.close(); // Force DB error

      const result = await recordNodeFailure("https://node.example.com", "network error");

      expect(result).toBeNull();
      expect(getFailoverRecoveryFailureMonitor().getConsecutiveFailures()).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        "indexer_failover_recovery operation failed",
        expect.objectContaining({
          failureType: "node_failure",
          operation: "recordNodeFailure",
        }),
      );
    });

    it("records failure in catch block when recordNodeSuccess database write throws", async () => {
      testDb.close(); // Force DB error

      const result = await recordNodeSuccess("https://node.example.com");

      expect(result).toBeNull();
      expect(getFailoverRecoveryFailureMonitor().getConsecutiveFailures()).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        "indexer_failover_recovery operation failed",
        expect.objectContaining({
          failureType: "health_record",
          operation: "recordNodeSuccess",
        }),
      );
    });
  });
});
