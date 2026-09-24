import Database from "better-sqlite3";
import {
  setDb,
  runMigrations,
  closeDb,
  insertEvent,
  setLastIndexedLedger,
} from "../src/indexer/db.js";
import {
  collectHistoricalMetrics,
  validateHistoricalRange,
  resetIndexerMetricsCollectorState,
  getIndexerMetricsMonitor,
} from "../src/indexer/indexer_metrics_collector.js";
import logger from "../src/utils/logger.js";
import { jest } from "@jest/globals";

type DebugCall = [string, any];

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

describe("indexer_metrics_collector – dynamic historical sync ranges (#339)", () => {
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
    testDb.exec("DELETE FROM events");
    testDb.exec(
      "UPDATE indexer_state SET value = '0' WHERE key = 'last_ledger_sequence'",
    );
    setLastIndexedLedger(0);
    resetIndexerMetricsCollectorState();
  });

  // -------------------------------------------------------------------------
  // validateHistoricalRange
  // -------------------------------------------------------------------------

  describe("validateHistoricalRange", () => {
    it("accepts a normal range", () => {
      expect(validateHistoricalRange(1, 100)).toEqual({ ok: true });
    });

    it("accepts equal start and end (single-ledger range)", () => {
      expect(validateHistoricalRange(50, 50)).toEqual({ ok: true });
    });

    it("rejects zero as startLedger", () => {
      const result = validateHistoricalRange(0, 10);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/startLedger must be a positive integer/i);
    });

    it("rejects negative startLedger", () => {
      const result = validateHistoricalRange(-1, 10);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/startLedger/i);
    });

    it("rejects non-integer startLedger", () => {
      const result = validateHistoricalRange(1.5, 10);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/positive integer/i);
    });

    it("rejects NaN startLedger", () => {
      const result = validateHistoricalRange(NaN, 10);
      expect(result.ok).toBe(false);
    });

    it("rejects startLedger > endLedger", () => {
      const result = validateHistoricalRange(100, 50);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/must be ≤/i);
    });

    it("rejects non-integer endLedger", () => {
      const result = validateHistoricalRange(1, 10.5);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/endLedger/i);
    });

    it("rejects zero as endLedger", () => {
      const result = validateHistoricalRange(1, 0);
      expect(result.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // collectHistoricalMetrics
  // -------------------------------------------------------------------------

  describe("collectHistoricalMetrics", () => {
    it("throws for an invalid ledger range", () => {
      expect(() =>
        collectHistoricalMetrics({ startLedger: 0, endLedger: 100 }, testDb),
      ).toThrow(/startLedger must be a positive integer/i);
    });

    it("returns empty metrics when no events fall within the range", () => {
      insertEvent("contract-1", "funded", 200, 1700000000, "{}");

      const result = collectHistoricalMetrics(
        { startLedger: 1, endLedger: 100 },
        testDb,
      );

      expect(result.totalEvents).toBe(0);
      expect(result.ledgerEventCounts).toHaveLength(0);
      expect(result.processedLedgerCount).toBe(0);
      expect(result.eventsByType).toEqual({});
    });

    it("returns correct per-ledger (block) event counts for indexed events", () => {
      // Simulate 3 events at ledger 100, 2 at ledger 101, 1 at ledger 102
      insertEvent("c1-a", "funded", 100, 1700000000, "{}");
      insertEvent("c1-b", "funded", 100, 1700000001, "{}");
      insertEvent("c1-c", "funded", 100, 1700000002, "{}");
      insertEvent("c2-a", "approved", 101, 1700000100, "{}");
      insertEvent("c2-b", "approved", 101, 1700000101, "{}");
      insertEvent("c3-a", "completed", 102, 1700000200, "{}");

      const result = collectHistoricalMetrics(
        { startLedger: 100, endLedger: 102 },
        testDb,
      );

      expect(result.range.startLedger).toBe(100);
      expect(result.range.endLedger).toBe(102);
      expect(result.totalEvents).toBe(6);
      expect(result.processedLedgerCount).toBe(3);

      expect(result.ledgerEventCounts).toEqual([
        { ledgerSequence: 100, eventCount: 3 },
        { ledgerSequence: 101, eventCount: 2 },
        { ledgerSequence: 102, eventCount: 1 },
      ]);
    });

    it("asserts correct block event counts are indexed (validation check)", () => {
      // Import 5 ledgers worth of events: 10 per ledger = 50 total
      for (let ledger = 1000; ledger <= 1004; ledger++) {
        for (let i = 0; i < 10; i++) {
          insertEvent(`c-${ledger}-${i}`, "imported", ledger, 1700000000 + ledger, "{}");
        }
      }

      const result = collectHistoricalMetrics(
        { startLedger: 1000, endLedger: 1004 },
        testDb,
      );

      expect(result.totalEvents).toBe(50);
      expect(result.processedLedgerCount).toBe(5);
      expect(result.ledgerEventCounts).toHaveLength(5);

      // Each ledger should have exactly 10 events
      for (const count of result.ledgerEventCounts) {
        expect(count.eventCount).toBe(10);
      }
      // Ledgers should be in ascending order
      const ledgers = result.ledgerEventCounts.map((c) => c.ledgerSequence);
      expect(ledgers).toEqual([1000, 1001, 1002, 1003, 1004]);
    });

    it("filters out events outside the requested range", () => {
      insertEvent("c1", "funded", 50, 1700000000, "{}");
      insertEvent("c2", "funded", 100, 1700000100, "{}");
      insertEvent("c3", "funded", 150, 1700000200, "{}");
      insertEvent("c4", "funded", 200, 1700000300, "{}");

      const result = collectHistoricalMetrics(
        { startLedger: 100, endLedger: 150 },
        testDb,
      );

      expect(result.totalEvents).toBe(2);
      expect(result.ledgerEventCounts).toHaveLength(2);
      expect(result.ledgerEventCounts.map((c) => c.ledgerSequence)).toEqual([
        100, 150,
      ]);
    });

    it("aggregates events by type within the range", () => {
      insertEvent("c1", "funded", 100, 1700000000, "{}");
      insertEvent("c2", "funded", 101, 1700000100, "{}");
      insertEvent("c3", "approved", 102, 1700000200, "{}");
      insertEvent("c4", "approved", 102, 1700000300, "{}");

      const result = collectHistoricalMetrics(
        { startLedger: 100, endLedger: 102 },
        testDb,
      );

      expect(result.eventsByType).toEqual({
        funded: 2,
        approved: 2,
      });
    });

    it("includes the global lastIndexedLedger (not range-limited)", () => {
      insertEvent("c1", "funded", 100, 1700000000, "{}");
      setLastIndexedLedger(5000);

      const result = collectHistoricalMetrics(
        { startLedger: 100, endLedger: 100 },
        testDb,
      );

      expect(result.lastIndexedLedger).toBe(5000);
    });

    it("returns collectedAt as a valid ISO date string", () => {
      insertEvent("c1", "funded", 100, 1700000000, "{}");

      const result = collectHistoricalMetrics(
        { startLedger: 100, endLedger: 100 },
        testDb,
      );

      expect(new Date(result.collectedAt).toString()).not.toBe("Invalid Date");
    });

    it("handles a single-ledger range correctly", () => {
      insertEvent("c1", "funded", 100, 1700000000, "{}");
      insertEvent("c2", "approved", 100, 1700000100, "{}");
      insertEvent("c3", "funded", 101, 1700000200, "{}");

      const result = collectHistoricalMetrics(
        { startLedger: 100, endLedger: 100 },
        testDb,
      );

      expect(result.totalEvents).toBe(2);
      expect(result.ledgerEventCounts).toHaveLength(1);
      expect(result.ledgerEventCounts[0]).toEqual({
        ledgerSequence: 100,
        eventCount: 2,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Diagnostics integration
  // -------------------------------------------------------------------------

  describe("collectHistoricalMetrics diagnostics", () => {
    let debugSpy: any;

    beforeEach(() => {
      debugSpy = spyOnLogger("debug");
    });

    afterEach(() => {
      debugSpy.mockRestore();
    });

    it("emits a start and success diagnostic for the collection", () => {
      insertEvent("c1", "funded", 100, 1700000000, "{}");
      insertEvent("c2", "approved", 101, 1700000100, "{}");

      collectHistoricalMetrics(
        { startLedger: 100, endLedger: 101 },
        testDb,
      );

      const boundary = callFor(debugSpy, "collect_historical_metrics");
      expect(boundary).toHaveLength(2);
      expect(boundary[0][1].status).toBe("started");
      expect(boundary[1][1].status).toBe("success");
    });

    it("includes startLedger and endLedger in diagnostics", () => {
      collectHistoricalMetrics(
        { startLedger: 1000, endLedger: 2000 },
        testDb,
      );

      const success = callFor(debugSpy, "collect_historical_metrics")[1];
      expect(success[1].startLedger).toBe(1000);
      expect(success[1].endLedger).toBe(2000);
    });

    it("emits a per-query diagnostic for each stage of the collection", () => {
      insertEvent("c1", "funded", 100, 1700000000, "{}");

      collectHistoricalMetrics(
        { startLedger: 100, endLedger: 100 },
        testDb,
      );

      const stages = [
        "query_historical_last_ledger",
        "query_historical_total_events",
        "query_historical_events_by_type",
        "query_historical_ledger_event_counts",
      ];

      for (const stage of stages) {
        const calls = callFor(debugSpy, stage);
        expect(calls).toHaveLength(1);
        const [message, meta] = calls[0];
        expect(message).toEqual(expect.stringContaining("elapsedMs="));
        expect(message).toEqual(expect.stringContaining(`operation=${stage}`));
        expect(meta.elapsedMs).toBeGreaterThanOrEqual(0);
        expect(meta.payloadSizeBytes).toBeGreaterThan(0);
      }
    });

    it("records a success on the monitor and clears any prior failures", () => {
      insertEvent("c1", "funded", 100, 1700000000, "{}");

      collectHistoricalMetrics(
        { startLedger: 100, endLedger: 100 },
        testDb,
      );

      expect(getIndexerMetricsMonitor().getConsecutiveFailures()).toBe(0);
    });
  });
});
