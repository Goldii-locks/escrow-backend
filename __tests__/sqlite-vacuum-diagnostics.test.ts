import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import { setDb, runMigrations, closeDb, insertEvent } from "../src/indexer/db.js";
import {
  pruneOldEvents,
  runVacuum,
  runVacuumCleanup,
  pruneEventsInLedgerRange,
  logVacuumPollDiagnostics,
  type VacuumPollDiagnostics,
} from "../src/indexer/sqlite_vacuum_cleaner.js";
import logger from "../src/utils/logger.js";

type DebugCall = [string, any];

/** Winston's logger methods are overloaded, so spies are handled untyped. */
function spyOnLogger(method: "debug" | "info" | "warn" | "error"): any {
  return jest
    .spyOn(logger, method)
    .mockImplementation((() => logger) as never);
}

function debugCalls(spy: any): DebugCall[] {
  return (spy.mock.calls as DebugCall[]).filter((call) =>
    String(call[0]).includes("poll diagnostics"),
  );
}

function callFor(spy: any, operation: string): DebugCall[] {
  return debugCalls(spy).filter((call) => call[1]?.operation === operation);
}

/** Pull a `key=value` token out of a diagnostic message string. */
function readTag(message: string, key: string): string | undefined {
  const match = new RegExp(`${key}=([^\\s]+)`).exec(message);
  return match ? match[1] : undefined;
}

