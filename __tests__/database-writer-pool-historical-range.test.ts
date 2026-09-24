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
  configureWriterPoolHistoricalRange,
  countWriterPoolEventsByLedger,
  DEFAULT_WRITER_POOL_HISTORICAL_PAGE_SIZE,
  getWriterPoolHistoricalRangeConfig,
  importHistoricalRange,
  queueWrite,
  resetWriterPoolHistoricalRangeConfig,
  resetWriterPoolStartState,
  resolveWriterPoolHistoricalRange,
  startWriterPool,
} from "../src/indexer/database-writer-pool.js";
import {
  getLedgerRangeMetadata,
  LedgerRangeValidationError,
} from "../src/indexer/ledger-range-tracker.js";

const CONTRACT_ID = "CTEST0000000000000000000000000000000000000000000000000001";
const EVENT_TYPES = ["initialized", "funded", "approved"];

/**
 * Build `perLedger` distinct events for every ledger in [start, end].
 * Event types differ within a ledger so each row is a distinct identity under
 * the events table's UNIQUE(contract_id, ledger_sequence, event_type).
 */
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

describe("database_writer_pool – dynamic historical sync ranges (#330)", () => {
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
    resetWriterPoolStartState();
    resetWriterPoolHistoricalRangeConfig();
  });

  afterEach(() => {
    resetWriterPoolStartState();
    resetWriterPoolHistoricalRangeConfig();
    closeDb();
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  describe("resolveWriterPoolHistoricalRange", () => {
    it("accepts explicit dynamic start and end ledgers", () => {
      expect(
        resolveWriterPoolHistoricalRange({ startLedger: 25, endLedger: 90 })
      ).toEqual({ startLedger: 25, endLedger: 90 });
    });

    it("accepts a single-ledger range (inclusive boundary)", () => {
      expect(
        resolveWriterPoolHistoricalRange({ startLedger: 7, endLedger: 7 })
      ).toEqual({ startLedger: 7, endLedger: 7 });
    });

    it("falls back to LEDGER_RANGE_START / LEDGER_RANGE_END", () => {
      process.env.LEDGER_RANGE_START = "120";
      process.env.LEDGER_RANGE_END = "180";
      expect(resolveWriterPoolHistoricalRange()).toEqual({
        startLedger: 120,
        endLedger: 180,
      });
    });

    it("prefers explicit values over env values", () => {
      process.env.LEDGER_RANGE_START = "120";
      process.env.LEDGER_RANGE_END = "180";
      expect(
        resolveWriterPoolHistoricalRange({ startLedger: 5, endLedger: 9 })
      ).toEqual({ startLedger: 5, endLedger: 9 });
    });

    it("uses the pool's configured start and end", () => {
      configureWriterPoolHistoricalRange({ startLedger: 40, endLedger: 45 });
      expect(resolveWriterPoolHistoricalRange()).toEqual({
        startLedger: 40,
        endLedger: 45,
      });
    });

    it("prefers explicit values over pool configuration", () => {
      configureWriterPoolHistoricalRange({ startLedger: 40, endLedger: 45 });
      expect(
        resolveWriterPoolHistoricalRange({ startLedger: 2, endLedger: 3 })
      ).toEqual({ startLedger: 2, endLedger: 3 });
    });

    it("preserves the live default window when no custom range is supplied", () => {
      setLastIndexedLedger(50);
      expect(
        resolveWriterPoolHistoricalRange({ defaultEnd: 80 })
      ).toEqual({ startLedger: 51, endLedger: 80 });
    });

    it("uses last_indexed + 1 as the default start when the pointer is unset", () => {
      expect(
        resolveWriterPoolHistoricalRange({ defaultEnd: 10 })
      ).toEqual({ startLedger: 1, endLedger: 10 });
    });

    it("uses a custom start with the live default end", () => {
      expect(
        resolveWriterPoolHistoricalRange({
          startLedger: 10,
          defaultEnd: 40,
        })
      ).toEqual({ startLedger: 10, endLedger: 40 });
    });

    it("uses a custom end with the live default start", () => {
      setLastIndexedLedger(19);
      expect(
        resolveWriterPoolHistoricalRange({ endLedger: 25 })
      ).toEqual({ startLedger: 20, endLedger: 25 });
    });

    it("rejects an inverted range (start > end)", () => {
      expect(() =>
        resolveWriterPoolHistoricalRange({ startLedger: 90, endLedger: 20 })
      ).toThrow(LedgerRangeValidationError);
      expect(() =>
        resolveWriterPoolHistoricalRange({ startLedger: 90, endLedger: 20 })
      ).toThrow(/start ledger must not exceed end ledger/);
    });

    it("rejects non-positive and non-integer start ledgers", () => {
      expect(() =>
        resolveWriterPoolHistoricalRange({ startLedger: 0, endLedger: 10 })
      ).toThrow(/start ledger must be a positive integer/);
      expect(() =>
        resolveWriterPoolHistoricalRange({ startLedger: -3, endLedger: 10 })
      ).toThrow(LedgerRangeValidationError);
      expect(() =>
        resolveWriterPoolHistoricalRange({ startLedger: 1.5, endLedger: 10 })
      ).toThrow(LedgerRangeValidationError);
      expect(() =>
        resolveWriterPoolHistoricalRange({ startLedger: NaN, endLedger: 10 })
      ).toThrow(LedgerRangeValidationError);
    });

    it("rejects non-positive and non-integer end ledgers", () => {
      expect(() =>
        resolveWriterPoolHistoricalRange({ startLedger: 1, endLedger: 0 })
      ).toThrow(/end ledger must be a positive integer/);
      expect(() =>
        resolveWriterPoolHistoricalRange({ startLedger: 1, endLedger: -2 })
      ).toThrow(LedgerRangeValidationError);
      expect(() =>
        resolveWriterPoolHistoricalRange({ startLedger: 1, endLedger: 10.5 })
      ).toThrow(LedgerRangeValidationError);
      expect(() =>
        resolveWriterPoolHistoricalRange({ startLedger: 1, endLedger: Infinity })
      ).toThrow(LedgerRangeValidationError);
    });

    it("requires a resolvable end when no default or env is set", () => {
      expect(() =>
        resolveWriterPoolHistoricalRange({ startLedger: 4 })
      ).toThrow(/end ledger is required/);
    });
  });

  describe("configureWriterPoolHistoricalRange", () => {
    it("stores a valid configured range", () => {
      const config = configureWriterPoolHistoricalRange({
        startLedger: 10,
        endLedger: 20,
        pageSize: 5,
      });
      expect(config).toEqual({ startLedger: 10, endLedger: 20, pageSize: 5 });
      expect(getWriterPoolHistoricalRangeConfig()).toEqual(config);
    });

    it("rejects an inverted configured range", () => {
      expect(() =>
        configureWriterPoolHistoricalRange({ startLedger: 20, endLedger: 10 })
      ).toThrow(/start ledger must not exceed end ledger/);
      expect(getWriterPoolHistoricalRangeConfig()).toEqual({});
    });

    it("rejects an invalid configured start or page size", () => {
      expect(() =>
        configureWriterPoolHistoricalRange({ startLedger: 0 })
      ).toThrow(/start ledger must be a positive integer/);
      expect(() =>
        configureWriterPoolHistoricalRange({ pageSize: -1 })
      ).toThrow(/page size must be a positive integer/);
    });

    it("accepts startLedger and endLedger on startWriterPool", () => {
      startWriterPool({ startLedger: 8, endLedger: 12 });
      expect(getWriterPoolHistoricalRangeConfig()).toEqual({
        startLedger: 8,
        endLedger: 12,
      });
    });

    it("rejects an invalid range supplied to startWriterPool", () => {
      expect(() => startWriterPool({ startLedger: 15, endLedger: 3 })).toThrow(
        LedgerRangeValidationError
      );
    });
  });

  describe("importHistoricalRange – valid ranges and indexed counts", () => {
    it("indexes a single-ledger range with one event and one block", async () => {
      const result = await importHistoricalRange({
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
      const result = await importHistoricalRange({
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
      expect(getLedgerRangeMetadata(10, 14).totalEvents).toBe(5);
    });

    it("indexes multiple events per ledger and reports per-block counts", async () => {
      const result = await importHistoricalRange({
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

    it("includes start and end boundary ledgers (inclusive) and drops neighbors", async () => {
      const result = await importHistoricalRange({
        startLedger: 7,
        endLedger: 9,
        events: eventsForRange(6, 10),
      });

      expect(result.eventCount).toBe(3);
      expect(result.insertedCount).toBe(3);
      expect(result.processedLedgerCount).toBe(3);
      expect(countIndexedEvents(testDb, 6, 10)).toBe(3);
      expect(countIndexedEvents(testDb, 6, 6)).toBe(0);
      expect(countIndexedEvents(testDb, 10, 10)).toBe(0);
      expect(countIndexedEvents(testDb, 7, 7)).toBe(1);
      expect(countIndexedEvents(testDb, 9, 9)).toBe(1);
    });

    it("does not index events outside the requested range", async () => {
      await importHistoricalRange({
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
      expect(countIndexedEvents(testDb, 23, 24)).toBe(0);
      expect(countIndexedBlocks(testDb, 20, 22)).toBe(3);
    });

    it("paginates a custom range without processing past the requested end", async () => {
      const pages: Array<{ startLedger: number; endLedger: number }> = [];
      const result = await importHistoricalRange({
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
      expect(result.pages).toEqual(pages);
      expect(result.insertedCount).toBe(6);
      expect(result.processedLedgerCount).toBe(6);
      expect(countIndexedEvents(testDb, 10, 15)).toBe(6);
      expect(countIndexedEvents(testDb, 16, 20)).toBe(0);
      expect(DEFAULT_WRITER_POOL_HISTORICAL_PAGE_SIZE).toBe(100);
    });

    it("uses the requested range from pool configuration", async () => {
      configureWriterPoolHistoricalRange({ startLedger: 30, endLedger: 32 });
      const result = await importHistoricalRange({
        events: eventsForRange(28, 35),
      });

      expect(result.range).toEqual({ startLedger: 30, endLedger: 32 });
      expect(result.insertedCount).toBe(3);
      expect(countIndexedEvents(testDb, 30, 32)).toBe(3);
      expect(countIndexedEvents(testDb, 28, 29)).toBe(0);
    });

    it("uses the requested range from LEDGER_RANGE_START / LEDGER_RANGE_END", async () => {
      process.env.LEDGER_RANGE_START = "4";
      process.env.LEDGER_RANGE_END = "6";
      const result = await importHistoricalRange({
        events: eventsForRange(1, 10, 2),
      });

      expect(result.range).toEqual({ startLedger: 4, endLedger: 6 });
      expect(result.eventCount).toBe(6);
      expect(result.insertedCount).toBe(6);
      expect(result.processedLedgerCount).toBe(3);
      expect(countIndexedEvents(testDb, 4, 6)).toBe(6);
      expect(countIndexedBlocks(testDb, 4, 6)).toBe(3);
    });

    it("does not advance the live pointer during a historical import", async () => {
      setLastIndexedLedger(500);
      await importHistoricalRange({
        startLedger: 10,
        endLedger: 12,
        events: eventsForRange(10, 12),
      });
      expect(getLastIndexedLedger()).toBe(500);
      expect(countIndexedEvents(testDb, 10, 12)).toBe(3);
    });

    it("can optionally advance the live pointer for a live-compatible write", async () => {
      setLastIndexedLedger(500);
      await importHistoricalRange({
        startLedger: 501,
        endLedger: 505,
        events: eventsForRange(501, 505),
        advanceLivePointer: true,
      });
      expect(getLastIndexedLedger()).toBe(505);
      expect(countIndexedEvents(testDb, 501, 505)).toBe(5);
    });

    it("deduplicates events already indexed in the same range", async () => {
      await importHistoricalRange({
        startLedger: 1,
        endLedger: 3,
        events: eventsForRange(1, 3),
      });
      const second = await importHistoricalRange({
        startLedger: 1,
        endLedger: 3,
        events: eventsForRange(1, 3),
      });

      expect(second.eventCount).toBe(3);
      expect(second.insertedCount).toBe(0);
      expect(second.duplicateCount).toBe(3);
      expect(countIndexedEvents(testDb, 1, 3)).toBe(3);
    });

    it("leaves existing live writes unaffected when importing a historical range", async () => {
      await queueWrite({
        name: "live-write",
        execute: (db) => {
          db.prepare(
            `INSERT INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json)
             VALUES (?, ?, ?, ?, ?)`
          ).run(CONTRACT_ID, "initialized", 900, 1, "{}");
        },
      });

      await importHistoricalRange({
        startLedger: 1,
        endLedger: 2,
        events: eventsForRange(1, 2),
      });

      expect(countIndexedEvents(testDb, 1, 2)).toBe(2);
      expect(countIndexedEvents(testDb, 900, 900)).toBe(1);
      expect(getLastIndexedLedger()).toBe(0);
    });
  });

  describe("importHistoricalRange – invalid ranges", () => {
    it("rejects start > end and indexes nothing", async () => {
      await expect(
        importHistoricalRange({
          startLedger: 9,
          endLedger: 3,
          events: eventsForRange(1, 10),
        })
      ).rejects.toThrow(LedgerRangeValidationError);

      expect(countIndexedEvents(testDb, 1, 10)).toBe(0);
    });

    it("rejects an invalid start ledger and indexes nothing", async () => {
      await expect(
        importHistoricalRange({
          startLedger: 0,
          endLedger: 5,
          events: eventsForRange(1, 5),
        })
      ).rejects.toThrow(/start ledger must be a positive integer/);
      expect(countIndexedEvents(testDb, 1, 5)).toBe(0);
    });

    it("rejects an invalid end ledger and indexes nothing", async () => {
      await expect(
        importHistoricalRange({
          startLedger: 1,
          endLedger: -1,
          events: eventsForRange(1, 5),
        })
      ).rejects.toThrow(/end ledger must be a positive integer/);
      expect(countIndexedEvents(testDb, 1, 5)).toBe(0);
    });

    it("rejects a non-integer page size", async () => {
      await expect(
        importHistoricalRange({
          startLedger: 1,
          endLedger: 5,
          pageSize: 0,
          events: eventsForRange(1, 5),
        })
      ).rejects.toThrow(/page size must be a positive integer/);
    });
  });

  describe("countWriterPoolEventsByLedger", () => {
    it("aggregates per-block counts in ledger order", () => {
      expect(countWriterPoolEventsByLedger(eventsForRange(2, 4, 2))).toEqual([
        { ledgerSequence: 2, eventCount: 2 },
        { ledgerSequence: 3, eventCount: 2 },
        { ledgerSequence: 4, eventCount: 2 },
      ]);
    });
  });
});
