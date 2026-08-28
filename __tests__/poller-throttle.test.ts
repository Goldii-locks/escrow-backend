import Database from "better-sqlite3";
import {
  setDb,
  runMigrations,
  adjustPollerInterval,
  getCurrentPollIntervalMs,
  getPollerThrottleState,
  resetPollerThrottleState,
} from "../src/indexer/db.js";

describe("Dynamic Poller Throttling (#265)", () => {
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
    resetPollerThrottleState();
  });

  it("starts with the base poll interval", () => {
    const state = getPollerThrottleState();
    expect(state.currentIntervalMs).toBe(15000);
    expect(state.idleCycles).toBe(0);
  });

  it("decreases interval when events are processed", () => {
    const before = getCurrentPollIntervalMs();
    adjustPollerInterval(5);
    const after = getCurrentPollIntervalMs();
    expect(after).toBeLessThan(before);
  });

  it("increases interval when idle (no events)", () => {
    const before = getCurrentPollIntervalMs();

    // Simulate enough idle cycles to trigger increase
    adjustPollerInterval(0);
    adjustPollerInterval(0);
    adjustPollerInterval(0);
    adjustPollerInterval(0);

    const after = getCurrentPollIntervalMs();
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("does not decrease interval below MIN_POLL_INTERVAL_MS", () => {
    // Process events many times to push interval down
    for (let i = 0; i < 20; i++) {
      adjustPollerInterval(10);
    }
    expect(getCurrentPollIntervalMs()).toBeGreaterThanOrEqual(5000);
  });

  it("does not increase interval above MAX_POLL_INTERVAL_MS", () => {
    for (let i = 0; i < 20; i++) {
      adjustPollerInterval(0);
    }
    expect(getCurrentPollIntervalMs()).toBeLessThanOrEqual(60000);
  });

  it("resets idle cycles when events are processed", () => {
    adjustPollerInterval(0);
    adjustPollerInterval(0);
    const stateBefore = getPollerThrottleState();
    expect(stateBefore.idleCycles).toBeGreaterThan(0);

    adjustPollerInterval(5);
    const stateAfter = getPollerThrottleState();
    expect(stateAfter.idleCycles).toBe(0);
  });

  it("returns a snapshot copy from getPollerThrottleState", () => {
    const s1 = getPollerThrottleState();
    const s2 = getPollerThrottleState();
    expect(s1).toEqual(s2);
    expect(s1).not.toBe(s2);
  });

  it("resetPollerThrottleState restores defaults", () => {
    adjustPollerInterval(10);
    adjustPollerInterval(10);
    const adjusted = getCurrentPollIntervalMs();

    resetPollerThrottleState();
    const reset = getCurrentPollIntervalMs();
    expect(reset).toBe(15000);
    expect(reset).not.toBe(adjusted);
  });

  it("adjustPollerInterval updates lastLoadAdjustmentAt", () => {
    const before = getPollerThrottleState().lastLoadAdjustmentAt;
    adjustPollerInterval(1);
    const after = getPollerThrottleState().lastLoadAdjustmentAt;
    expect(after).toBeGreaterThanOrEqual(before);
  });
});
