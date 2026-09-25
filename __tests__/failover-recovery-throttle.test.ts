import Database from "better-sqlite3";
import { setDb, runMigrations } from "../src/indexer/db.js";
import {
  adjustFailoverRecoveryPollInterval,
  getFailoverRecoveryPollDelayMs,
  getFailoverRecoveryThrottleParameters,
  getFailoverRecoveryThrottleState,
  resetFailoverRecoveryThrottleState,
  nextFailoverRecoveryPollIntervalMs,
} from "../src/indexer/failover-recovery.js";

describe("indexer_failover_recovery – dynamic poller throttling (#418)", () => {
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
    resetFailoverRecoveryThrottleState();
  });

  it("exposes the configured throttle parameters", () => {
    const params = getFailoverRecoveryThrottleParameters();
    expect(params.baseIntervalMs).toBe(15000);
    expect(params.minIntervalMs).toBe(5000);
    expect(params.maxIntervalMs).toBe(60000);
    expect(params.idleMultiplier).toBe(2);
    expect(params.idleThresholdCycles).toBe(3);
    expect(params.loadDecreaseFactor).toBe(0.5);
  });

  it("starts with the base poll interval", () => {
    const state = getFailoverRecoveryThrottleState();
    expect(state.currentIntervalMs).toBe(15000);
    expect(state.idleCycles).toBe(0);
    expect(getFailoverRecoveryPollDelayMs()).toBe(15000);
  });

  it("increases wait delays while idle (no events processed)", () => {
    const before = getFailoverRecoveryPollDelayMs();
    adjustFailoverRecoveryPollInterval(0);
    adjustFailoverRecoveryPollInterval(0);
    adjustFailoverRecoveryPollInterval(0);
    adjustFailoverRecoveryPollInterval(0);
    const after = getFailoverRecoveryPollDelayMs();
    expect(after).toBeGreaterThan(before);
  });

  it("keeps increasing the delay on consecutive idle polls", () => {
    adjustFailoverRecoveryPollInterval(0);
    adjustFailoverRecoveryPollInterval(0);
    adjustFailoverRecoveryPollInterval(0);
    const afterThree = getFailoverRecoveryPollDelayMs();
    adjustFailoverRecoveryPollInterval(0);
    const afterFour = getFailoverRecoveryPollDelayMs();
    expect(afterFour).toBeGreaterThanOrEqual(afterThree);
  });

  it("decreases the delay when events are processed (load resumes)", () => {
    adjustFailoverRecoveryPollInterval(0);
    adjustFailoverRecoveryPollInterval(0);
    adjustFailoverRecoveryPollInterval(0);
    const idle = getFailoverRecoveryPollDelayMs();
    adjustFailoverRecoveryPollInterval(5);
    const loaded = getFailoverRecoveryPollDelayMs();
    expect(loaded).toBeLessThan(idle);
  });

  it("does not decrease below the minimum", () => {
    for (let i = 0; i < 20; i++) adjustFailoverRecoveryPollInterval(10);
    expect(getFailoverRecoveryPollDelayMs()).toBeGreaterThanOrEqual(5000);
  });

  it("does not increase above the maximum", () => {
    for (let i = 0; i < 20; i++) adjustFailoverRecoveryPollInterval(0);
    expect(getFailoverRecoveryPollDelayMs()).toBeLessThanOrEqual(60000);
  });

  it("resets idle cycles when activity resumes", () => {
    adjustFailoverRecoveryPollInterval(0);
    adjustFailoverRecoveryPollInterval(0);
    expect(getFailoverRecoveryThrottleState().idleCycles).toBeGreaterThan(0);
    adjustFailoverRecoveryPollInterval(3);
    expect(getFailoverRecoveryThrottleState().idleCycles).toBe(0);
  });

  it("reset restores defaults", () => {
    adjustFailoverRecoveryPollInterval(10);
    resetFailoverRecoveryThrottleState();
    expect(getFailoverRecoveryPollDelayMs()).toBe(15000);
  });

  it("updates lastLoadAdjustmentAt on every adjustment", () => {
    const before = getFailoverRecoveryThrottleState().lastLoadAdjustmentAt;
    adjustFailoverRecoveryPollInterval(1);
    expect(getFailoverRecoveryThrottleState().lastLoadAdjustmentAt).toBeGreaterThanOrEqual(
      before
    );
  });

  describe("nextFailoverRecoveryPollIntervalMs()", () => {
    it("increases the interval on consecutive idle polls", () => {
      const afterOne = nextFailoverRecoveryPollIntervalMs(15000, false);
      const afterTwo = nextFailoverRecoveryPollIntervalMs(afterOne, false);
      expect(afterOne).toBeGreaterThan(15000);
      expect(afterTwo).toBeGreaterThan(afterOne);
    });

    it("caps at the maximum", () => {
      let interval = 15000;
      for (let i = 0; i < 50; i++) {
        interval = nextFailoverRecoveryPollIntervalMs(interval, false);
      }
      expect(interval).toBeLessThanOrEqual(60000);
    });

    it("resets to the minimum once activity resumes", () => {
      const backedOff = nextFailoverRecoveryPollIntervalMs(60000, false);
      expect(nextFailoverRecoveryPollIntervalMs(backedOff, true)).toBe(15000);
    });
  });
});
