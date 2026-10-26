import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";

const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetEvents = jest.fn<() => Promise<{ events: unknown[] }>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getLatestLedger = mockGetLatestLedger;
    getEvents = mockGetEvents;
  },
}));

jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  scValToNative: (value: unknown) => value,
}));

const { startPoller, stopPoller } = await import("../src/indexer/poller.js");
const { setDb, runMigrations, registerContract } = await import("../src/indexer/db.js");
const { default: logger } = await import("../src/utils/logger.js");

describe("Poller scheduled delay vs logged pollIntervalMs (#639)", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
    runMigrations();
  });

  afterAll(() => {
    stopPoller();
    testDb.close();
  });

  beforeEach(() => {
    testDb.exec("DELETE FROM events");
    testDb.exec("DELETE FROM monitored_contracts");
    testDb.exec("UPDATE indexer_state SET value = '0' WHERE key = 'last_ledger_sequence'");
    registerContract("CONTRACT-LOG-MATCH", "log-match-test");
    mockGetLatestLedger.mockReset();
    mockGetEvents.mockReset();
    stopPoller();
  });

  afterEach(() => {
    stopPoller();
    jest.useRealTimers();
  });

  it("asserts the logged pollIntervalMs equals the delay passed to setTimeout using fake timers", async () => {
    jest.useFakeTimers();
    mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
    mockGetEvents.mockResolvedValue({ events: [] });

    const setTimeoutSpy = jest.spyOn(globalThis, "setTimeout");
    const infoSpy = jest.spyOn(logger, "info");

    startPoller();
    await jest.advanceTimersByTimeAsync(0);

    // logger.info is typed with winston's overloads; read the calls loosely.
    const calls = infoSpy.mock.calls as unknown as Array<[unknown, unknown]>;
    const pollLog = calls.find((call) => call[0] === "Processed indexer poll");
    expect(pollLog).toBeDefined();
    const loggedInterval = (pollLog?.[1] as { pollIntervalMs: number } | undefined)
      ?.pollIntervalMs;
    expect(typeof loggedInterval).toBe("number");

    const timerCall = setTimeoutSpy.mock.calls.find(
      ([fn, delay]) => typeof fn === "function" && delay === loggedInterval
    );
    expect(timerCall).toBeDefined();
    expect(timerCall?.[1]).toBe(loggedInterval);

    setTimeoutSpy.mockRestore();
    infoSpy.mockRestore();
  });
});