describe("sqlite_vacuum_cleaner – polling diagnostics (#346)", () => {
  let debugSpy: any;

  beforeEach(() => {
    debugSpy = spyOnLogger("debug");
  });

  afterEach(() => {
    debugSpy.mockRestore();
  });

  describe("logVacuumPollDiagnostics", () => {
    it("logs a debug string containing elapsed time", () => {
      logVacuumPollDiagnostics({
        component: "sqlite_vacuum_cleaner",
        operation: "run_vacuum",
        status: "success",
        elapsedMs: 12.345,
      });

      expect(debugSpy).toHaveBeenCalledTimes(1);
      const [message, meta] = (debugSpy.mock.calls as DebugCall[])[0];

      expect(message).toEqual(expect.stringContaining("elapsedMs=12.345"));
      expect(message).toEqual(
        expect.stringContaining("sqlite_vacuum_cleaner poll diagnostics"),
      );
      expect(message).toEqual(expect.stringContaining("operation=run_vacuum"));
      expect(message).toEqual(expect.stringContaining("status=success"));
      expect(meta).toMatchObject({
        component: "sqlite_vacuum_cleaner",
        operation: "run_vacuum",
        status: "success",
        elapsedMs: 12.345,
      });
    });

    it("includes the pruned row count when one is supplied", () => {
      logVacuumPollDiagnostics({
        component: "sqlite_vacuum_cleaner",
        operation: "prune_old_events",
        status: "success",
        elapsedMs: 1,
        prunedEvents: 42,
        retentionDays: 90,
      });

      const [message, meta] = (debugSpy.mock.calls as DebugCall[])[0];
      expect(message).toEqual(expect.stringContaining("prunedEvents=42"));
      expect(message).toEqual(expect.stringContaining("retentionDays=90"));
      expect(meta.prunedEvents).toBe(42);
    });

    it("carries the error text on a failure diagnostic", () => {
      logVacuumPollDiagnostics({
        component: "sqlite_vacuum_cleaner",
        operation: "prune_old_events",
        status: "failure",
        elapsedMs: 3,
        error: "cannot VACUUM from within a transaction",
      });

      const [message, meta] = (debugSpy.mock.calls as DebugCall[])[0];
      expect(message).toEqual(expect.stringContaining("status=failure"));
      expect(meta.error).toBe("cannot VACUUM from within a transaction");
    });
  });

  describe("cleanup cycle diagnostics", () => {
    let testDb: Database.Database;
    let beforeInsert: () => void;

    beforeEach(() => {
      testDb = new Database(":memory:");
      setDb(testDb);
      runMigrations();
      beforeInsert = () => {
        insertEvent("contract-1", "funded", 1, 1_600_000_000, "{}");
        insertEvent("contract-1", "funded", 2, 1_700_000_000, "{}");
      };
      // Seed one old row (well past the retention window) and one fresh row.
      testDb
        .prepare(
          `INSERT INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json, created_at)
           VALUES (?, ?, ?, ?, ?, datetime('now', '-999 days'))`,
        )
        .run("old-contract", "initialized", 1, 1_000_000_000, "{}");
    });

    afterEach(() => {
      closeDb();
    });

    it("emits a started and a success diagnostic for prune_old_events", () => {
      pruneOldEvents(testDb, 90);

      const calls = callFor(debugSpy, "prune_old_events");
      expect(calls).toHaveLength(1);
      const [message, meta] = calls[0];
      expect(meta.status).toBe("success");
      expect(message).toEqual(expect.stringContaining("elapsedMs="));
      expect(meta.prunedEvents).toBe(1);
      expect(meta.retentionDays).toBe(90);
    });

    it("emits a success diagnostic for run_vacuum", () => {
      runVacuum(testDb);

      const [message, meta] = callFor(debugSpy, "run_vacuum")[0];
      expect(meta.status).toBe("success");
      expect(message).toEqual(expect.stringContaining("elapsedMs="));
      expect(Number(readTag(message, "elapsedMs"))).toBeGreaterThanOrEqual(0);
    });

    it("emits a success diagnostic for prune_ledger_range", () => {
      beforeInsert();
      pruneEventsInLedgerRange(testDb, { startLedger: 1, endLedger: 1 });

      const [message, meta] = callFor(debugSpy, "prune_ledger_range")[0];
      expect(meta.status).toBe("success");
      expect(message).toEqual(expect.stringContaining("elapsedMs="));
      expect(message).toEqual(expect.stringContaining("startLedger=1"));
      expect(message).toEqual(expect.stringContaining("endLedger=1"));
      expect(meta.prunedEvents).toBe(2);
    });

    it("runVacuumCleanup emits the per-stage diagnostics plus a boundary", () => {
      beforeInsert();
      const result = runVacuumCleanup(testDb, { retentionDays: 90 });

      expect(result.prunedEvents).toBe(1);
      expect(result.vacuumed).toBe(true);

      expect(callFor(debugSpy, "prune_old_events")).toHaveLength(1);
      expect(callFor(debugSpy, "run_vacuum")).toHaveLength(1);

      const boundary = callFor(debugSpy, "vacuum_cleanup");
      expect(boundary).toHaveLength(2);
      expect(boundary[0][1].status).toBe("started");
      expect(boundary[1][1].status).toBe("success");
      expect(boundary[1][0]).toEqual(expect.stringContaining("elapsedMs="));
      expect(boundary[1][1].prunedEvents).toBe(1);
      expect(Number(readTag(boundary[1][0], "elapsedMs"))).toBeGreaterThanOrEqual(0);
    });

    it("skips run_vacuum and emits failure diagnostics when pruning fails", () => {
      testDb.exec("DROP TABLE events");

      expect(() => runVacuumCleanup(testDb, { retentionDays: 90 })).toThrow();

      const stage = callFor(debugSpy, "prune_old_events")[0];
      expect(stage[1].status).toBe("failure");
      expect(stage[0]).toEqual(expect.stringContaining("elapsedMs="));
      expect(stage[1].error).toEqual(expect.stringContaining("events"));

      expect(callFor(debugSpy, "run_vacuum")).toHaveLength(0);

      const boundary = callFor(debugSpy, "vacuum_cleanup");
      const failure = boundary[boundary.length - 1];
      expect(failure[1].status).toBe("failure");
      expect(failure[0]).toEqual(expect.stringContaining("elapsedMs="));
      expect(failure[1].retentionDays).toBe(90);
    });

    it("every diagnostic message carries a numeric elapsedMs", () => {
      beforeInsert();
      runVacuumCleanup(testDb, { retentionDays: 90 });

      const calls = debugCalls(debugSpy);
      expect(calls.length).toBeGreaterThanOrEqual(4);
      for (const [message, meta] of calls) {
        const tag = readTag(message, "elapsedMs");
        expect(tag).toBeDefined();
        expect(Number.isNaN(Number(tag))).toBe(false);
        expect((meta as VacuumPollDiagnostics).elapsedMs).toBeGreaterThanOrEqual(0);
        expect(meta.component).toBe("sqlite_vacuum_cleaner");
      }
    });

    it("keeps diagnostics at debug level so normal runs stay quiet", () => {
      const warnSpy = spyOnLogger("warn");
      const errorSpy = spyOnLogger("error");

      beforeInsert();
      runVacuumCleanup(testDb, { retentionDays: 90 });

      expect(debugCalls(debugSpy).length).toBeGreaterThan(0);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });
});