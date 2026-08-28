import { jest } from "@jest/globals";
import Database from "better-sqlite3";

// --- Mock the Stellar RPC Server so poller.ts never touches the network ---
const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetEvents = jest.fn<() => Promise<{ events: unknown[] }>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getLatestLedger = mockGetLatestLedger;
    getEvents = mockGetEvents;
  },
}));

jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  scValToNative: jest.fn(() => "initialized"),
}));

// Poller kicks off webhook delivery in the background on a successful poll;
// stub it out so tests aren't coupled to that unrelated concern.
jest.unstable_mockModule("../src/indexer/webhook-delivery.js", () => ({
  deliverWebhooks: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
}));

const {
  runMigrations,
  setDb,
  setLastIndexedLedger,
  registerContract,
} = await import("../src/indexer/db.js");
const { pollEvents, startPoller, stopPoller, getConsecutivePollFailures, resetConsecutivePollFailures } =
  await import("../src/indexer/poller.js");
const logger = (await import("../src/utils/logger.js")).default;

describe("poller", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
  });

  afterAll(() => {
    testDb.close();
  });

  beforeEach(() => {
    testDb.exec("DROP TABLE IF EXISTS events");
    testDb.exec("DROP TABLE IF EXISTS indexer_state");
    testDb.exec("DROP TABLE IF EXISTS monitored_contracts");
    testDb.exec("DROP TABLE IF EXISTS schema_migrations");
    testDb.exec("DROP TABLE IF EXISTS webhook_subscriptions");
    runMigrations();
    registerContract("CONTRACT-POLLER-TEST");
    setLastIndexedLedger(0);

    mockGetLatestLedger.mockReset();
    mockGetEvents.mockReset();
    mockGetEvents.mockResolvedValue({ events: [] });
    resetConsecutivePollFailures();
    stopPoller();

    jest.useFakeTimers();
  });

  afterEach(() => {
    stopPoller();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------
  // RPC connection backoff (ledger_range_tracker + duplicate_prevention)
  // ---------------------------------------------------------------------

  describe("RPC connection backoff", () => {
    it("retries getLatestLedger with increasing delay on connection dropouts, then succeeds", async () => {
      const warnSpy = jest.spyOn(logger, "warn");

      mockGetLatestLedger
        .mockRejectedValueOnce(new Error("ETIMEDOUT"))
        .mockRejectedValueOnce(new Error("ETIMEDOUT"))
        .mockResolvedValueOnce({ sequence: 100 });

      const pollPromise = pollEvents();

      for (let i = 0; i < 5; i++) {
        await jest.advanceTimersByTimeAsync(100000);
      }
      await pollPromise;

      expect(mockGetLatestLedger).toHaveBeenCalledTimes(3);

      const delays = (warnSpy.mock.calls as unknown as Array<[string, { delayMs: number }]>)
        .filter(([msg]) => msg === "RPC call failed, retrying with exponential backoff")
        .map(([, meta]) => meta.delayMs);

      expect(delays.length).toBe(2);
      expect(delays[1]).toBeGreaterThan(delays[0]);
    });

    it("retries getEvents on connection dropouts up to the max attempts, then gives up", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
      mockGetEvents.mockRejectedValue(new Error("connection dropout"));

      const errorSpy = jest.spyOn(logger, "error");

      const pollPromise = pollEvents();
      for (let i = 0; i < 6; i++) {
        await jest.advanceTimersByTimeAsync(100000);
      }
      await pollPromise;

      // Default withRpcBackoff maxAttempts is 5
      expect(mockGetEvents).toHaveBeenCalledTimes(5);
      expect(errorSpy).toHaveBeenCalledWith(
        "Error polling events",
        expect.objectContaining({ consecutiveFailures: 1 })
      );
    });

    it("does not retry when the RPC call succeeds on the first attempt", async () => {
      mockGetLatestLedger.mockResolvedValueOnce({ sequence: 0 });

      await pollEvents();

      expect(mockGetLatestLedger).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------
  // Threshold warning alerts
  // ---------------------------------------------------------------------

  describe("consecutive-failure threshold alerts", () => {
    const originalThreshold = process.env.POLL_FAILURE_ALERT_THRESHOLD;

    beforeEach(() => {
      process.env.POLL_FAILURE_ALERT_THRESHOLD = "3";
    });

    afterEach(() => {
      if (originalThreshold === undefined) {
        delete process.env.POLL_FAILURE_ALERT_THRESHOLD;
      } else {
        process.env.POLL_FAILURE_ALERT_THRESHOLD = originalThreshold;
      }
    });

    it("does not trigger before the configured consecutive error count is reached", async () => {
      // NOTE: POLL_FAILURE_ALERT_THRESHOLD is read once at module load, so
      // this asserts against the module's actual configured threshold
      // (default 5) rather than the env var set above.
      mockGetLatestLedger.mockRejectedValue(new Error("down"));
      const warnSpy = jest.spyOn(logger, "warn");

      for (let i = 0; i < 4; i++) {
        const p = pollEvents();
        for (let j = 0; j < 6; j++) {
          await jest.advanceTimersByTimeAsync(100000);
        }
        await p;
      }

      expect(getConsecutivePollFailures()).toBe(4);
      const thresholdWarnings = (warnSpy.mock.calls as unknown as Array<[string]>).filter(
        ([msg]) => msg === "Indexer poll failure threshold reached"
      );
      expect(thresholdWarnings.length).toBe(0);
    });

    it("triggers once the configured consecutive error count is reached", async () => {
      mockGetLatestLedger.mockRejectedValue(new Error("down"));
      const warnSpy = jest.spyOn(logger, "warn");

      for (let i = 0; i < 5; i++) {
        const p = pollEvents();
        for (let j = 0; j < 6; j++) {
          await jest.advanceTimersByTimeAsync(100000);
        }
        await p;
      }

      expect(getConsecutivePollFailures()).toBe(5);
      const thresholdWarnings = (warnSpy.mock.calls as unknown as Array<[string]>).filter(
        ([msg]) => msg === "Indexer poll failure threshold reached"
      );
      expect(thresholdWarnings.length).toBeGreaterThan(0);
    });

    it("resets the consecutive failure count after a successful poll", async () => {
      mockGetLatestLedger.mockRejectedValue(new Error("down"));

      for (let i = 0; i < 2; i++) {
        const p = pollEvents();
        for (let j = 0; j < 6; j++) {
          await jest.advanceTimersByTimeAsync(100000);
        }
        await p;
      }
      expect(getConsecutivePollFailures()).toBe(2);

      mockGetLatestLedger.mockReset();
      mockGetLatestLedger.mockResolvedValue({ sequence: 0 });

      await pollEvents();

      expect(getConsecutivePollFailures()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // Startup schema validation
  // ---------------------------------------------------------------------

  describe("startup schema validation guard", () => {
    it("startPoller() aborts and does not begin polling if the schema is out of sync", () => {
      testDb.exec("DROP TABLE schema_migrations");

      expect(() => startPoller()).toThrow(/schema_migrations table does not exist/);
      expect(mockGetLatestLedger).not.toHaveBeenCalled();
    });

    it("startPoller() begins polling when the schema is valid", () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 0 });

      expect(() => startPoller()).not.toThrow();
    });
  });
});
