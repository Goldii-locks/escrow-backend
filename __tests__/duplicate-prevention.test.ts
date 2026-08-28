import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import { setDb, runMigrations, insertEvent, getLastIndexedLedger } from "../src/indexer/db.js";

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
  initializeSyncRangesTable,
  isLedgerSynced,
  getSyncedRanges,
  findUnsyncedRanges,
  insertEventsWithDedup,
  insertEventsWithDedupAsync,
  ingestRpcEventNotifications,
  countEventsInRange,
  deleteEventsInRange,
  resetDuplicatePreventionLocksForTests,
  setEventLockHookForTests,
  setBeforeSyncRangeWriteHookForTests,
} = await import("../src/indexer/duplicate-prevention.js");

describe("DuplicatePrevention – dynamic historical sync ranges", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
  });

  afterAll(() => {
    testDb.close();
  });

  beforeEach(() => {
    setDb(testDb);
    resetDuplicatePreventionLocksForTests();
    jest.clearAllMocks();
    testDb.exec("DROP TABLE IF EXISTS events");
    testDb.exec("DROP TABLE IF EXISTS indexer_state");
    testDb.exec("DROP TABLE IF EXISTS monitored_contracts");
    testDb.exec("DROP TABLE IF EXISTS schema_migrations");
    testDb.exec("DROP TABLE IF EXISTS webhook_subscriptions");
    testDb.exec("DROP TABLE IF EXISTS sync_ranges");
    runMigrations();
  });

  describe("initializeSyncRangesTable", () => {
    it("creates sync_ranges table", () => {
      initializeSyncRangesTable();
      const row = testDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_ranges'",
        )
        .get();
      expect(row).toBeTruthy();
    });

    it("is idempotent", () => {
      initializeSyncRangesTable();
      expect(() => initializeSyncRangesTable()).not.toThrow();
    });
  });

  describe("isLedgerSynced", () => {
    it("returns false when no ranges are synced", () => {
      initializeSyncRangesTable();
      expect(isLedgerSynced(500)).toBe(false);
    });

    it("returns true for a ledger within a synced range", () => {
      initializeSyncRangesTable();
      insertEventsWithDedup([], { startLedger: 100, endLedger: 200 });
      expect(isLedgerSynced(150)).toBe(true);
    });

    it("returns false for a ledger outside synced ranges", () => {
      initializeSyncRangesTable();
      insertEventsWithDedup([], { startLedger: 100, endLedger: 200 });
      expect(isLedgerSynced(250)).toBe(false);
    });

    it("returns true at exact boundaries", () => {
      initializeSyncRangesTable();
      insertEventsWithDedup([], { startLedger: 100, endLedger: 200 });
      expect(isLedgerSynced(100)).toBe(true);
      expect(isLedgerSynced(200)).toBe(true);
    });
  });

  describe("getSyncedRanges", () => {
    it("returns empty array when nothing is synced", () => {
      initializeSyncRangesTable();
      expect(getSyncedRanges()).toEqual([]);
    });

    it("returns ranges sorted by start_ledger", () => {
      initializeSyncRangesTable();
      insertEventsWithDedup([], { startLedger: 300, endLedger: 400 });
      insertEventsWithDedup([], { startLedger: 100, endLedger: 200 });
      const ranges = getSyncedRanges();
      expect(ranges.length).toBe(2);
      expect(ranges[0].startLedger).toBe(100);
      expect(ranges[1].startLedger).toBe(300);
    });
  });

  describe("findUnsyncedRanges", () => {
    it("returns full range when nothing is synced", () => {
      initializeSyncRangesTable();
      const gaps = findUnsyncedRanges(100, 500);
      expect(gaps).toEqual([{ startLedger: 100, endLedger: 500 }]);
    });

    it("returns gap before first synced range", () => {
      initializeSyncRangesTable();
      insertEventsWithDedup([], { startLedger: 300, endLedger: 500 });
      const gaps = findUnsyncedRanges(100, 600);
      expect(gaps).toEqual([
        { startLedger: 100, endLedger: 299 },
        { startLedger: 501, endLedger: 600 },
      ]);
    });

    it("returns gap between two synced ranges", () => {
      initializeSyncRangesTable();
      insertEventsWithDedup([], { startLedger: 100, endLedger: 200 });
      insertEventsWithDedup([], { startLedger: 400, endLedger: 500 });
      const gaps = findUnsyncedRanges(100, 600);
      expect(gaps).toEqual([
        { startLedger: 201, endLedger: 399 },
        { startLedger: 501, endLedger: 600 },
      ]);
    });

    it("returns empty array when fully covered", () => {
      initializeSyncRangesTable();
      insertEventsWithDedup([], { startLedger: 100, endLedger: 600 });
      const gaps = findUnsyncedRanges(100, 600);
      expect(gaps).toEqual([]);
    });
  });

  describe("insertEventsWithDedup", () => {
    it("inserts new events and returns correct counts", () => {
      initializeSyncRangesTable();
      const events = [
        {
          contractId: "C1",
          eventType: "initialized",
          ledgerSequence: 100,
          timestamp: 1000,
          dataJson: "{}",
        },
        {
          contractId: "C1",
          eventType: "funded",
          ledgerSequence: 101,
          timestamp: 1001,
          dataJson: "{}",
        },
      ];

      const result = insertEventsWithDedup(events, {
        startLedger: 100,
        endLedger: 101,
      });

      expect(result.totalProcessed).toBe(2);
      expect(result.newEventsInserted).toBe(2);
      expect(result.duplicatesFound).toBe(0);
    });

    it("skips duplicate events on re-sync", () => {
      initializeSyncRangesTable();
      const events = [
        {
          contractId: "C1",
          eventType: "initialized",
          ledgerSequence: 100,
          timestamp: 1000,
          dataJson: "{}",
        },
      ];

      insertEventsWithDedup(events, { startLedger: 100, endLedger: 100 });

      const result = insertEventsWithDedup(events, {
        startLedger: 100,
        endLedger: 100,
      });

      expect(result.totalProcessed).toBe(1);
      expect(result.newEventsInserted).toBe(0);
      expect(result.duplicatesFound).toBe(1);
    });

    it("counts block event counts correctly across contracts", () => {
      initializeSyncRangesTable();
      const events = [
        {
          contractId: "C1",
          eventType: "initialized",
          ledgerSequence: 100,
          timestamp: 1000,
          dataJson: "{}",
        },
        {
          contractId: "C2",
          eventType: "initialized",
          ledgerSequence: 100,
          timestamp: 1000,
          dataJson: "{}",
        },
        {
          contractId: "C3",
          eventType: "funded",
          ledgerSequence: 101,
          timestamp: 1001,
          dataJson: "{}",
        },
      ];

      const result = insertEventsWithDedup(events, {
        startLedger: 100,
        endLedger: 101,
      });

      expect(result.newEventsInserted).toBe(3);
      expect(countEventsInRange(100, 101)).toBe(3);
    });

    it("handles empty event arrays", () => {
      initializeSyncRangesTable();
      const result = insertEventsWithDedup([], {
        startLedger: 500,
        endLedger: 600,
      });

      expect(result.totalProcessed).toBe(0);
      expect(result.newEventsInserted).toBe(0);
      expect(result.duplicatesFound).toBe(0);
    });

    it("tracks sync range metadata", () => {
      initializeSyncRangesTable();
      insertEventsWithDedup(
        [
          {
            contractId: "C1",
            eventType: "initialized",
            ledgerSequence: 100,
            timestamp: 1000,
            dataJson: "{}",
          },
        ],
        { startLedger: 100, endLedger: 150 },
      );

      const ranges = getSyncedRanges();
      expect(ranges.length).toBe(1);
      expect(ranges[0].startLedger).toBe(100);
      expect(ranges[0].endLedger).toBe(150);
      expect(ranges[0].eventCount).toBe(1);
      expect(ranges[0].duplicateCount).toBe(0);
    });
  });

  describe("countEventsInRange", () => {
    it("returns 0 for empty range", () => {
      expect(countEventsInRange(100, 200)).toBe(0);
    });

    it("counts events in range correctly", () => {
      insertEvent("C1", "initialized", 100, 1000, "{}");
      insertEvent("C1", "funded", 101, 1001, "{}");
      insertEvent("C1", "delivered", 102, 1002, "{}");

      expect(countEventsInRange(100, 101)).toBe(2);
      expect(countEventsInRange(100, 102)).toBe(3);
      expect(countEventsInRange(101, 102)).toBe(2);
      expect(countEventsInRange(200, 300)).toBe(0);
    });
  });

  describe("deleteEventsInRange", () => {
    it("deletes events in range", () => {
      insertEvent("C1", "initialized", 100, 1000, "{}");
      insertEvent("C1", "funded", 101, 1001, "{}");
      insertEvent("C1", "delivered", 102, 1002, "{}");

      const deleted = deleteEventsInRange(100, 101);
      expect(deleted).toBe(2);
      expect(countEventsInRange(100, 102)).toBe(1);
    });

    it("cleans up sync_ranges metadata for deleted range", () => {
      initializeSyncRangesTable();
      insertEventsWithDedup(
        [
          {
            contractId: "C1",
            eventType: "initialized",
            ledgerSequence: 100,
            timestamp: 1000,
            dataJson: "{}",
          },
        ],
        { startLedger: 100, endLedger: 200 },
      );

      deleteEventsInRange(100, 200);
      const ranges = getSyncedRanges();
      expect(ranges.length).toBe(0);
    });
  });

  describe("insertEventsWithDedupAsync – concurrency (#287)", () => {
    const duplicateEvent = {
      contractId: "C-RACE",
      eventType: "initialized",
      ledgerSequence: 500,
      timestamp: 2000,
      dataJson: '{"jobId":"race-1"}',
    };

    it("inserts a single event successfully under async path", async () => {
      const result = await insertEventsWithDedupAsync([duplicateEvent], {
        startLedger: 500,
        endLedger: 500,
      });

      expect(result.newEventsInserted).toBe(1);
      expect(result.duplicatesFound).toBe(0);
      expect(countEventsInRange(500, 500)).toBe(1);
    });

    it("handles sequential duplicate events correctly", async () => {
      await insertEventsWithDedupAsync([duplicateEvent], {
        startLedger: 500,
        endLedger: 500,
      });

      const second = await insertEventsWithDedupAsync([duplicateEvent], {
        startLedger: 500,
        endLedger: 500,
      });

      expect(second.newEventsInserted).toBe(0);
      expect(second.duplicatesFound).toBe(1);
      expect(countEventsInRange(500, 500)).toBe(1);
    });

    it("does not create duplicate rows when concurrent callers share a sync range", async () => {
      const concurrentCount = 32;
      const results = await Promise.all(
        Array.from({ length: concurrentCount }, () =>
          insertEventsWithDedupAsync([duplicateEvent], {
            startLedger: 500,
            endLedger: 500,
          }),
        ),
      );

      const insertedTotal = results.reduce(
        (sum, result) => sum + result.newEventsInserted,
        0,
      );
      const duplicateTotal = results.reduce(
        (sum, result) => sum + result.duplicatesFound,
        0,
      );

      expect(insertedTotal).toBe(1);
      expect(duplicateTotal).toBe(concurrentCount - 1);
      expect(countEventsInRange(500, 500)).toBe(1);

      const rowCount = (
        testDb
          .prepare(
            `SELECT COUNT(*) AS cnt FROM events
             WHERE contract_id = ? AND ledger_sequence = ? AND event_type = ?`,
          )
          .get("C-RACE", 500, "initialized") as { cnt: number }
      ).cnt;
      expect(rowCount).toBe(1);
    });

    it("serializes the same duplicate identity across different sync ranges under Promise.all", async () => {
      const overlapEvent = {
        contractId: "C-OVERLAP",
        eventType: "funded",
        ledgerSequence: 777,
        timestamp: 2500,
        dataJson: '{"milestone":1}',
      };
      const concurrentCount = 16;
      let activeEventLocks = 0;
      let maxActiveEventLocks = 0;

      setEventLockHookForTests(async () => {
        activeEventLocks += 1;
        maxActiveEventLocks = Math.max(maxActiveEventLocks, activeEventLocks);
        await Promise.resolve();
        activeEventLocks -= 1;
      });

      const results = await Promise.all(
        Array.from({ length: concurrentCount }, (_, index) =>
          insertEventsWithDedupAsync([overlapEvent], {
            startLedger: 1000 + index,
            endLedger: 1000 + index,
          }),
        ),
      );

      expect(maxActiveEventLocks).toBe(1);
      expect(
        results.reduce((sum, result) => sum + result.newEventsInserted, 0),
      ).toBe(1);
      expect(
        results.reduce((sum, result) => sum + result.duplicatesFound, 0),
      ).toBe(concurrentCount - 1);

      const rowCount = (
        testDb
          .prepare(
            `SELECT COUNT(*) AS cnt FROM events
             WHERE contract_id = ? AND ledger_sequence = ? AND event_type = ?`,
          )
          .get("C-OVERLAP", 777, "funded") as { cnt: number }
      ).cnt;
      expect(rowCount).toBe(1);
      expect(getSyncedRanges().length).toBe(concurrentCount);
    });

    it("processes concurrent distinct events in parallel sync ranges", async () => {
      const events = Array.from({ length: 20 }, (_, index) => ({
        contractId: `C-${index}`,
        eventType: "funded",
        ledgerSequence: 600 + index,
        timestamp: 3000 + index,
        dataJson: JSON.stringify({ index }),
      }));

      const results = await Promise.all(
        events.map((event) =>
          insertEventsWithDedupAsync([event], {
            startLedger: event.ledgerSequence,
            endLedger: event.ledgerSequence,
          }),
        ),
      );

      expect(results.every((result) => result.newEventsInserted === 1)).toBe(true);
      expect(countEventsInRange(600, 619)).toBe(20);
    });

    it("rolls back event inserts when sync_ranges metadata write fails atomically", async () => {
      const failLedger = 9_007_007;
      const failRange = { startLedger: failLedger, endLedger: failLedger };
      const failEvent = {
        contractId: "C-ATOMIC-FAIL",
        eventType: "initialized",
        ledgerSequence: failLedger,
        timestamp: 4000,
        dataJson: "{}",
      };

      setBeforeSyncRangeWriteHookForTests(() => {
        throw new Error("simulated sync_ranges failure");
      });

      await expect(
        insertEventsWithDedupAsync([failEvent], failRange),
      ).rejects.toThrow("simulated sync_ranges failure");

      expect(countEventsInRange(failLedger, failLedger)).toBe(0);
      initializeSyncRangesTable();
      expect(getSyncedRanges().length).toBe(0);

      setBeforeSyncRangeWriteHookForTests(null);

      const recovery = await insertEventsWithDedupAsync([failEvent], failRange);

      expect(recovery.newEventsInserted).toBe(1);
      expect(recovery.duplicatesFound).toBe(0);
      expect(countEventsInRange(failLedger, failLedger)).toBe(1);
    });
  });

  describe("polling diagnostics (#288)", () => {
    it("logs elapsed time and payload size at debug level", () => {
      const events = [
        {
          contractId: "C1",
          eventType: "initialized",
          ledgerSequence: 800,
          timestamp: 5000,
          dataJson: '{"a":1}',
        },
      ];

      insertEventsWithDedup(events, { startLedger: 800, endLedger: 800 });

      const diagnosticCalls = mockLogger.debug.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" &&
          call[0].includes("Duplicate prevention poll diagnostics"),
      );

      expect(diagnosticCalls.length).toBeGreaterThanOrEqual(1);
      expect(diagnosticCalls[0][1]).toMatchObject({
        elapsedMs: expect.any(Number),
        payloadSizeBytes: expect.any(Number),
        eventCount: 1,
      });
      expect((diagnosticCalls[0][1] as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(
        0,
      );
    });

    it("includes async diagnostics with measurable elapsedMs", async () => {
      await insertEventsWithDedupAsync(
        [
          {
            contractId: "C2",
            eventType: "funded",
            ledgerSequence: 801,
            timestamp: 5001,
            dataJson: '{"b":2}',
          },
        ],
        { startLedger: 801, endLedger: 801 },
      );

      const diagnosticCalls = mockLogger.debug.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" &&
          call[0].includes("Duplicate prevention poll diagnostics"),
      );

      expect(diagnosticCalls.length).toBeGreaterThanOrEqual(1);
      const meta = diagnosticCalls[diagnosticCalls.length - 1][1] as {
        elapsedMs: number;
        payloadSizeBytes: number;
        eventCount: number;
      };
      expect(meta.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(meta.payloadSizeBytes).toBeGreaterThan(0);
      expect(meta.eventCount).toBe(1);
    });
  });

  describe("ingestRpcEventNotifications – integration (#293)", () => {
    it("persists simulated RPC notifications to the events schema", async () => {
      const result = await ingestRpcEventNotifications(
        [
          {
            contractId: "C-RPC",
            eventType: "initialized",
            ledger: 900,
            value: { client: "GABC...", freelancer: "GDEF..." },
          },
          {
            contractId: "C-RPC",
            eventType: "funded",
            ledger: 901,
            value: { amount: "1000000" },
          },
        ],
        { startLedger: 900, endLedger: 901 },
      );

      expect(result.newEventsInserted).toBe(2);
      expect(countEventsInRange(900, 901)).toBe(2);

      const rows = testDb
        .prepare(
          `SELECT contract_id, event_type, ledger_sequence, data_json
           FROM events
           WHERE contract_id = ?
           ORDER BY ledger_sequence ASC`,
        )
        .all("C-RPC") as Array<{
        contract_id: string;
        event_type: string;
        ledger_sequence: number;
        data_json: string;
      }>;

      expect(rows).toHaveLength(2);
      expect(rows[0].event_type).toBe("initialized");
      expect(JSON.parse(rows[0].data_json)).toEqual({
        client: "GABC...",
        freelancer: "GDEF...",
      });
      expect(rows[1].event_type).toBe("funded");
    });

    it("deduplicates repeated RPC notifications under concurrent ingest", async () => {
      const notification = {
        contractId: "C-RPC-DUP",
        eventType: "approved",
        ledger: 950,
        value: { milestone: 1 },
      };

      const results = await Promise.all(
        Array.from({ length: 16 }, () =>
          ingestRpcEventNotifications([notification], {
            startLedger: 950,
            endLedger: 950,
          }),
        ),
      );

      expect(
        results.reduce((sum, result) => sum + result.newEventsInserted, 0),
      ).toBe(1);
      expect(countEventsInRange(950, 950)).toBe(1);
      expect(getLastIndexedLedger()).toBe(0);
    });
  });
});
