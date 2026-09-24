import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import { setDb, runMigrations, closeDb, insertEvent } from "../src/indexer/db.js";
import {
  collectIndexerMetrics,
  logIndexerMetricsDiagnostics,
  metricsPayloadSizeBytes,
  resetIndexerMetricsCollectorState,
} from "../src/indexer/indexer_metrics_collector.js";
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

describe("indexer_metrics_collector – polling diagnostics (#337)", () => {
  let debugSpy: any;

  beforeEach(() => {
    debugSpy = spyOnLogger("debug");
    resetIndexerMetricsCollectorState();
  });

  afterEach(() => {
    debugSpy.mockRestore();
    resetIndexerMetricsCollectorState();
  });

  describe("logIndexerMetricsDiagnostics", () => {
    it("logs a debug string containing elapsed time and payload size", () => {
      logIndexerMetricsDiagnostics({
        collector: "indexer_metrics_collector",
        operation: "collect_metrics",
        status: "success",
        elapsedMs: 12.345,
        payloadSizeBytes: 2048,
      });

      expect(debugSpy).toHaveBeenCalledTimes(1);
      const [message, meta] = (debugSpy.mock.calls as DebugCall[])[0];

      expect(message).toEqual(expect.stringContaining("elapsedMs=12.345"));
      expect(message).toEqual(expect.stringContaining("payloadSizeBytes=2048"));
      expect(message).toEqual(
        expect.stringContaining("indexer_metrics_collector poll diagnostics"),
      );
      expect(message).toEqual(expect.stringContaining("operation=collect_metrics"));
      expect(message).toEqual(expect.stringContaining("status=success"));
      expect(meta).toMatchObject({
        collector: "indexer_metrics_collector",
        operation: "collect_metrics",
        status: "success",
        elapsedMs: 12.345,
        payloadSizeBytes: 2048,
      });
    });

    it("includes the row count when one is supplied", () => {
      logIndexerMetricsDiagnostics({
        collector: "indexer_metrics_collector",
        operation: "query_events_by_type",
        status: "success",
        elapsedMs: 1,
        rowCount: 4,
      });

      const [message] = (debugSpy.mock.calls as DebugCall[])[0];
      expect(message).toEqual(expect.stringContaining("rowCount=4"));
    });

    it("still carries elapsed time when payload size is unknown", () => {
      logIndexerMetricsDiagnostics({
        collector: "indexer_metrics_collector",
        operation: "collect_metrics",
        status: "started",
        elapsedMs: 0,
      });

      const [message] = (debugSpy.mock.calls as DebugCall[])[0];
      expect(message).toEqual(expect.stringContaining("elapsedMs=0"));
      expect(message).not.toEqual(expect.stringContaining("payloadSizeBytes="));
    });

    it("carries the error text on a failure diagnostic", () => {
      logIndexerMetricsDiagnostics({
        collector: "indexer_metrics_collector",
        operation: "collect_metrics",
        status: "failure",
        elapsedMs: 3,
        error: "no such table: events",
      });

      const [message, meta] = (debugSpy.mock.calls as DebugCall[])[0];
      expect(message).toEqual(expect.stringContaining("status=failure"));
      expect(meta.error).toBe("no such table: events");
    });
  });

  describe("metricsPayloadSizeBytes", () => {
    it("measures the JSON byte size of a payload", () => {
      expect(metricsPayloadSizeBytes({ a: 1 })).toBe(
        Buffer.byteLength(JSON.stringify({ a: 1 }), "utf8"),
      );
      expect(metricsPayloadSizeBytes([])).toBe(2);
      expect(metricsPayloadSizeBytes(null)).toBe(4);
      expect(metricsPayloadSizeBytes(undefined)).toBe(4);
    });
  });

  describe("collectIndexerMetrics diagnostics", () => {
    let testDb: Database.Database;

    beforeEach(() => {
      testDb = new Database(":memory:");
      setDb(testDb);
      runMigrations();
    });

    afterEach(() => {
      closeDb();
    });

    it("emits a start and a success diagnostic for the collection", () => {
      collectIndexerMetrics(testDb);

      const boundary = callFor(debugSpy, "collect_metrics");
      expect(boundary).toHaveLength(2);
      expect(boundary[0][1].status).toBe("started");
      expect(boundary[1][1].status).toBe("success");
    });

    it("reports elapsed time and payload size for the whole collection", () => {
      insertEvent("contract-1", "funded", 10, 1_700_000_000, "{}");
      insertEvent("contract-1", "approved", 11, 1_700_000_100, "{}");

      const metrics = collectIndexerMetrics(testDb);

      const [message, meta] = callFor(debugSpy, "collect_metrics")[1];
      expect(message).toEqual(expect.stringContaining("elapsedMs="));
      expect(message).toEqual(expect.stringContaining("payloadSizeBytes="));
      expect(Number(readTag(message, "elapsedMs"))).toBeGreaterThanOrEqual(0);
      expect(meta.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(meta.payloadSizeBytes).toBe(metricsPayloadSizeBytes(metrics));
      expect(meta.totalEvents).toBe(2);
      expect(meta.lastIndexedLedger).toBe(metrics.lastIndexedLedger);
    });

    it("emits a per-query diagnostic carrying elapsed time for every stage", () => {
      collectIndexerMetrics(testDb);

      const stages = [
        "query_last_ledger",
        "query_total_events",
        "query_last_event_at",
        "query_events_by_type",
        "query_active_contracts",
        "query_subscriptions",
      ];

      for (const stage of stages) {
        const calls = callFor(debugSpy, stage);
        expect(calls).toHaveLength(1);
        const [message, meta] = calls[0];
        expect(message).toEqual(expect.stringContaining("elapsedMs="));
        expect(message).toEqual(expect.stringContaining(`operation=${stage}`));
        expect(Number(readTag(message, "elapsedMs"))).toBeGreaterThanOrEqual(0);
        expect(meta.elapsedMs).toBeGreaterThanOrEqual(0);
        expect(meta.payloadSizeBytes).toBeGreaterThan(0);
      }
    });

    it("reports the row count for multi-row query stages", () => {
      insertEvent("contract-1", "funded", 10, 1_700_000_000, "{}");
      insertEvent("contract-1", "approved", 11, 1_700_000_100, "{}");

      collectIndexerMetrics(testDb);

      const [message, meta] = callFor(debugSpy, "query_events_by_type")[0];
      expect(meta.rowCount).toBe(2);
      expect(message).toEqual(expect.stringContaining("rowCount=2"));
    });

    it("every diagnostic message carries a numeric elapsedMs", () => {
      collectIndexerMetrics(testDb);

      const calls = debugCalls(debugSpy);
      expect(calls.length).toBeGreaterThanOrEqual(8);
      for (const [message, meta] of calls) {
        const tag = readTag(message, "elapsedMs");
        expect(tag).toBeDefined();
        expect(Number.isNaN(Number(tag))).toBe(false);
        expect(meta.elapsedMs).toBeGreaterThanOrEqual(0);
        expect(meta.collector).toBe("indexer_metrics_collector");
      }
    });

    it("marks a missing optional table as a skipped stage", () => {
      testDb.exec("DROP TABLE webhook_subscriptions");

      collectIndexerMetrics(testDb);

      const [message, meta] = callFor(debugSpy, "query_subscriptions")[0];
      expect(meta.status).toBe("skipped");
      expect(message).toEqual(expect.stringContaining("status=skipped"));
      expect(message).toEqual(expect.stringContaining("elapsedMs="));
    });

    it("emits a failure diagnostic with elapsed time when a query fails", () => {
      testDb.exec("DROP TABLE indexer_state");

      expect(() => collectIndexerMetrics(testDb)).toThrow();

      const stage = callFor(debugSpy, "query_last_ledger")[0];
      expect(stage[1].status).toBe("failure");
      expect(stage[0]).toEqual(expect.stringContaining("elapsedMs="));
      expect(stage[1].error).toEqual(expect.stringContaining("indexer_state"));

      const boundary = callFor(debugSpy, "collect_metrics");
      const failure = boundary[boundary.length - 1];
      expect(failure[1].status).toBe("failure");
      expect(failure[0]).toEqual(expect.stringContaining("elapsedMs="));
      expect(failure[1].elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it("keeps diagnostics at debug level so normal runs stay quiet", () => {
      const infoSpy = spyOnLogger("info");
      const warnSpy = spyOnLogger("warn");

      collectIndexerMetrics(testDb);

      expect(debugCalls(debugSpy).length).toBeGreaterThan(0);
      expect(infoSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();

      infoSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it("scales the reported payload size with the collected data", () => {
      collectIndexerMetrics(testDb);
      const empty = callFor(debugSpy, "collect_metrics")[1][1].payloadSizeBytes;

      debugSpy.mockClear();
      for (let i = 0; i < 5; i++) {
        insertEvent(`contract-${i}`, `type_${i}`, 100 + i, 1_700_000_000 + i, "{}");
      }
      collectIndexerMetrics(testDb);
      const filled = callFor(debugSpy, "collect_metrics")[1][1].payloadSizeBytes;

      expect(filled).toBeGreaterThan(empty);
    });
  });
});
