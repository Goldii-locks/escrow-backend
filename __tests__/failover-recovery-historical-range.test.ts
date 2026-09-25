import Database from "better-sqlite3";
import {
  setDb,
  runMigrations,
  closeDb,
  setLastIndexedLedger,
  getLastIndexedLedger,
  type EventRow,
} from "../src/indexer/db.js";
import {
  configureFailoverRecoveryHistoricalRange,
  countFailoverRecoveryEventsByLedger,
  DEFAULT_FAILOVER_RECOVERY_HISTORICAL_PAGE_SIZE,
  getFailoverRecoveryHistoricalRangeConfig,
  importFailoverRecoveryHistoricalRange,
  resetFailoverRecoveryHistoricalRangeConfig,
  resolveFailoverRecoveryHistoricalRange,
  LedgerRangeValidationError,
} from "../src/indexer/failover-recovery.js";
import { getLedgerRangeMetadata } from "../src/indexer/ledger-range-tracker.js";

const CONTRACT_ID = "CTEST0000000000000000000000000000000000000000000000000001";
const EVENT_TYPES = ["initialized", "funded", "approved"];

function eventsForRange(
  start: number,
  end: number,
  perLedger = 1,
  contractId = CONTRACT_ID
): EventRow[] {
  const events: EventRow[] = [];
  for (let ledger = start; ledger <= end; ledger++) {
    for (let index = 0; index < perLedger; index++) {
      events.push({
        contractId,
        eventType: EVENT_TYPES[index % EVENT_TYPES.length],
        ledgerSequence: ledger,
        timestamp: 1_700_000_000 + ledger,
        dataJson: JSON.stringify({ ledger, index }),
      });
    }
  }
  return events;
}

function countIndexedEvents(db: Database.Database, start: number, end: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM events
       WHERE ledger_sequence >= ? AND ledger_sequence <= ?`
    )
    .get(start, end) as { count: number };
  return row.count;
}

function countIndexedBlocks(db: Database.Database, start: number, end: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT ledger_sequence) as count FROM events
       WHERE ledger_sequence >= ? AND ledger_sequence <= ?`
    )
    .get(start, end) as { count: number };
  return row.count;
}

