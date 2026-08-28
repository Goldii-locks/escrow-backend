import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import {
  setDb,
  runMigrations,
  setLastIndexedLedger,
  getLastIndexedLedger,
  type EventRow,
} from "../src/indexer/db.js";
import logger from "../src/utils/logger.js";
import {
  LedgerRangeTracker,
  LedgerRangeValidationError,
  validateLedgerRange,
  resolveHistoricalLedgerRange,
  chunkLedgerRange,
  filterEventsToRange,
  processLedgerRange,
  withEventLock,
  withOverlappingRangeLock,
  getHeldEventLockCount,
  getHeldRangeLockCount,
  getLedgerRangeMetadata,
  resetLedgerRangeTrackerState,
  getHistoricalRangeConfig,
  DEFAULT_LEDGER_RANGE_PAGE_SIZE,
  DEFAULT_LEDGER_RANGE_FAILURE_THRESHOLD,
} from "../src/indexer/ledger-range-tracker.js";

type LoggerCall = [string, Record<string, unknown>?];

/**
 * winston's Logger overloads type spy.mock.calls as a 1-tuple in some
 * inference contexts; normalize to the (message, meta) shape the tests
 * actually rely on.
 */
function calls(spy: ReturnType<typeof jest.spyOn>): LoggerCall[] {
  return spy.mock.calls as unknown as LoggerCall[];
}

function makeEvent(overrides: Partial<EventRow> = {}): EventRow {
  return {
    contractId: "C1",
    eventType: "initialized",
    ledgerSequence: 10,
    timestamp: 1_000,
    dataJson: JSON.stringify({ n: 1 }),
    ...overrides,
  };
}

function eventsForRange(
  start: number,
  end: number,
  contractId = "C1"
): EventRow[] {
  const events: EventRow[] = [];
  for (let ledger = start; ledger <= end; ledger++) {
    events.push(
      makeEvent({
        contractId,
        eventType: "initialized",
        ledgerSequence: ledger,
        timestamp: 1_000 + ledger,
        dataJson: JSON.stringify({ ledger }),
      })
    );
  }
  return events;
}

