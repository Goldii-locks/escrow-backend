import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import { setDb, runMigrations, closeDb } from "../src/indexer/db.js";
import {
  WriterPoolFailureMonitor,
  DEFAULT_WRITER_POOL_FAILURE_THRESHOLD,
  DEFAULT_WRITER_POOL_STALL_THRESHOLD_MS,
  getWriterPoolAlertConfig,
  getWriterPoolFailureMonitor,
  queueWrite,
  resetWriterPoolFailureState,
  resetWriterPoolStartState,
  type WriteOperation,
} from "../src/indexer/database-writer-pool.js";
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
    String(call[0]).includes("database_writer_pool alert:"),
  );
}

function failingOperation(name = "failing-write"): WriteOperation<void> {
  return {
    name,
    execute: () => {
      throw new Error("intentional writer failure");
    },
  };
}

function succeedingOperation(name = "ok-write"): WriteOperation<{ changes: number }> {
  return {
    name,
    execute: (db) => {
      const result = db.prepare("INSERT INTO wp_alert (value) VALUES (?)").run("ok");
      return { changes: result.changes };
    },
  };
}

describe("database_writer_pool – threshold alerting (#329)", () => {
  const envKeys = [
    "WRITER_POOL_FAILURE_THRESHOLD",
    "WRITER_POOL_STALL_THRESHOLD_MS",
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
    resetWriterPoolFailureState();
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    infoSpy.mockRestore();
    resetWriterPoolFailureState();
  });

  describe("configuration", () => {
    it("uses documented defaults when nothing is configured", () => {
      expect(getWriterPoolAlertConfig()).toEqual({
        failureThreshold: DEFAULT_WRITER_POOL_FAILURE_THRESHOLD,
        stallThresholdMs: DEFAULT_WRITER_POOL_STALL_THRESHOLD_MS,
      });
      expect(DEFAULT_WRITER_POOL_FAILURE_THRESHOLD).toBe(3);
      expect(DEFAULT_WRITER_POOL_STALL_THRESHOLD_MS).toBe(120_000);
    });

    it("reads thresholds from the environment", () => {
      process.env.WRITER_POOL_FAILURE_THRESHOLD = "7";
      process.env.WRITER_POOL_STALL_THRESHOLD_MS = "5000";

      expect(getWriterPoolAlertConfig()).toEqual({
        failureThreshold: 7,
        stallThresholdMs: 5000,
      });
    });

    it("falls back and warns on an invalid threshold instead of throwing", () => {
      process.env.WRITER_POOL_FAILURE_THRESHOLD = "not-a-number";

      expect(getWriterPoolAlertConfig().failureThreshold).toBe(
        DEFAULT_WRITER_POOL_FAILURE_THRESHOLD,
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "database_writer_pool ignoring invalid threshold config",
        expect.objectContaining({
          variable: "WRITER_POOL_FAILURE_THRESHOLD",
          received: "not-a-number",
        }),
      );
    });

    it("rejects zero, negative, and fractional thresholds", () => {
      for (const bad of ["0", "-2", "1.5"]) {
        process.env.WRITER_POOL_FAILURE_THRESHOLD = bad;
        expect(getWriterPoolAlertConfig().failureThreshold).toBe(
          DEFAULT_WRITER_POOL_FAILURE_THRESHOLD,
        );
      }
    });

    it("picks up env thresholds when alert state is reset", () => {
      process.env.WRITER_POOL_FAILURE_THRESHOLD = "4";
      resetWriterPoolFailureState();

      expect(getWriterPoolFailureMonitor().failureThreshold).toBe(4);
    });
  });

  describe("consecutive failure alerts", () => {
    it("warns only once the configured error count is reached", () => {
      const monitor = new WriterPoolFailureMonitor({ failureThreshold: 3 });

      monitor.recordFailure("write", { error: "boom-1" });
      expect(alertWarnings(warnSpy)).toHaveLength(0);

      monitor.recordFailure("write", { error: "boom-2" });
      expect(alertWarnings(warnSpy)).toHaveLength(0);
      expect(monitor.isAlertActive()).toBe(false);

      monitor.recordFailure("write", { error: "boom-3" });
      expect(alertWarnings(warnSpy)).toHaveLength(1);
      expect(monitor.isAlertActive()).toBe(true);
      expect(monitor.getConsecutiveFailures()).toBe(3);
    });

    it("does not emit a threshold warning below the configured count", () => {
      const monitor = new WriterPoolFailureMonitor({ failureThreshold: 5 });

      monitor.recordFailure("write", { error: "one" });
      monitor.recordFailure("write", { error: "two" });
      monitor.recordFailure("write", { error: "three" });
      monitor.recordFailure("write", { error: "four" });

      expect(alertWarnings(warnSpy)).toHaveLength(0);
      expect(monitor.isAlertActive()).toBe(false);
      expect(monitor.getConsecutiveFailures()).toBe(4);
    });

    it("includes the failure count, threshold and cause in the alert", () => {
      const monitor = new WriterPoolFailureMonitor({ failureThreshold: 2 });

      monitor.recordFailure("write", { error: "database is locked" });
      monitor.recordFailure("write", {
        error: "database is locked",
        operation: "insert-event",
        retries: 3,
        queueDepth: 2,
      });

      const [message, meta] = alertWarnings(warnSpy)[0];
      expect(message).toBe(
        "database_writer_pool alert: consecutive failure threshold reached",
      );
      expect(meta).toMatchObject({
        pool: "database_writer_pool",
        failureType: "write",
        operation: "insert-event",
        consecutiveFailures: 2,
        threshold: 2,
        retries: 3,
        queueDepth: 2,
        error: "database is locked",
      });
      expect(String(meta.action)).toMatch(/Inspect/);
      expect(JSON.stringify(meta)).not.toMatch(/password|secret|api[_-]?key/i);
    });

    it("does not emit additional threshold alerts while already over the limit", () => {
      const monitor = new WriterPoolFailureMonitor({ failureThreshold: 2 });

      for (let i = 0; i < 4; i++) {
        monitor.recordFailure("write", { error: `boom-${i}` });
      }

      expect(alertWarnings(warnSpy)).toHaveLength(1);
      expect(monitor.getConsecutiveFailures()).toBe(4);
    });

    it("logs an error for every failure regardless of the threshold", () => {
      const monitor = new WriterPoolFailureMonitor({ failureThreshold: 10 });

      monitor.recordFailure("write", { error: "one" });
      monitor.recordFailure("write", { error: "two" });

      expect(errorSpy).toHaveBeenCalledTimes(2);
      expect((errorSpy.mock.calls as any[][])[0][0]).toBe(
        "database_writer_pool operation failed",
      );
      expect(alertWarnings(warnSpy)).toHaveLength(0);
    });

    it("honours a threshold of 1 by alerting on the first failure", () => {
      const monitor = new WriterPoolFailureMonitor({ failureThreshold: 1 });

      monitor.recordFailure("write", { error: "immediate" });

      expect(alertWarnings(warnSpy)).toHaveLength(1);
    });

    it("resets the counter and clears the alert after a success", () => {
      const monitor = new WriterPoolFailureMonitor({ failureThreshold: 2 });

      monitor.recordFailure("write", { error: "boom" });
      monitor.recordFailure("write", { error: "boom" });
      expect(monitor.isAlertActive()).toBe(true);

      monitor.recordSuccess();

      expect(monitor.getConsecutiveFailures()).toBe(0);
      expect(monitor.isAlertActive()).toBe(false);
      expect(infoSpy).toHaveBeenCalledWith(
        "database_writer_pool recovered after consecutive failures",
        expect.objectContaining({ pool: "database_writer_pool" }),
      );
    });

    it("requires the full count again after a recovery", () => {
      const monitor = new WriterPoolFailureMonitor({ failureThreshold: 3 });

      monitor.recordFailure("write");
      monitor.recordFailure("write");
      monitor.recordSuccess();
      monitor.recordFailure("write");
      monitor.recordFailure("write");

      expect(alertWarnings(warnSpy)).toHaveLength(0);
      expect(monitor.getConsecutiveFailures()).toBe(2);
    });

    it("does not log a recovery message when nothing had failed", () => {
      const monitor = new WriterPoolFailureMonitor({ failureThreshold: 3 });

      monitor.recordSuccess();

      expect(infoSpy).not.toHaveBeenCalled();
    });

    it("clears all state on reset", () => {
      const monitor = new WriterPoolFailureMonitor({ failureThreshold: 1 });
      monitor.recordFailure("write");

      monitor.reset();

      expect(monitor.getConsecutiveFailures()).toBe(0);
      expect(monitor.isAlertActive()).toBe(false);
      expect(monitor.getLastSuccessfulAt()).toBeNull();
    });
  });

  describe("stall alerts", () => {
    it("does not report a stall before any successful write", () => {
      const monitor = new WriterPoolFailureMonitor({ stallThresholdMs: 1 });

      expect(monitor.checkStall()).toBe(false);
      expect(alertWarnings(warnSpy)).toHaveLength(0);
    });

    it("does not report a stall inside the configured window", () => {
      const monitor = new WriterPoolFailureMonitor({
        stallThresholdMs: 60_000,
      });
      monitor.recordSuccess();

      expect(monitor.checkStall()).toBe(false);
      expect(alertWarnings(warnSpy)).toHaveLength(0);
    });

    it("warns once the stall window has elapsed", async () => {
      const monitor = new WriterPoolFailureMonitor({ stallThresholdMs: 5 });
      monitor.recordSuccess();

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(monitor.checkStall()).toBe(true);
      const alerts = alertWarnings(warnSpy);
      expect(alerts).toHaveLength(1);
      expect(alerts[0][0]).toBe(
        "database_writer_pool alert: write stall threshold reached",
      );
      expect(alerts[0][1]).toMatchObject({
        failureType: "stall",
        stallThresholdMs: 5,
      });
      expect(alerts[0][1].elapsedMs).toBeGreaterThanOrEqual(5);
    });

    it("does not re-alert for the same stall condition", async () => {
      const monitor = new WriterPoolFailureMonitor({ stallThresholdMs: 5 });
      monitor.recordSuccess();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(monitor.checkStall()).toBe(true);
      expect(monitor.checkStall()).toBe(true);

      expect(alertWarnings(warnSpy)).toHaveLength(1);
    });

    it("does not touch the failure counter when stalling", async () => {
      const monitor = new WriterPoolFailureMonitor({
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

  describe("queueWrite integration", () => {
    let testDb: Database.Database;

    beforeEach(() => {
      testDb = new Database(":memory:");
      setDb(testDb);
      runMigrations();
      testDb.exec(
        "CREATE TABLE IF NOT EXISTS wp_alert (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)",
      );
      resetWriterPoolStartState();
    });

    afterEach(() => {
      resetWriterPoolStartState();
      closeDb();
    });

    it("records a success and leaves the alert clear on a healthy write", async () => {
      const result = await queueWrite(succeedingOperation());

      expect(result.success).toBe(true);
      expect(getWriterPoolFailureMonitor().getConsecutiveFailures()).toBe(0);
      expect(getWriterPoolFailureMonitor().getLastSuccessfulAt()).not.toBeNull();
      expect(alertWarnings(warnSpy)).toHaveLength(0);
    });

    it("warns after the configured number of consecutive write failures", async () => {
      process.env.WRITER_POOL_FAILURE_THRESHOLD = "3";
      resetWriterPoolFailureState();

      for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await queueWrite(failingOperation(`fail-${attempt}`));
        expect(result.success).toBe(false);
        expect(getWriterPoolFailureMonitor().getConsecutiveFailures()).toBe(attempt);
        expect(alertWarnings(warnSpy)).toHaveLength(attempt < 3 ? 0 : 1);
      }

      expect(getWriterPoolFailureMonitor().isAlertActive()).toBe(true);
    });

    it("does not alert when consecutive failures stay below the threshold", async () => {
      process.env.WRITER_POOL_FAILURE_THRESHOLD = "3";
      resetWriterPoolFailureState();

      const first = await queueWrite(failingOperation("fail-1"));
      const second = await queueWrite(failingOperation("fail-2"));

      expect(first.success).toBe(false);
      expect(second.success).toBe(false);
      expect(getWriterPoolFailureMonitor().getConsecutiveFailures()).toBe(2);
      expect(alertWarnings(warnSpy)).toHaveLength(0);
      expect(getWriterPoolFailureMonitor().isAlertActive()).toBe(false);
    });

    it("respects a custom failure threshold from the environment", async () => {
      process.env.WRITER_POOL_FAILURE_THRESHOLD = "2";
      resetWriterPoolFailureState();

      expect((await queueWrite(failingOperation("fail-1"))).success).toBe(false);
      expect(alertWarnings(warnSpy)).toHaveLength(0);

      expect((await queueWrite(failingOperation("fail-2"))).success).toBe(false);
      expect(alertWarnings(warnSpy)).toHaveLength(1);
    });

    it("clears the alert once a write succeeds again", async () => {
      process.env.WRITER_POOL_FAILURE_THRESHOLD = "1";
      resetWriterPoolFailureState();

      expect((await queueWrite(failingOperation())).success).toBe(false);
      expect(getWriterPoolFailureMonitor().isAlertActive()).toBe(true);

      expect((await queueWrite(succeedingOperation())).success).toBe(true);

      expect(getWriterPoolFailureMonitor().isAlertActive()).toBe(false);
      expect(getWriterPoolFailureMonitor().getConsecutiveFailures()).toBe(0);
      expect(infoSpy).toHaveBeenCalledWith(
        "database_writer_pool recovered after consecutive failures",
        expect.objectContaining({ pool: "database_writer_pool" }),
      );
    });

    it("requires the full consecutive count again after recovery", async () => {
      process.env.WRITER_POOL_FAILURE_THRESHOLD = "2";
      resetWriterPoolFailureState();

      await queueWrite(failingOperation("fail-a"));
      await queueWrite(failingOperation("fail-b"));
      expect(alertWarnings(warnSpy)).toHaveLength(1);

      await queueWrite(succeedingOperation());
      warnSpy.mockClear();

      await queueWrite(failingOperation("fail-c"));
      expect(alertWarnings(warnSpy)).toHaveLength(0);
      expect(getWriterPoolFailureMonitor().getConsecutiveFailures()).toBe(1);

      await queueWrite(failingOperation("fail-d"));
      expect(alertWarnings(warnSpy)).toHaveLength(1);
    });

    it("does not alert again for additional failures while already over the limit", async () => {
      process.env.WRITER_POOL_FAILURE_THRESHOLD = "2";
      resetWriterPoolFailureState();

      await queueWrite(failingOperation("fail-1"));
      await queueWrite(failingOperation("fail-2"));
      await queueWrite(failingOperation("fail-3"));
      await queueWrite(failingOperation("fail-4"));

      expect(alertWarnings(warnSpy)).toHaveLength(1);
      expect(getWriterPoolFailureMonitor().getConsecutiveFailures()).toBe(4);
    });

    it("reports a stall when a later write arrives after the quiet window", async () => {
      process.env.WRITER_POOL_STALL_THRESHOLD_MS = "5";
      resetWriterPoolFailureState();

      expect((await queueWrite(succeedingOperation("first"))).success).toBe(true);
      expect(alertWarnings(warnSpy)).toHaveLength(0);

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect((await queueWrite(succeedingOperation("second"))).success).toBe(true);

      const stallAlerts = alertWarnings(warnSpy).filter((call) =>
        String(call[0]).includes("write stall threshold reached"),
      );
      expect(stallAlerts).toHaveLength(1);
      expect(stallAlerts[0][1]).toMatchObject({
        failureType: "stall",
        stallThresholdMs: 5,
      });
    });

    it("omits SQL parameters and secrets from failure alerts", async () => {
      process.env.WRITER_POOL_FAILURE_THRESHOLD = "1";
      resetWriterPoolFailureState();

      const secretOp: WriteOperation<void> = {
        name: "update-credentials",
        execute: () => {
          throw new Error("constraint failed");
        },
      };

      await queueWrite(secretOp);

      const alerts = alertWarnings(warnSpy);
      expect(alerts).toHaveLength(1);
      const serialized = JSON.stringify(alerts[0][1]);
      expect(serialized).not.toContain("password");
      expect(serialized).not.toContain("secret");
      expect(serialized).not.toMatch(/VALUES\s*\(/i);
    });
  });
});
