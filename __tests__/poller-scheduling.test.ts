import { jest } from "@jest/globals";
import Database from "better-sqlite3";

/**
 * The parts of the indexer that decide whether and when to poll (issue #673):
 * the CONTRACT_ID fallback, the empty-config early return, the start/stop
 * scheduling of the poll loop, the indexer_runner failure/stall alerts and
 * transaction wrapper, and the uptime helpers in status.ts.
 */

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

const { pollEvents, startPoller, stopPoller, getCurrentPollIntervalMs, resetFailureState } =
  await import("../src/indexer/poller.js");
const { setDb, runMigrations, getActiveContractIds } = await import("../src/indexer/db.js");
const {
  IndexerRunnerFailureMonitor,
  runIndexerCycleInTransaction,
  withIndexerRunnerTransaction,
  payloadSizeBytes,
  logIndexerRunnerPollDiagnostics,
} = await import("../src/indexer/indexer_runner.js");
const { markIndexerStarted, getIndexerUptimeSeconds } = await import("../src/indexer/status.js");
const { default: logger } = await import("../src/utils/logger.js");

const ENV_CONTRACT = "CENVFALLBACKCONTRACT";
const ORIGINAL_CONTRACT_ID = process.env.CONTRACT_ID;

let testDb: Database.Database;

beforeAll(() => {
  testDb = new Database(":memory:");
  setDb(testDb);
  runMigrations();
});

afterAll(() => {
  stopPoller();
  testDb.close();
  if (ORIGINAL_CONTRACT_ID === undefined) delete process.env.CONTRACT_ID;
  else process.env.CONTRACT_ID = ORIGINAL_CONTRACT_ID;
});

beforeEach(() => {
  stopPoller();
  resetFailureState();
  testDb.exec("DELETE FROM events");
  testDb.exec("DELETE FROM monitored_contracts");
  testDb.exec("UPDATE indexer_state SET value = '0' WHERE key = 'last_ledger_sequence'");
  delete process.env.CONTRACT_ID;
  mockGetLatestLedger.mockReset();
  mockGetEvents.mockReset();
  mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
  mockGetEvents.mockResolvedValue({ events: [] });
});

