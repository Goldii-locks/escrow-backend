import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import {
  setDb,
  runMigrations,
  setLastIndexedLedger,
  getLastIndexedLedger,
  registerContract,
  getEventsByContract,
  getIndexerStateValue,
} from "../src/indexer/db.js";

const mockLogger = {
  info: jest.fn<(...args: any[]) => void>(),
  warn: jest.fn<(...args: any[]) => void>(),
  error: jest.fn<(...args: any[]) => void>(),
  debug: jest.fn<(...args: any[]) => void>(),
};

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: mockLogger,
}));

jest.unstable_mockModule("../src/indexer/webhook-delivery.js", () => ({
  deliverWebhooks: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetEvents = jest.fn<
  (opts?: unknown) => Promise<{ events: any[] }>
>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: jest.fn().mockImplementation(() => ({
    getLatestLedger: mockGetLatestLedger,
    getEvents: mockGetEvents,
  })),
}));

jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  scValToNative: (val: unknown) => val,
}));

const {
  pollEvents,
  resetFailureState,
  runConfiguredHistoricalBackfill,
  historicalBackfillStateKey,
  startPoller,
  stopPoller,
} = await import("../src/indexer/poller.js");
const { resetLedgerRangeTrackerState, getLedgerRangeMetadata } = await import(
  "../src/indexer/ledger-range-tracker.js"
);

function rpcEvent(ledger: number, eventType = "initialized", contractId = "C1") {
  return {
    contractId: { contractId: () => contractId },
    topic: [eventType],
    ledger,
    ledgerClosedAt: new Date(1_700_000_000_000 + ledger * 1000).toISOString(),
    value: { ledger },
  };
}