describe("indexer_failover_recovery – dynamic historical sync ranges (#416)", () => {
  let testDb: Database.Database;
  const envKeys = ["LEDGER_RANGE_START", "LEDGER_RANGE_END"] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    testDb = new Database(":memory:");
    setDb(testDb);
    runMigrations();
    resetFailoverRecoveryHistoricalRangeConfig();
  });

  afterEach(() => {
    resetFailoverRecoveryHistoricalRangeConfig();
    closeDb();
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  describe("resolveFailoverRecoveryHistoricalRange", () => {
    it("accepts explicit dynamic start and end ledgers", () => {
      expect(
        resolveFailoverRecoveryHistoricalRange({ startLedger: 25, endLedger: 90 })
      ).toEqual({ startLedger: 25, endLedger: 90 });
    });

    it("accepts a single-ledger range (inclusive boundary)", () => {
      expect(
        resolveFailoverRecoveryHistoricalRange({ startLedger: 7, endLedger: 7 })
      ).toEqual({ startLedger: 7, endLedger: 7 });
    });

    it("falls back to LEDGER_RANGE_START / LEDGER_RANGE_END", () => {
      process.env.LEDGER_RANGE_START = "120";
      process.env.LEDGER_RANGE_END = "180";
      expect(resolveFailoverRecoveryHistoricalRange()).toEqual({
        startLedger: 120,
        endLedger: 180,
      });
    });

    it("prefers explicit values over env values", () => {
      process.env.LEDGER_RANGE_START = "120";
      process.env.LEDGER_RANGE_END = "180";
      expect(
        resolveFailoverRecoveryHistoricalRange({ startLedger: 5, endLedger: 9 })
      ).toEqual({ startLedger: 5, endLedger: 9 });
    });

    it("uses the configured start and end", () => {
      configureFailoverRecoveryHistoricalRange({ startLedger: 40, endLedger: 45 });
      expect(resolveFailoverRecoveryHistoricalRange()).toEqual({
        startLedger: 40,
        endLedger: 45,
      });
    });

    it("rejects an inverted range (start > end)", () => {
      expect(() =>
        resolveFailoverRecoveryHistoricalRange({ startLedger: 90, endLedger: 20 })
      ).toThrow(LedgerRangeValidationError);
    });

    it("rejects non-positive and non-integer ledgers", () => {
      expect(() =>
        resolveFailoverRecoveryHistoricalRange({ startLedger: 0, endLedger: 10 })
      ).toThrow(/start ledger must be a positive integer/);
      expect(() =>
        resolveFailoverRecoveryHistoricalRange({ startLedger: 1, endLedger: 10.5 })
      ).toThrow(LedgerRangeValidationError);
    });

    it("requires a resolvable end when no default or env is set", () => {
      expect(() =>
        resolveFailoverRecoveryHistoricalRange({ startLedger: 4 })
      ).toThrow(/end ledger is required/);
    });
  });

  describe("configureFailoverRecoveryHistoricalRange", () => {
    it("stores a valid configured range", () => {
      const config = configureFailoverRecoveryHistoricalRange({
        startLedger: 10,
        endLedger: 20,
        pageSize: 5,
      });
      expect(config).toEqual({ startLedger: 10, endLedger: 20, pageSize: 5 });
      expect(getFailoverRecoveryHistoricalRangeConfig()).toEqual(config);
    });

    it("rejects an inverted configured range", () => {
      expect(() =>
        configureFailoverRecoveryHistoricalRange({ startLedger: 20, endLedger: 10 })
      ).toThrow(/start ledger must not exceed end ledger/);
    });

    it("exposes a sane default page size", () => {
      expect(DEFAULT_FAILOVER_RECOVERY_HISTORICAL_PAGE_SIZE).toBe(100);
    });
  });

  describe("importFailoverRecoveryHistoricalRange – correct block event counts", () => {
    it("indexes a single-ledger range with one event and one block", async () => {
      const result = await importFailoverRecoveryHistoricalRange({
        startLedger: 42,
        endLedger: 42,
        events: eventsForRange(42, 42),
      });

      expect(result.range).toEqual({ startLedger: 42, endLedger: 42 });
      expect(result.eventCount).toBe(1);
      expect(result.insertedCount).toBe(1);
      expect(result.duplicateCount).toBe(0);
      expect(result.processedLedgerCount).toBe(1);
      expect(result.ledgerEventCounts).toEqual([{ ledgerSequence: 42, eventCount: 1 }]);
      expect(countIndexedEvents(testDb, 42, 42)).toBe(1);
      expect(countIndexedBlocks(testDb, 42, 42)).toBe(1);
      expect(getLedgerRangeMetadata(42, 42).totalEvents).toBe(1);
    });

    it("indexes a small multi-ledger range with the correct event and block counts", async () => {
      const result = await importFailoverRecoveryHistoricalRange({
        startLedger: 10,
        endLedger: 14,
        events: eventsForRange(10, 14),
      });

      expect(result.insertedCount).toBe(5);
      expect(result.eventCount).toBe(5);
      expect(result.processedLedgerCount).toBe(5);
      expect(result.ledgerEventCounts).toEqual([
        { ledgerSequence: 10, eventCount: 1 },
        { ledgerSequence: 11, eventCount: 1 },
        { ledgerSequence: 12, eventCount: 1 },
        { ledgerSequence: 13, eventCount: 1 },
        { ledgerSequence: 14, eventCount: 1 },
      ]);
      expect(countIndexedEvents(testDb, 10, 14)).toBe(5);
      expect(countIndexedBlocks(testDb, 10, 14)).toBe(5);
    });

    it("indexes multiple events per ledger and reports per-block counts", async () => {
      const result = await importFailoverRecoveryHistoricalRange({
        startLedger: 3,
        endLedger: 5,
        events: eventsForRange(3, 5, 3),
      });

      expect(result.eventCount).toBe(9);
      expect(result.insertedCount).toBe(9);
      expect(result.processedLedgerCount).toBe(3);
      expect(result.ledgerEventCounts).toEqual([
        { ledgerSequence: 3, eventCount: 3 },
        { ledgerSequence: 4, eventCount: 3 },
        { ledgerSequence: 5, eventCount: 3 },
      ]);
      expect(countIndexedEvents(testDb, 3, 5)).toBe(9);
      expect(countIndexedBlocks(testDb, 3, 5)).toBe(3);
    });

    it("does not index events outside the requested range", async () => {
      await importFailoverRecoveryHistoricalRange({
        startLedger: 20,
        endLedger: 22,
        events: [
          ...eventsForRange(18, 19),
          ...eventsForRange(20, 22),
          ...eventsForRange(23, 24),
        ],
      });

      expect(countIndexedEvents(testDb, 18, 24)).toBe(3);
      expect(countIndexedEvents(testDb, 18, 19)).toBe(0);
      expect(countIndexedBlocks(testDb, 20, 22)).toBe(3);
    });

    it("paginates a custom range without processing past the requested end", async () => {
      const pages: Array<{ startLedger: number; endLedger: number }> = [];
      const result = await importFailoverRecoveryHistoricalRange({
        startLedger: 10,
        endLedger: 15,
        pageSize: 2,
        fetchEvents: (page) => {
          pages.push({ ...page });
          return eventsForRange(page.startLedger, page.endLedger);
        },
      });

      expect(pages).toEqual([
        { startLedger: 10, endLedger: 11 },
        { startLedger: 12, endLedger: 13 },
        { startLedger: 14, endLedger: 15 },
      ]);
      expect(result.insertedCount).toBe(6);
      expect(countIndexedEvents(testDb, 10, 15)).toBe(6);
    });

    it("does not advance the live pointer during a historical import", async () => {
      setLastIndexedLedger(500);
      await importFailoverRecoveryHistoricalRange({
        startLedger: 10,
        endLedger: 12,
        events: eventsForRange(10, 12),
      });
      expect(getLastIndexedLedger()).toBe(500);
      expect(countIndexedEvents(testDb, 10, 12)).toBe(3);
    });

    it("deduplicates events already indexed in the same range", async () => {
      await importFailoverRecoveryHistoricalRange({
        startLedger: 1,
        endLedger: 3,
        events: eventsForRange(1, 3),
      });
      const second = await importFailoverRecoveryHistoricalRange({
        startLedger: 1,
        endLedger: 3,
        events: eventsForRange(1, 3),
      });

      expect(second.insertedCount).toBe(0);
      expect(second.duplicateCount).toBe(3);
      expect(countIndexedEvents(testDb, 1, 3)).toBe(3);
    });

    it("rejects invalid ranges and indexes nothing", async () => {
      await expect(
        importFailoverRecoveryHistoricalRange({
          startLedger: 9,
          endLedger: 3,
          events: eventsForRange(1, 10),
        })
      ).rejects.toThrow(LedgerRangeValidationError);
      expect(countIndexedEvents(testDb, 1, 10)).toBe(0);
    });
  });

  describe("countFailoverRecoveryEventsByLedger", () => {
    it("aggregates per-block counts in ledger order", () => {
      expect(countFailoverRecoveryEventsByLedger(eventsForRange(2, 4, 2))).toEqual([
        { ledgerSequence: 2, eventCount: 2 },
        { ledgerSequence: 3, eventCount: 2 },
        { ledgerSequence: 4, eventCount: 2 },
      ]);
    });
  });
});
