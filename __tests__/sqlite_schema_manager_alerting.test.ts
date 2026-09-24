import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import logger from "../src/utils/logger.js";
import {
  SqliteSchemaManagerFailureMonitor,
  getSqliteSchemaManagerFailureMonitor,
  resetSqliteSchemaManagerFailureState,
} from "../src/indexer/sqlite_schema_manager.js";
import { setDb, runMigrations, closeDb } from "../src/indexer/db.js";

describe("sqlite_schema_manager alerting notifications (#262)", () => {
  beforeEach(() => {
    resetSqliteSchemaManagerFailureState();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    closeDb();
  });

  it("does not warn below the configured error count", () => {
    const warn = jest.spyOn(logger, "warn");
    const monitor = new SqliteSchemaManagerFailureMonitor({
      name: "unit",
      failureThreshold: 3,
    });
    monitor.recordFailure("migration", { error: "one", version: 1 });
    monitor.recordFailure("migration", { error: "two", version: 2 });

    expect(
      warn.mock.calls.filter(([msg]) =>
        String(msg).includes("consecutive failure threshold reached"),
      ),
    ).toHaveLength(0);
    expect(monitor.getConsecutiveFailures()).toBe(2);
  });

  it("emits a warning exactly when the threshold is reached", () => {
    const warn = jest.spyOn(logger, "warn");
    const monitor = new SqliteSchemaManagerFailureMonitor({
      name: "unit",
      failureThreshold: 3,
    });
    monitor.recordFailure("migration", { error: "one" });
    monitor.recordFailure("migration", { error: "two" });
    monitor.recordFailure("migration", { error: "three", version: 9 });

    const alerts = warn.mock.calls.filter(([msg]) =>
      String(msg).includes(
        "sqlite_schema_manager alert: consecutive failure threshold reached",
      ),
    );
    expect(alerts).toHaveLength(1);
    expect((alerts[0] as unknown as [string, Record<string, unknown>])[1]).toMatchObject({
      manager: "unit",
      consecutiveFailures: 3,
      threshold: 3,
      error: "three",
      version: 9,
    });
    expect(monitor.isAlertActive()).toBe(true);
  });

  it("does not re-alert while already over the threshold", () => {
    const warn = jest.spyOn(logger, "warn");
    const monitor = new SqliteSchemaManagerFailureMonitor({
      failureThreshold: 2,
    });
    monitor.recordFailure("bootstrap", { error: "a" });
    monitor.recordFailure("bootstrap", { error: "b" });
    monitor.recordFailure("bootstrap", { error: "c" });

    expect(
      warn.mock.calls.filter(([msg]) =>
        String(msg).includes("consecutive failure threshold reached"),
      ),
    ).toHaveLength(1);
    expect(monitor.getConsecutiveFailures()).toBe(3);
  });

  it("resets consecutive failures after success", () => {
    const monitor = new SqliteSchemaManagerFailureMonitor({
      failureThreshold: 3,
    });
    monitor.recordFailure("migration", { error: "x" });
    expect(monitor.getConsecutiveFailures()).toBe(1);
    monitor.recordSuccess();
    expect(monitor.getConsecutiveFailures()).toBe(0);
    expect(monitor.isAlertActive()).toBe(false);
    expect(monitor.getLastSuccessfulAt()).toBeTruthy();
  });

  it("emits a stall warning after the configured quiet period", async () => {
    const original = process.env.SQLITE_SCHEMA_MANAGER_STALL_THRESHOLD_MS;
    process.env.SQLITE_SCHEMA_MANAGER_STALL_THRESHOLD_MS = "1";

    const warn = jest.spyOn(logger, "warn");
    const monitor = new SqliteSchemaManagerFailureMonitor({
      name: "stall-unit",
      stallThresholdMs: 1,
    });
    monitor.recordSuccess();
    await new Promise((r) => setTimeout(r, 5));
    warn.mockClear();

    expect(monitor.checkStall()).toBe(true);
    const stallCalls = warn.mock.calls.filter(([msg]) =>
      String(msg).includes(
        "sqlite_schema_manager alert: stall threshold reached",
      ),
    );
    expect(stallCalls.length).toBeGreaterThanOrEqual(1);
    const stallMeta = (stallCalls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(stallMeta).toMatchObject({
      manager: "stall-unit",
      failureType: "stall",
    });
    expect(stallMeta).toHaveProperty("elapsedMs");

    process.env.SQLITE_SCHEMA_MANAGER_STALL_THRESHOLD_MS = original;
  });

  it("triggers threshold warning after configured runMigrations failures", () => {
    const warn = jest.spyOn(logger, "warn");
    const monitor = getSqliteSchemaManagerFailureMonitor();
    monitor.reset();

    // Keep SQLITE_SCHEMA_MANAGER_STALL_THRESHOLD_MS high so stall alerts don't
    // interfere with consecutive-failure assertions.
    const originalStall = process.env.SQLITE_SCHEMA_MANAGER_STALL_THRESHOLD_MS;
    process.env.SQLITE_SCHEMA_MANAGER_STALL_THRESHOLD_MS = "600000";

    const db = new Database(":memory:");
    setDb(db);
    runMigrations();
    expect(monitor.getConsecutiveFailures()).toBe(0);

    db.close();
    expect(() => runMigrations()).toThrow();
    expect(() => runMigrations()).toThrow();
    expect(() => runMigrations()).toThrow();

    const alertCalls = warn.mock.calls.filter(([msg]) =>
      String(msg).includes(
        "sqlite_schema_manager alert: consecutive failure threshold reached",
      ),
    );
    expect(alertCalls.length).toBeGreaterThanOrEqual(1);
    expect(monitor.getConsecutiveFailures()).toBeGreaterThanOrEqual(3);

    process.env.SQLITE_SCHEMA_MANAGER_STALL_THRESHOLD_MS = originalStall;
  });
});