afterEach(() => {
  stopPoller();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Contract fallback and empty config
// ---------------------------------------------------------------------------

describe("pollEvents() contract resolution", () => {
  it("registers CONTRACT_ID when monitored_contracts is empty, then polls it", async () => {
    process.env.CONTRACT_ID = ENV_CONTRACT;
    expect(getActiveContractIds()).toEqual([]);

    await pollEvents();

    expect(getActiveContractIds()).toEqual([ENV_CONTRACT]);
    expect(mockGetLatestLedger).toHaveBeenCalled();
    expect(mockGetEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [expect.objectContaining({ contractIds: [ENV_CONTRACT] })],
      }),
    );
  });

  it("returns false and makes no RPC calls when nothing is configured", async () => {
    await expect(pollEvents()).resolves.toBe(false);
    expect(mockGetLatestLedger).not.toHaveBeenCalled();
    expect(mockGetEvents).not.toHaveBeenCalled();
    expect(getActiveContractIds()).toEqual([]);
  });

  it("records a failure instead of rejecting when contract DB reads throw (#689)", async () => {
    const { getConsecutiveFailures } = await import("../src/indexer/poller.js");
    const db = await import("../src/indexer/db.js");

    // Point the DB at a closed handle so getActiveContractIds throws
    // (SQLITE_MISUSE) inside pollEvents' try block.
    const brokenDb = new Database(":memory:");
    brokenDb.close();
    db.setDb(brokenDb as any);

    await expect(pollEvents()).resolves.toBe(false);
    expect(getConsecutiveFailures()).toBeGreaterThanOrEqual(1);

    // Restore a working DB so the next cycle runs.
    db.setDb(testDb);
    mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
    mockGetEvents.mockResolvedValue({ events: [] });
    process.env.CONTRACT_ID = ENV_CONTRACT;
    await expect(pollEvents()).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Loop scheduling
// ---------------------------------------------------------------------------

/** Let pending promise callbacks run without advancing fake time. */
async function flushPromises(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("startPoller() / stopPoller() scheduling", () => {
  beforeEach(() => {
    process.env.CONTRACT_ID = ENV_CONTRACT;
  });

  it("runs the first cycle immediately and the next after the computed interval", async () => {
    jest.useFakeTimers();

    startPoller();
    await flushPromises();

    // First cycle ran without waiting for any timer.
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(1);

    // Nothing more happens before the interval elapses...
    const interval = getCurrentPollIntervalMs();
    jest.advanceTimersByTime(interval - 1);
    await flushPromises();
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(1);

    // ...and the second cycle runs once it does.
    jest.advanceTimersByTime(1);
    await flushPromises();
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(2);
  });

  it("calling startPoller() twice does not start a second loop", async () => {
    jest.useFakeTimers();
    startPoller();
    startPoller();
    await flushPromises();
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(1);

    // One loop means one cycle per interval, not two.
    jest.advanceTimersByTime(getCurrentPollIntervalMs());
    await flushPromises();
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(2);
  });

  it("stopPoller() during an in-flight cycle prevents rescheduling", async () => {
    jest.useFakeTimers();
    let release!: (v: { sequence: number }) => void;
    mockGetLatestLedger.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    startPoller();
    await flushPromises();
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(1);

    const setTimeoutSpy = jest.spyOn(global, "setTimeout");
    stopPoller();
    release({ sequence: 100 });
    await flushPromises();

    // The finished cycle must not schedule the next loop iteration.
    const loopTimers = setTimeoutSpy.mock.calls.filter(
      ([, ms]) => ms === getCurrentPollIntervalMs(),
    );
    expect(loopTimers).toHaveLength(0);
    jest.advanceTimersByTime(10 * 60_000);
    await flushPromises();
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(1);
  });

  it("stopPoller() between cycles clears the pending timer", async () => {
    jest.useFakeTimers();
    startPoller();
    await flushPromises();
    const pending = jest.getTimerCount();

    stopPoller();
    expect(jest.getTimerCount()).toBe(pending - 1);
    jest.advanceTimersByTime(10 * 60_000);
    await flushPromises();
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// indexer_runner failure / stall alerts
// ---------------------------------------------------------------------------

describe("IndexerRunnerFailureMonitor", () => {
  it("alerts once when the failure threshold is reached, and re-arms after success", () => {
    const warn = jest.spyOn(logger, "warn");
    const monitor = new IndexerRunnerFailureMonitor({ name: "t", failureThreshold: 3 });
    const alerts = () =>
      warn.mock.calls.filter(([msg]) => String(msg).includes("consecutive failure threshold"));

    monitor.recordFailure("rpc", { error: "boom" });
    monitor.recordFailure("rpc");
    expect(alerts()).toHaveLength(0);
    expect(monitor.isAlertActive()).toBe(false);

    expect(monitor.recordFailure("rpc")).toBe(3);
    monitor.recordFailure("rpc");
    monitor.recordFailure("rpc");
    expect(alerts()).toHaveLength(1);
    expect(monitor.isAlertActive()).toBe(true);
    expect(monitor.getFailureThreshold()).toBe(3);

    monitor.recordSuccess();
    expect(monitor.getConsecutiveFailures()).toBe(0);
    expect(monitor.isAlertActive()).toBe(false);
    for (let i = 0; i < 3; i++) monitor.recordFailure("rpc");
    expect(alerts()).toHaveLength(2);
  });

  it("logs a stall alert once per episode after the stall window passes", () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(logger, "warn");
    const monitor = new IndexerRunnerFailureMonitor({ stallThresholdMs: 1_000 });
    const stalls = () => warn.mock.calls.filter(([msg]) => String(msg).includes("stall detected"));

    // No success yet: nothing to measure a stall against.
    monitor.checkStall();
    expect(stalls()).toHaveLength(0);

    monitor.recordSuccess();
    jest.advanceTimersByTime(1_000);
    monitor.checkStall();
    expect(stalls()).toHaveLength(0);

    jest.advanceTimersByTime(1);
    monitor.checkStall();
    monitor.checkStall();
    expect(stalls()).toHaveLength(1);

    monitor.reset();
    expect(monitor.getLastSuccessfulAt()).toBeNull();
    expect(monitor.getConsecutiveFailures()).toBe(0);
  });

  it("uses documented defaults when constructed without options", () => {
    const monitor = new IndexerRunnerFailureMonitor();
    expect(monitor.getFailureThreshold()).toBe(3);
    expect(monitor.stallThresholdMs).toBe(120_000);
  });
});

// ---------------------------------------------------------------------------
// indexer_runner transaction wrapper and diagnostics
// ---------------------------------------------------------------------------

describe("indexer_runner transactions and diagnostics", () => {
  it("commits the operation and returns its result", () => {
    const result = runIndexerCycleInTransaction("test_cycle", () => {
      testDb.prepare("INSERT INTO monitored_contracts (contract_id) VALUES (?)").run("CTX-OK");
      return 42;
    });
    expect(result).toBe(42);
    expect(getActiveContractIds()).toContain("CTX-OK");
  });

  it("rolls back every write and rethrows when the operation fails", () => {
    const warn = jest.spyOn(logger, "warn");
    expect(() =>
      runIndexerCycleInTransaction("test_cycle", () => {
        testDb.prepare("INSERT INTO monitored_contracts (contract_id) VALUES (?)").run("CTX-BAD");
        throw new Error("mid-cycle crash");
      }),
    ).toThrow("mid-cycle crash");
    expect(getActiveContractIds()).not.toContain("CTX-BAD");
    expect(warn).toHaveBeenCalledWith(
      "indexer_runner transaction: rolled back",
      expect.objectContaining({ cycleLabel: "test_cycle", error: "mid-cycle crash" }),
    );
  });

  it("reports non-Error throws as strings when rolling back", () => {
    const warn = jest.spyOn(logger, "warn");
    expect(() =>
      withIndexerRunnerTransaction(() => {
        throw "plain failure";
      }),
    ).toThrow();
    expect(() =>
      runIndexerCycleInTransaction("str", () => {
        throw "plain failure";
      }),
    ).toThrow();
    expect(warn).toHaveBeenCalledWith(
      "indexer_runner transaction: rolled back",
      expect.objectContaining({ error: "plain failure" }),
    );
  });

  it("measures payload size in UTF-8 bytes and logs diagnostics at debug level", () => {
    expect(payloadSizeBytes({ a: "é" })).toBe(Buffer.byteLength('{"a":"é"}', "utf8"));
    expect(payloadSizeBytes(undefined)).toBe(4); // "null"

    const debug = jest.spyOn(logger, "debug");
    logIndexerRunnerPollDiagnostics({ operation: "poll", status: "success", elapsedMs: 12 });
    expect(debug).toHaveBeenCalledWith(
      "indexer_runner poll diagnostics",
      expect.objectContaining({ operation: "poll", status: "success", elapsedMs: 12 }),
    );
  });
});

// ---------------------------------------------------------------------------
// status.ts
// ---------------------------------------------------------------------------

describe("indexer status uptime", () => {
  it("is 0 before start, counts whole seconds after, and ignores repeat starts", () => {
    jest.useFakeTimers();
    expect(getIndexerUptimeSeconds()).toBe(0);

    markIndexerStarted();
    expect(getIndexerUptimeSeconds()).toBe(0);

    jest.advanceTimersByTime(2_500);
    expect(getIndexerUptimeSeconds()).toBe(2);

    // A second call must not reset the start time.
    markIndexerStarted();
    jest.advanceTimersByTime(1_000);
    expect(getIndexerUptimeSeconds()).toBe(3);
  });
});
