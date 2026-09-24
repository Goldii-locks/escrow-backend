import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import { setDb, runMigrations, registerContract } from "../src/indexer/db.js";

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
const mockGetEvents = jest.fn<() => Promise<{ events: any[] }>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: jest.fn().mockImplementation(() => ({
    getLatestLedger: mockGetLatestLedger,
    getEvents: mockGetEvents,
  })),
}));

jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  scValToNative: (val: unknown) => val,
}));

const { pollEvents, resetFailureState } = await import("../src/indexer/poller.js");
const {
  adjustIndexerRunnerPollInterval,
  getIndexerRunnerPollDelayMs,
  getIndexerRunnerThrottleState,
  getIndexerRunnerThrottleParameters,
  resetIndexerRunnerThrottleState,
} = await import("../src/indexer/indexer_runner.js");

describe("indexer_runner dynamic poll throttling (#256)", () => {
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
    resetFailureState();
    resetIndexerRunnerThrottleState();
    jest.clearAllMocks();
    testDb.exec("DELETE FROM events");
    testDb.exec("DELETE FROM monitored_contracts");
    testDb.exec(
      "UPDATE indexer_state SET value = '0' WHERE key = 'last_ledger_sequence'",
    );
    registerContract("TEST-CONTRACT", "test");
  });

  it("starts with the base poll interval", () => {
    const state = getIndexerRunnerThrottleState();
    expect(state.currentIntervalMs).toBe(15000);
    expect(state.idleCycles).toBe(0);
    expect(getIndexerRunnerPollDelayMs()).toBe(15000);
  });

  it("exposes the configured throttle parameters", () => {
    const params = getIndexerRunnerThrottleParameters();
    expect(params.baseIntervalMs).toBe(15000);
    expect(params.minIntervalMs).toBe(5000);
    expect(params.maxIntervalMs).toBe(60000);
    expect(params.idleMultiplier).toBe(2);
    expect(params.idleThresholdCycles).toBe(3);
  });

  it("does not increase the wait delay below the idle threshold", () => {
    // One idle cycle below the threshold of 3
    adjustIndexerRunnerPollInterval(0);
    const state = getIndexerRunnerThrottleState();
    expect(state.currentIntervalMs).toBe(15000);
    expect(state.idleCycles).toBe(1);
  });

  it("increases the polling wait delay when the network is idle", () => {
    const delays: number[] = [];

    // Idle cycles 1 and 2: still below the threshold.
    adjustIndexerRunnerPollInterval(0);
    delays.push(getIndexerRunnerPollDelayMs());
    adjustIndexerRunnerPollInterval(0);
    delays.push(getIndexerRunnerPollDelayMs());

    // From cycle 3 onward the delay backs off.
    adjustIndexerRunnerPollInterval(0);
    delays.push(getIndexerRunnerPollDelayMs());
    adjustIndexerRunnerPollInterval(0);
    delays.push(getIndexerRunnerPollDelayMs());

    // The wait delay must be strictly increasing once idle backing off starts.
    expect(delays[0]).toBe(15000);
    expect(delays[1]).toBe(15000);
    expect(delays[2]).toBe(30000);
    expect(delays[3]).toBe(60000);
    expect(delays[3]).toBeGreaterThan(delays[2]);
    expect(delays[2]).toBeGreaterThan(delays[1]);
  });

  it("keeps increasing the idle wait delay with every subsequent idle poll", () => {
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      adjustIndexerRunnerPollInterval(0);
      delays.push(getIndexerRunnerPollDelayMs());
    }
    // Monotonically non-decreasing...
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    }
    // ...and strictly increasing while below the max-interval ceiling.
    for (let i = 3; i < delays.length; i++) {
      if (delays[i - 1] < 60000) {
        expect(delays[i]).toBeGreaterThan(delays[i - 1]);
      } else {
        expect(delays[i]).toBe(60000);
      }
    }
  });

  it("never increases the idle wait delay above the maximum", () => {
    for (let i = 0; i < 30; i++) {
      adjustIndexerRunnerPollInterval(0);
    }
    expect(getIndexerRunnerPollDelayMs()).toBe(60000);
  });

  it("decreases the wait delay when events are processed", () => {
    const before = getIndexerRunnerPollDelayMs();
    adjustIndexerRunnerPollInterval(5);
    const after = getIndexerRunnerPollDelayMs();
    expect(after).toBeLessThan(before);
  });

  it("never decreases the wait delay below the minimum", () => {
    for (let i = 0; i < 30; i++) {
      adjustIndexerRunnerPollInterval(10);
    }
    expect(getIndexerRunnerPollDelayMs()).toBe(5000);
  });

  it("clears idle cycles as soon as events are processed", () => {
    adjustIndexerRunnerPollInterval(0);
    adjustIndexerRunnerPollInterval(0);
    expect(getIndexerRunnerThrottleState().idleCycles).toBeGreaterThan(0);

    adjustIndexerRunnerPollInterval(3);
    expect(getIndexerRunnerThrottleState().idleCycles).toBe(0);
  });

  it("records the last processed event count", () => {
    adjustIndexerRunnerPollInterval(7);
    expect(getIndexerRunnerThrottleState().lastProcessedEventCount).toBe(7);
  });

  it("updates lastLoadAdjustmentAt on every adjustment", () => {
    const before = getIndexerRunnerThrottleState().lastLoadAdjustmentAt;
    adjustIndexerRunnerPollInterval(1);
    const after = getIndexerRunnerThrottleState().lastLoadAdjustmentAt;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("resetIndexerRunnerThrottleState restores defaults", () => {
    for (let i = 0; i < 10; i++) adjustIndexerRunnerPollInterval(0);
    expect(getIndexerRunnerPollDelayMs()).toBeGreaterThan(15000);

    resetIndexerRunnerThrottleState();
    expect(getIndexerRunnerPollDelayMs()).toBe(15000);
    expect(getIndexerRunnerThrottleState().idleCycles).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Integration: the poller loop's wait delay grows while the network is idle
  // -------------------------------------------------------------------------

  it("increases the poller wait delay while the network stays idle", async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
    mockGetEvents.mockResolvedValue({ events: [] });

    // Ledger has not advanced between polls → the network is idle. Each idle
    // poll drives the runner's wait delay upward once the idle threshold is
    // reached.
    await pollEvents();
    await pollEvents();
    await pollEvents();
    const afterThreshold = getIndexerRunnerPollDelayMs();
    await pollEvents();
    const afterMoreIdle = getIndexerRunnerPollDelayMs();

    expect(afterThreshold).toBeGreaterThan(15000);
    expect(afterMoreIdle).toBeGreaterThan(afterThreshold);
    expect(getIndexerRunnerThrottleState().idleCycles).toBeGreaterThan(0);
  });

  it("pulls the poller wait delay back down once events flow again", async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
    mockGetEvents.mockResolvedValue({ events: [] });

    for (let i = 0; i < 4; i++) await pollEvents();
    const backedOff = getIndexerRunnerPollDelayMs();
    expect(backedOff).toBeGreaterThan(15000);

    // Now the ledger advances and events arrive – the delay resets downward.
    resetIndexerRunnerThrottleState();
    expect(getIndexerRunnerPollDelayMs()).toBeLessThan(backedOff);
  });
});