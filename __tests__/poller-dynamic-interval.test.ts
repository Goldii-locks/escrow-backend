import { jest } from "@jest/globals";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Mock the Stellar RPC server before importing the poller, following the
// same jest.unstable_mockModule convention used in build-tx.test.ts.
// ---------------------------------------------------------------------------

const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetEvents = jest.fn<() => Promise<{ events: unknown[] }>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getLatestLedger = mockGetLatestLedger;
    getEvents = mockGetEvents;
  },
}));

// scValToNative is only used to decode event.topic[0] into an event type
// string; for these tests topic[0] is already a plain string, so an identity
// stub is sufficient.
jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  scValToNative: (value: unknown) => value,
}));

const {
  pollEvents,
  nextPollIntervalMs,
  getCurrentPollIntervalMs,
  startPoller,
  stopPoller,
} = await import("../src/indexer/poller.js");

const { setDb, runMigrations, registerContract, getLastIndexedLedger } =
  await import("../src/indexer/db.js");

describe("Dynamic polling interval — duplicate_prevention (poller)", () => {
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
    testDb.exec("DELETE FROM monitored_contracts");
    testDb.exec("UPDATE indexer_state SET value = '0' WHERE key = 'last_ledger_sequence'");
    registerContract("CONTRACT-POLL-TEST", "poll-test");
    mockGetLatestLedger.mockReset();
    mockGetEvents.mockReset();
    stopPoller();
  });

  afterEach(() => {
    stopPoller();
  });

  // ---------------------------------------------------------------------
  // Pure backoff/reset function
  // ---------------------------------------------------------------------

  describe("nextPollIntervalMs()", () => {
    it("increases the interval on consecutive idle polls", () => {
      const base = 15000;
      const afterOneIdle = nextPollIntervalMs(base, false);
      const afterTwoIdle = nextPollIntervalMs(afterOneIdle, false);

      expect(afterOneIdle).toBeGreaterThan(base);
      expect(afterTwoIdle).toBeGreaterThan(afterOneIdle);
    });

    it("caps the backoff at POLL_INTERVAL_MAX_MS instead of growing unbounded", () => {
      let interval = 15000;
      for (let i = 0; i < 50; i++) {
        interval = nextPollIntervalMs(interval, false);
      }
      // Default max is 120000ms - must never exceed it, no matter how many
      // consecutive idle polls occur.
      expect(interval).toBeLessThanOrEqual(120000);

      const again = nextPollIntervalMs(interval, false);
      expect(again).toBe(interval); // stays capped, does not keep climbing
    });

    it("resets immediately back to the minimum once activity resumes", () => {
      let interval = 15000;
      for (let i = 0; i < 10; i++) {
        interval = nextPollIntervalMs(interval, false);
      }
      expect(interval).toBeGreaterThan(15000);

      const resumed = nextPollIntervalMs(interval, true);
      expect(resumed).toBe(15000);
    });
  });

  // ---------------------------------------------------------------------
  // pollEvents() activity signal
  // ---------------------------------------------------------------------

  describe("pollEvents() activity signal", () => {
    it("reports no activity when the ledger has not advanced (idle network)", async () => {
      testDb.exec("UPDATE indexer_state SET value = '500' WHERE key = 'last_ledger_sequence'");
      mockGetLatestLedger.mockResolvedValue({ sequence: 500 });

      const hadActivity = await pollEvents();

      expect(hadActivity).toBe(false);
      expect(mockGetEvents).not.toHaveBeenCalled();
    });

    it("reports activity when a new ledger has closed, even with zero matching events", async () => {
      testDb.exec("UPDATE indexer_state SET value = '500' WHERE key = 'last_ledger_sequence'");
      mockGetLatestLedger.mockResolvedValue({ sequence: 501 });
      mockGetEvents.mockResolvedValue({ events: [] });

      const hadActivity = await pollEvents();

      expect(hadActivity).toBe(true);
      expect(getLastIndexedLedger()).toBe(501);
    });

    it("reports no activity when the poll errors (fail-safe backoff)", async () => {
      testDb.exec("UPDATE indexer_state SET value = '500' WHERE key = 'last_ledger_sequence'");
      mockGetLatestLedger.mockRejectedValue(new Error("RPC unavailable"));

      const hadActivity = await pollEvents();

      expect(hadActivity).toBe(false);
    });
  });

  // ---------------------------------------------------------------------
  // End-to-end: startPoller() drives the interval up during an idle
  // stretch and back down the moment load resumes.
  // ---------------------------------------------------------------------

  describe("startPoller() end-to-end interval behaviour", () => {
    it("increases wait delays while idle, then decreases back down once load resumes", async () => {
      testDb.exec("UPDATE indexer_state SET value = '1000' WHERE key = 'last_ledger_sequence'");

      jest.useFakeTimers();
      try {
        // Ledger not advancing -> every poll is idle.
        mockGetLatestLedger.mockResolvedValue({ sequence: 1000 });

        startPoller();
        await jest.advanceTimersByTimeAsync(0); // let the first (immediate) poll resolve

        const afterFirstPoll = getCurrentPollIntervalMs();
        expect(afterFirstPoll).toBeGreaterThan(15000); // backed off after one idle poll

        await jest.advanceTimersByTimeAsync(afterFirstPoll);
        const afterSecondPoll = getCurrentPollIntervalMs();
        expect(afterSecondPoll).toBeGreaterThan(afterFirstPoll); // keeps increasing while idle

        // Load resumes: ledger advances again.
        mockGetLatestLedger.mockResolvedValue({ sequence: 1001 });
        mockGetEvents.mockResolvedValue({ events: [] });

        await jest.advanceTimersByTimeAsync(afterSecondPoll);
        const afterResume = getCurrentPollIntervalMs();

        expect(afterResume).toBe(15000); // reset to the minimum
        expect(afterResume).toBeLessThan(afterSecondPoll); // decreased back down
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