describe("ledger_range_tracker improvements (#296, #297, #298, #299)", () => {
  let testDb: Database.Database;
  const envKeys = [
    "LEDGER_RANGE_START",
    "LEDGER_RANGE_END",
    "LEDGER_RANGE_PAGE_SIZE",
    "LEDGER_RANGE_FAILURE_THRESHOLD",
    "LEDGER_RANGE_STALL_THRESHOLD_MS",
  ] as const;
  const envSnapshot: Record<string, string | undefined> = {};

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
  });

  afterAll(() => {
    testDb.close();
  });

  beforeEach(() => {
    for (const key of envKeys) {
      envSnapshot[key] = process.env[key];
      delete process.env[key];
    }
    testDb.exec("DROP TABLE IF EXISTS events");
    testDb.exec("DROP TABLE IF EXISTS indexer_state");
    testDb.exec("DROP TABLE IF EXISTS schema_migrations");
    testDb.exec("DROP TABLE IF EXISTS monitored_contracts");
    testDb.exec("DROP TABLE IF EXISTS webhook_subscriptions");
    runMigrations();
    resetLedgerRangeTrackerState();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }
    jest.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // #299 Dynamic historical sync ranges
  // -----------------------------------------------------------------------

  describe("dynamic historical ranges (#299)", () => {
    it("preserves default live window when no custom start/end are provided", () => {
      setLastIndexedLedger(50);
      const range = resolveHistoricalLedgerRange({
        defaultStart: 51,
        defaultEnd: 80,
      });
      expect(range).toEqual({ startLedger: 51, endLedger: 80 });
    });

    it("uses a custom start with the live default end", () => {
      const range = resolveHistoricalLedgerRange({
        startLedger: 10,
        defaultEnd: 40,
      });
      expect(range.startLedger).toBe(10);
      expect(range.endLedger).toBe(40);
    });

    it("uses a custom end with the live default start", () => {
      const range = resolveHistoricalLedgerRange({
        endLedger: 25,
        defaultStart: 20,
      });
      expect(range).toEqual({ startLedger: 20, endLedger: 25 });
    });

    it("uses custom start and end together", () => {
      expect(validateLedgerRange(100, 150)).toEqual({
        startLedger: 100,
        endLedger: 150,
      });
    });

    it("reads historical range from LEDGER_RANGE_START / LEDGER_RANGE_END", () => {
      process.env.LEDGER_RANGE_START = "200";
      process.env.LEDGER_RANGE_END = "250";
      expect(getHistoricalRangeConfig().startLedger).toBe(200);
      expect(getHistoricalRangeConfig().endLedger).toBe(250);
      expect(resolveHistoricalLedgerRange()).toEqual({
        startLedger: 200,
        endLedger: 250,
      });
    });

    it("indexes a single-ledger range", async () => {
      const tracker = new LedgerRangeTracker({ name: "single" });
      const result = await tracker.processRange({
        startLedger: 42,
        endLedger: 42,
        events: eventsForRange(42, 42),
      });
      expect(result.range).toEqual({ startLedger: 42, endLedger: 42 });
      expect(result.eventCount).toBe(1);
      expect(result.insertedCount).toBe(1);
      expect(getLedgerRangeMetadata(42, 42).totalEvents).toBe(1);
    });

    it("indexes a small multi-ledger range with correct event counts", async () => {
      const tracker = new LedgerRangeTracker();
      const result = await tracker.processRange({
        startLedger: 10,
        endLedger: 14,
        events: eventsForRange(10, 14),
      });
      expect(result.insertedCount).toBe(5);
      expect(result.processedLedgerCount).toBe(5);
      expect(getLedgerRangeMetadata(10, 14).totalEvents).toBe(5);
    });

    it("includes start and end boundary ledgers (inclusive)", async () => {
      const tracker = new LedgerRangeTracker();
      await tracker.processRange({
        startLedger: 7,
        endLedger: 9,
        events: eventsForRange(6, 10),
      });
      const metadata = getLedgerRangeMetadata(6, 10);
      expect(metadata.totalEvents).toBe(3);
      expect(filterEventsToRange(eventsForRange(6, 10), { startLedger: 7, endLedger: 9 })).toHaveLength(3);
    });

    it("does not index events outside the requested range", async () => {
      const tracker = new LedgerRangeTracker();
      await tracker.processRange({
        startLedger: 20,
        endLedger: 22,
        events: [
          ...eventsForRange(18, 19),
          ...eventsForRange(20, 22),
          ...eventsForRange(23, 24),
        ],
      });
      expect(getLedgerRangeMetadata(18, 24).totalEvents).toBe(3);
      expect(getLedgerRangeMetadata(18, 19).totalEvents).toBe(0);
      expect(getLedgerRangeMetadata(23, 24).totalEvents).toBe(0);
    });

    it("paginates a custom range without processing past the requested end", async () => {
      const pages: Array<{ startLedger: number; endLedger: number }> = [];
      const tracker = new LedgerRangeTracker({ pageSize: 2 });
      const result = await tracker.processRange({
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
      expect(chunkLedgerRange({ startLedger: 10, endLedger: 15 }, 2)).toHaveLength(3);
      expect(DEFAULT_LEDGER_RANGE_PAGE_SIZE).toBe(100);
    });

    it("rejects an invalid start ledger", () => {
      expect(() => validateLedgerRange(0, 10)).toThrow(LedgerRangeValidationError);
      expect(() => validateLedgerRange(-1, 10)).toThrow(/start ledger must be a positive integer/);
      expect(() => validateLedgerRange(1.5, 10)).toThrow(LedgerRangeValidationError);
      expect(() => validateLedgerRange(NaN, 10)).toThrow(LedgerRangeValidationError);
    });

    it("rejects an invalid end ledger", () => {
      expect(() => validateLedgerRange(1, 0)).toThrow(/end ledger must be a positive integer/);
      expect(() => validateLedgerRange(1, Infinity)).toThrow(LedgerRangeValidationError);
    });

    it("rejects start > end", () => {
      expect(() => validateLedgerRange(20, 10)).toThrow(
        /start ledger must not exceed end ledger/
      );
    });

    it("fails processRange clearly for invalid combinations", async () => {
      const tracker = new LedgerRangeTracker();
      await expect(
        tracker.processRange({ startLedger: 9, endLedger: 3, events: [] })
      ).rejects.toThrow(LedgerRangeValidationError);
      expect(tracker.failureMonitor.getConsecutiveFailures()).toBe(0);
    });

    it("does not advance the live pointer during a historical import", async () => {
      setLastIndexedLedger(500);
      const tracker = new LedgerRangeTracker();
      await tracker.processRange({
        startLedger: 10,
        endLedger: 12,
        events: eventsForRange(10, 12),
      });
      expect(getLastIndexedLedger()).toBe(500);
      expect(getLedgerRangeMetadata(10, 12).totalEvents).toBe(3);
    });

    it("can optionally advance the live pointer for a live-compatible poll", async () => {
      setLastIndexedLedger(500);
      const tracker = new LedgerRangeTracker();
      await tracker.processRange({
        startLedger: 501,
        endLedger: 505,
        events: eventsForRange(501, 505),
        advanceLivePointer: true,
      });
      expect(getLastIndexedLedger()).toBe(505);
      expect(getLedgerRangeMetadata(501, 505).totalEvents).toBe(5);
    });
  });

  // -----------------------------------------------------------------------
  // #298 Failure / stall alerting
  // -----------------------------------------------------------------------

  describe("failure and stall alerting (#298)", () => {
    it("starts with zero consecutive failures and does not alert", async () => {
      const warn = jest.spyOn(logger, "warn");
      const tracker = new LedgerRangeTracker({ name: "alert-zero", failureThreshold: 3 });
      await tracker.processRange({
        startLedger: 1,
        endLedger: 1,
        events: eventsForRange(1, 1),
      });
      expect(tracker.failureMonitor.getConsecutiveFailures()).toBe(0);
      expect(
        calls(warn).filter(([msg]) =>
          String(msg).includes("consecutive failure threshold reached")
        )
      ).toHaveLength(0);
    });

    it("does not emit a threshold warning below the configured count", async () => {
      const warn = jest.spyOn(logger, "warn");
      const error = jest.spyOn(logger, "error");
      const tracker = new LedgerRangeTracker({ name: "alert-below", failureThreshold: 3 });

      await expect(
        tracker.processRange({
          startLedger: 1,
          endLedger: 2,
          fetchEvents: async () => {
            throw new Error("rpc down");
          },
        })
      ).rejects.toThrow("rpc down");
      await expect(
        tracker.processRange({
          startLedger: 1,
          endLedger: 2,
          fetchEvents: async () => {
            throw new Error("rpc down");
          },
        })
      ).rejects.toThrow("rpc down");

      expect(tracker.failureMonitor.getConsecutiveFailures()).toBe(2);
      expect(
        calls(warn).filter(([msg]) =>
          String(msg).includes("consecutive failure threshold reached")
        )
      ).toHaveLength(0);
      expect(
        calls(error).filter(([msg]) =>
          String(msg).includes("ledger_range_tracker operation failed")
        ).length
      ).toBe(2);
    });

    it("emits a warning exactly when the threshold is reached", async () => {
      const warn = jest.spyOn(logger, "warn");
      const tracker = new LedgerRangeTracker({ name: "alert-hit", failureThreshold: 3 });
      const fail = () =>
        tracker.processRange({
          startLedger: 8,
          endLedger: 9,
          fetchEvents: async () => {
            throw new Error("timeout");
          },
        });

      await expect(fail()).rejects.toThrow("timeout");
      await expect(fail()).rejects.toThrow("timeout");
      await expect(fail()).rejects.toThrow("timeout");

      const alerts = calls(warn).filter(([msg]) =>
        String(msg).includes("consecutive failure threshold reached")
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0][1]).toMatchObject({
        tracker: "alert-hit",
        failureType: "event_retrieval",
        consecutiveFailures: 3,
        threshold: 3,
        startLedger: 8,
        endLedger: 9,
        error: "timeout",
      });
      expect(String((alerts[0][1] as { action: string }).action)).toMatch(/Inspect/);
    });

    it("does not emit additional threshold alerts while already over the limit", async () => {
      const warn = jest.spyOn(logger, "warn");
      const tracker = new LedgerRangeTracker({ name: "alert-over", failureThreshold: 2 });
      const fail = () =>
        tracker.processRange({
          startLedger: 1,
          endLedger: 1,
          fetchEvents: async () => {
            throw new Error("boom");
          },
        });
      await expect(fail()).rejects.toThrow();
      await expect(fail()).rejects.toThrow();
      await expect(fail()).rejects.toThrow();
      expect(tracker.failureMonitor.getConsecutiveFailures()).toBe(3);
      expect(
        calls(warn).filter(([msg]) =>
          String(msg).includes("consecutive failure threshold reached")
        )
      ).toHaveLength(1);
    });

    it("resets the consecutive counter after a successful poll", async () => {
      const tracker = new LedgerRangeTracker({ name: "alert-reset", failureThreshold: 3 });
      await expect(
        tracker.processRange({
          startLedger: 1,
          endLedger: 1,
          fetchEvents: async () => {
            throw new Error("fail");
          },
        })
      ).rejects.toThrow("fail");
      expect(tracker.failureMonitor.getConsecutiveFailures()).toBe(1);

      await tracker.processRange({
        startLedger: 1,
        endLedger: 1,
        events: eventsForRange(1, 1),
      });
      expect(tracker.failureMonitor.getConsecutiveFailures()).toBe(0);
      expect(tracker.failureMonitor.isAlertActive()).toBe(false);
    });

    it("starts a new consecutive sequence after recovery", async () => {
      const warn = jest.spyOn(logger, "warn");
      const tracker = new LedgerRangeTracker({ name: "alert-again", failureThreshold: 2 });
      const fail = () =>
        tracker.processRange({
          startLedger: 3,
          endLedger: 3,
          fetchEvents: async () => {
            throw new Error("again");
          },
        });
      await expect(fail()).rejects.toThrow();
      await expect(fail()).rejects.toThrow();
      await tracker.processRange({
        startLedger: 3,
        endLedger: 3,
        events: eventsForRange(3, 3),
      });
      warn.mockClear();
      await expect(fail()).rejects.toThrow();
      expect(tracker.failureMonitor.getConsecutiveFailures()).toBe(1);
      expect(
        calls(warn).filter(([msg]) =>
          String(msg).includes("consecutive failure threshold reached")
        )
      ).toHaveLength(0);
      await expect(fail()).rejects.toThrow();
      expect(
        calls(warn).filter(([msg]) =>
          String(msg).includes("consecutive failure threshold reached")
        )
      ).toHaveLength(1);
    });

    it("keeps failure state independent across tracker instances", async () => {
      const a = new LedgerRangeTracker({ name: "tracker-a", failureThreshold: 3 });
      const b = new LedgerRangeTracker({ name: "tracker-b", failureThreshold: 3 });
      await expect(
        a.processRange({
          startLedger: 1,
          endLedger: 1,
          fetchEvents: async () => {
            throw new Error("a-fail");
          },
        })
      ).rejects.toThrow("a-fail");
      expect(a.failureMonitor.getConsecutiveFailures()).toBe(1);
      expect(b.failureMonitor.getConsecutiveFailures()).toBe(0);
    });

    it("emits a stall warning after the configured quiet period", async () => {
      const warn = jest.spyOn(logger, "warn");
      const tracker = new LedgerRangeTracker({
        name: "stall",
        stallThresholdMs: 1,
      });
      await tracker.processRange({
        startLedger: 1,
        endLedger: 1,
        events: eventsForRange(1, 1, "STALL"),
      });
      await new Promise((r) => setTimeout(r, 5));
      await tracker.processRange({
        startLedger: 2,
        endLedger: 2,
        events: eventsForRange(2, 2, "STALL"),
      });
      const stallAlerts = calls(warn).filter(([msg]) =>
        String(msg).includes("poller stall threshold reached")
      );
      expect(stallAlerts.length).toBeGreaterThanOrEqual(1);
      expect(stallAlerts[0][1]).toMatchObject({
        tracker: "stall",
        failureType: "stall",
      });
    });

    it("uses DEFAULT_LEDGER_RANGE_FAILURE_THRESHOLD of 3", () => {
      expect(DEFAULT_LEDGER_RANGE_FAILURE_THRESHOLD).toBe(3);
      expect(new LedgerRangeTracker().failureMonitor.failureThreshold).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // #296 Concurrency / duplicate inserts
  // -----------------------------------------------------------------------

  describe("concurrency protection (#296)", () => {
    it("indexes two concurrent identical notifications once", async () => {
      const tracker = new LedgerRangeTracker({ name: "dup-two" });
      const event = makeEvent({ ledgerSequence: 77, dataJson: JSON.stringify({ id: 77 }) });
      await Promise.all([
        tracker.indexEvents([event]),
        tracker.indexEvents([event]),
      ]);
      expect(getLedgerRangeMetadata(77, 77).totalEvents).toBe(1);
    });

    it("indexes many concurrent identical notifications once", async () => {
      const tracker = new LedgerRangeTracker({ name: "dup-many" });
      const event = makeEvent({
        contractId: "C-MANY",
        ledgerSequence: 88,
        eventType: "funded",
      });
      await Promise.all(Array.from({ length: 25 }, () => tracker.indexEvents([event])));
      expect(getLedgerRangeMetadata(88, 88).totalEvents).toBe(1);
    });

    it("handles overlapping ledger ranges without duplicate rows", async () => {
      const tracker = new LedgerRangeTracker({ name: "overlap" });
      const left = eventsForRange(10, 20, "C-O");
      const right = eventsForRange(15, 25, "C-O");
      await Promise.all([
        tracker.processRange({ startLedger: 10, endLedger: 20, events: left }),
        tracker.processRange({ startLedger: 15, endLedger: 25, events: right }),
      ]);
      expect(getLedgerRangeMetadata(10, 25).totalEvents).toBe(16);
    });

    it("indexes distinct concurrent events without dropping any", async () => {
      const tracker = new LedgerRangeTracker({ name: "distinct" });
      const a = makeEvent({ contractId: "CA", ledgerSequence: 1, eventType: "initialized" });
      const b = makeEvent({ contractId: "CB", ledgerSequence: 1, eventType: "funded" });
      await Promise.all([tracker.indexEvents([a]), tracker.indexEvents([b])]);
      expect(getLedgerRangeMetadata(1, 1).totalEvents).toBe(2);
    });

    it("lets unrelated event locks proceed while another key is held", async () => {
      let releaseSlow!: () => void;
      let slowStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        slowStarted = resolve;
      });
      const slow = withEventLock("slow-key", async () => {
        slowStarted();
        await new Promise<void>((resolve) => {
          releaseSlow = resolve;
        });
      });
      await started;
      expect(getHeldEventLockCount()).toBe(1);

      const order: string[] = [];
      await withEventLock("fast-key", () => {
        order.push("fast");
      });
      order.push("slow-still-held");
      expect(order).toEqual(["fast", "slow-still-held"]);
      releaseSlow();
      await slow;
      expect(getHeldEventLockCount()).toBe(0);
    });

    it("releases range locks after success", async () => {
      const tracker = new LedgerRangeTracker();
      await tracker.processRange({
        startLedger: 1,
        endLedger: 2,
        events: eventsForRange(1, 2),
      });
      expect(getHeldRangeLockCount()).toBe(0);
      expect(getHeldEventLockCount()).toBe(0);
    });

    it("releases locks after failure and does not block later work", async () => {
      const tracker = new LedgerRangeTracker({ name: "lock-fail" });
      await expect(
        tracker.processRange({
          startLedger: 30,
          endLedger: 31,
          fetchEvents: async () => {
            throw new Error("held then fail");
          },
        })
      ).rejects.toThrow("held then fail");
      expect(getHeldRangeLockCount()).toBe(0);
      expect(getHeldEventLockCount()).toBe(0);

      const result = await tracker.processRange({
        startLedger: 30,
        endLedger: 31,
        events: eventsForRange(30, 31, "AFTER-FAIL"),
      });
      expect(result.insertedCount).toBe(2);
    });

    it("releases an event lock after the locked operation throws", async () => {
      await expect(
        withEventLock("throw-key", () => {
          throw new Error("lock boom");
        })
      ).rejects.toThrow("lock boom");
      expect(getHeldEventLockCount()).toBe(0);
      await withEventLock("throw-key", () => "ok");
      expect(getHeldEventLockCount()).toBe(0);
    });

    it("releases overlapping range locks after failure", async () => {
      await expect(
        withOverlappingRangeLock({ startLedger: 1, endLedger: 5 }, async () => {
          throw new Error("range fail");
        })
      ).rejects.toThrow("range fail");
      expect(getHeldRangeLockCount()).toBe(0);
      await withOverlappingRangeLock({ startLedger: 1, endLedger: 5 }, () => 1);
      expect(getHeldRangeLockCount()).toBe(0);
    });

    it("keeps exactly one indexed row per unique event after mixed concurrent loads", async () => {
      const tracker = new LedgerRangeTracker({ name: "mixed" });
      const shared = makeEvent({ contractId: "MIX", ledgerSequence: 50, eventType: "delivered" });
      const other = makeEvent({ contractId: "MIX", ledgerSequence: 51, eventType: "approved" });
      await Promise.all([
        tracker.indexEvents([shared]),
        tracker.indexEvents([shared, other]),
        tracker.processRange({
          startLedger: 50,
          endLedger: 51,
          events: [shared, other],
        }),
      ]);
      expect(getLedgerRangeMetadata(50, 51).totalEvents).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // #297 Polling diagnostics
  // -----------------------------------------------------------------------

  describe("polling diagnostics (#297)", () => {
    it("emits started and success diagnostics with elapsed time", async () => {
      const debug = jest.spyOn(logger, "debug");
      const tracker = new LedgerRangeTracker({ name: "diag" });
      const result = await tracker.processRange({
        startLedger: 11,
        endLedger: 13,
        events: eventsForRange(11, 13, "DIAG"),
      });
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      const polls = calls(debug).filter(
        ([msg]) => String(msg) === "ledger_range_tracker poll diagnostics"
      );
      expect(polls.length).toBeGreaterThanOrEqual(2);
      const started = polls.find(([, meta]) => (meta as { status: string }).status === "started");
      const success = polls.find(([, meta]) => (meta as { status: string }).status === "success");
      expect(started?.[1]).toMatchObject({
        tracker: "diag",
        operation: "poll_ledger_range",
        elapsedMs: expect.any(Number),
      });
      expect(success?.[1]).toMatchObject({
        tracker: "diag",
        status: "success",
        startLedger: 11,
        endLedger: 13,
        eventCount: 3,
        payloadSizeBytes: expect.any(Number),
        elapsedMs: expect.any(Number),
      });
      expect((success?.[1] as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(0);
      expect((success?.[1] as { payloadSizeBytes: number }).payloadSizeBytes).toBeGreaterThan(0);
    });

    it("includes elapsed time on failure diagnostics", async () => {
      const debug = jest.spyOn(logger, "debug");
      const tracker = new LedgerRangeTracker({ name: "diag-fail" });
      await expect(
        tracker.processRange({
          startLedger: 1,
          endLedger: 4,
          fetchEvents: async () => {
            throw new Error("diag fail");
          },
        })
      ).rejects.toThrow("diag fail");
      const failure = calls(debug)
        .filter(([msg]) => String(msg) === "ledger_range_tracker poll diagnostics")
        .filter(([, meta]) => (meta as { status: string }).status === "failure");
      expect(failure.length).toBeGreaterThanOrEqual(1);
      expect(failure[failure.length - 1][1]).toMatchObject({
        tracker: "diag-fail",
        elapsedMs: expect.any(Number),
        error: "diag fail",
      });
      expect((failure[failure.length - 1][1] as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it("logs per-page diagnostics when fetching chunks", async () => {
      const debug = jest.spyOn(logger, "debug");
      const tracker = new LedgerRangeTracker({ name: "diag-pages", pageSize: 2 });
      await tracker.processRange({
        startLedger: 1,
        endLedger: 4,
        pageSize: 2,
        fetchEvents: (page) => eventsForRange(page.startLedger, page.endLedger, "PG"),
      });
      const pages = calls(debug).filter(
        ([, meta]) => (meta as { operation?: string }).operation === "poll_ledger_page"
      );
      expect(pages).toHaveLength(2);
      expect(pages[0][1]).toMatchObject({
        startLedger: 1,
        endLedger: 2,
        eventCount: 2,
        payloadSizeBytes: expect.any(Number),
        elapsedMs: expect.any(Number),
      });
    });

    it("does not change successful indexing when diagnostics are enabled", async () => {
      const tracker = new LedgerRangeTracker({ name: "diag-behavior" });
      const result = await tracker.processRange({
        startLedger: 100,
        endLedger: 102,
        events: eventsForRange(100, 102, "BEH"),
      });
      expect(result.status).toBe("success");
      expect(result.insertedCount).toBe(3);
      expect(getLedgerRangeMetadata(100, 102).totalEvents).toBe(3);
    });
  });

  describe("processLedgerRange default instance", () => {
    it("routes through the shared tracker flow", async () => {
      const result = await processLedgerRange({
        startLedger: 60,
        endLedger: 61,
        events: eventsForRange(60, 61, "DEF"),
      });
      expect(result.insertedCount).toBe(2);
    });
  });
});