describe("indexer_runner dynamic historical sync ranges (#254)", () => {
  let testDb: Database.Database;
  const envKeys = [
    "LEDGER_RANGE_START",
    "LEDGER_RANGE_END",
    "LEDGER_RANGE_PAGE_SIZE",
    "CONTRACT_ID",
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
    registerContract("C1", "test");
    setLastIndexedLedger(100);
    resetFailureState();
    resetLedgerRangeTrackerState();
    jest.clearAllMocks();
    mockGetLatestLedger.mockResolvedValue({ sequence: 500 });
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }
  });

  /** Serves rpcEvent()s for [startLedger, 14] on a ledger-window request. */
  function serveRange10to14(): void {
    mockGetEvents.mockImplementation(async (opts: any) => {
      const start = opts.startLedger as number;
      const events = [];
      for (let ledger = start; ledger <= 14 && events.length < 100; ledger++) {
        events.push(rpcEvent(ledger));
      }
      return { events };
    });
  }

  it("indexes the configured start/end range with correct event counts", async () => {
    process.env.LEDGER_RANGE_START = "10";
    process.env.LEDGER_RANGE_END = "14";
    serveRange10to14();

    const outcome = await runConfiguredHistoricalBackfill();

    expect(outcome.status).toBe("completed");
    expect(outcome.result).toEqual({ eventsFound: 5, eventsImported: 5 });
    expect(getLedgerRangeMetadata(10, 14).totalEvents).toBe(5);
    expect(getEventsByContract("C1", 1, 100).total).toBe(5);
    // Historical import must not advance the live pointer
    expect(getLastIndexedLedger()).toBe(100);
  });

  it("uses inclusive boundaries and ignores events past endLedger", async () => {
    process.env.LEDGER_RANGE_START = "20";
    process.env.LEDGER_RANGE_END = "22";

    mockGetEvents.mockResolvedValue({
      events: [
        rpcEvent(19, "funded"),
        rpcEvent(20, "funded"),
        rpcEvent(21, "funded"),
        rpcEvent(22, "funded"),
        rpcEvent(23, "funded"),
      ],
    });

    await runConfiguredHistoricalBackfill();

    expect(getLedgerRangeMetadata(20, 22).totalEvents).toBe(3);
    expect(getLedgerRangeMetadata(19, 19).totalEvents).toBe(0);
    expect(getLedgerRangeMetadata(23, 23).totalEvents).toBe(0);
    expect(getLastIndexedLedger()).toBe(100);
  });

  describe("run-once backfill (#675)", () => {
    it("imports the configured range exactly once and records it in indexer_state", async () => {
      process.env.LEDGER_RANGE_START = "10";
      process.env.LEDGER_RANGE_END = "14";
      serveRange10to14();

      const first = await runConfiguredHistoricalBackfill();
      const callsAfterFirst = mockGetEvents.mock.calls.length;
      const second = await runConfiguredHistoricalBackfill();

      expect(first.status).toBe("completed");
      expect(second.status).toBe("already_complete");
      expect(mockGetEvents.mock.calls.length).toBe(callsAfterFirst);
      expect(getEventsByContract("C1", 1, 100).total).toBe(5);

      const recorded = JSON.parse(getIndexerStateValue(historicalBackfillStateKey(10, 14))!);
      expect(recorded).toMatchObject({ eventsFound: 5, eventsImported: 5 });
      expect(typeof recorded.completedAt).toBe("string");
    });

    it("shares one import between concurrent callers", async () => {
      process.env.LEDGER_RANGE_START = "10";
      process.env.LEDGER_RANGE_END = "14";
      serveRange10to14();

      const [a, b] = await Promise.all([
        runConfiguredHistoricalBackfill(),
        runConfiguredHistoricalBackfill(),
      ]);

      expect(a).toBe(b);
      expect(mockGetEvents).toHaveBeenCalledTimes(1);
    });

    it("does not record a failed import, so the next run retries it", async () => {
      process.env.LEDGER_RANGE_START = "10";
      process.env.LEDGER_RANGE_END = "14";
      // endLedger beyond the chain head fails validation.
      mockGetLatestLedger.mockResolvedValue({ sequence: 12 });

      const failed = await runConfiguredHistoricalBackfill();
      expect(failed.status).toBe("failed");
      expect(getIndexerStateValue(historicalBackfillStateKey(10, 14))).toBeUndefined();

      mockGetLatestLedger.mockResolvedValue({ sequence: 500 });
      serveRange10to14();
      const retried = await runConfiguredHistoricalBackfill();
      expect(retried.status).toBe("completed");
    });

    it("treats a different range as a new backfill", async () => {
      process.env.LEDGER_RANGE_START = "10";
      process.env.LEDGER_RANGE_END = "14";
      serveRange10to14();
      await runConfiguredHistoricalBackfill();

      process.env.LEDGER_RANGE_START = "10";
      process.env.LEDGER_RANGE_END = "12";
      const outcome = await runConfiguredHistoricalBackfill();
      expect(outcome.status).toBe("completed");
    });

    it("reports not_configured when no range env is set", async () => {
      expect((await runConfiguredHistoricalBackfill()).status).toBe("not_configured");
      expect(mockGetEvents).not.toHaveBeenCalled();
    });

    it("keeps pollEvents on the live pointer while a range is configured", async () => {
      process.env.LEDGER_RANGE_START = "10";
      process.env.LEDGER_RANGE_END = "14";
      mockGetEvents.mockResolvedValue({ events: [rpcEvent(101)] });

      const advanced = await pollEvents();

      expect(advanced).toBe(true);
      expect(mockGetEvents).toHaveBeenCalledTimes(1);
      expect(mockGetEvents).toHaveBeenCalledWith(
        expect.objectContaining({ startLedger: 101 }),
      );
      expect(getLastIndexedLedger()).toBe(500);
    });

    it("startPoller backfills once, then resumes live polling from the live pointer", async () => {
      process.env.LEDGER_RANGE_START = "10";
      process.env.LEDGER_RANGE_END = "14";
      serveRange10to14();

      try {
        startPoller();
        // Wait for the backfill and the first live cycle to complete.
        for (let i = 0; i < 50 && getLastIndexedLedger() !== 500; i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      } finally {
        stopPoller();
      }

      const ledgerRequests = mockGetEvents.mock.calls
        .map(([opts]) => (opts as { startLedger?: number }).startLedger)
        .filter((start) => start !== undefined);
      // One historical window request, then live polling from pointer + 1.
      expect(ledgerRequests).toEqual([10, 101]);
      expect(getIndexerStateValue(historicalBackfillStateKey(10, 14))).toBeDefined();
      expect(getLastIndexedLedger()).toBe(500);
    });
  });

  it("falls back to live polling when no historical range env is set", async () => {
    mockGetEvents.mockResolvedValue({
      events: [rpcEvent(101)],
    });

    const advanced = await pollEvents();

    expect(advanced).toBe(true);
    expect(mockGetEvents).toHaveBeenCalledWith(
      expect.objectContaining({ startLedger: 101 }),
    );
    expect(getLastIndexedLedger()).toBe(500);
    expect(getLedgerRangeMetadata(101, 500).totalEvents).toBe(1);
  });
});
