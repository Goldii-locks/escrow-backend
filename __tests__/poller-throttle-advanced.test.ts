/**
 * Issue #301 — Optimize poller throttling parameters
 *
 * Comprehensive tests for the dynamic polling frequency logic in db.ts.
 * The implementation already exists; these tests verify all required
 * behavioral contracts in a deterministic, timer-free manner.
 *
 * Behavioral contracts under test:
 *  1. Interval increases when the indexer is idle (no new events).
 *  2. Interval decreases / stays responsive when events are processed.
 *  3. Delay remains within [MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS].
 *  4. Exact idle threshold: increase only triggers at/after IDLE_THRESHOLD_CYCLES.
 *  5. Activity after idleness resets idle cycle counter and reduces interval.
 *  6. State is a snapshot copy (mutations on returned object don't bleed).
 *  7. resetPollerThrottleState restores base values.
 */

import Database from "better-sqlite3";
import {
  setDb,
  runMigrations,
  adjustPollerInterval,
  getCurrentPollIntervalMs,
  getPollerThrottleState,
  resetPollerThrottleState,
} from "../src/indexer/db.js";

// The defaults are read from environment; pin them so tests are deterministic
// regardless of .env values on different machines.
const BASE_INTERVAL = 15_000;
const MIN_INTERVAL = 5_000;
const MAX_INTERVAL = 60_000;
const IDLE_MULTIPLIER = 2;
const IDLE_THRESHOLD = 3; // cycles before interval starts growing

describe("Dynamic Poller Throttling — advanced tests (#301)", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    // Pin all throttle environment variables to known defaults
    process.env.POLL_INTERVAL_MS = String(BASE_INTERVAL);
    process.env.POLLER_MIN_INTERVAL_MS = String(MIN_INTERVAL);
    process.env.POLLER_MAX_INTERVAL_MS = String(MAX_INTERVAL);
    process.env.POLLER_IDLE_MULTIPLIER = String(IDLE_MULTIPLIER);
    process.env.POLLER_IDLE_THRESHOLD = String(IDLE_THRESHOLD);
    process.env.POLLER_LOAD_DECREASE_FACTOR = "0.5";

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

  // -------------------------------------------------------------------------
  // 1. Idle behaviour: interval increases after enough idle cycles
  // -------------------------------------------------------------------------

  describe("idle behaviour", () => {
    it("interval does NOT increase before the idle threshold is reached", () => {
      const initial = getCurrentPollIntervalMs();

      // Below threshold: IDLE_THRESHOLD - 1 = 2 idle cycles
      for (let i = 0; i < IDLE_THRESHOLD - 1; i++) {
        adjustPollerInterval(0);
      }

      // Should not have changed yet
      expect(getCurrentPollIntervalMs()).toBe(initial);
    });

    it("interval increases at exactly the idle threshold cycle", () => {
      const before = getCurrentPollIntervalMs();

      for (let i = 0; i < IDLE_THRESHOLD; i++) {
        adjustPollerInterval(0);
      }

      expect(getCurrentPollIntervalMs()).toBeGreaterThan(before);
    });

    it("interval doubles each time we stay idle past the threshold", () => {
      // Drive to threshold
      for (let i = 0; i < IDLE_THRESHOLD; i++) adjustPollerInterval(0);
      const afterFirstGrowth = getCurrentPollIntervalMs();

      // One more idle cycle → doubles again
      adjustPollerInterval(0);
      expect(getCurrentPollIntervalMs()).toBe(
        Math.min(afterFirstGrowth * IDLE_MULTIPLIER, MAX_INTERVAL)
      );
    });

    it("interval does not exceed MAX_POLL_INTERVAL_MS no matter how many idle cycles", () => {
      for (let i = 0; i < 100; i++) {
        adjustPollerInterval(0);
      }
      expect(getCurrentPollIntervalMs()).toBeLessThanOrEqual(MAX_INTERVAL);
    });

    it("idleCycles counter increments on every idle call", () => {
      adjustPollerInterval(0);
      expect(getPollerThrottleState().idleCycles).toBe(1);
      adjustPollerInterval(0);
      expect(getPollerThrottleState().idleCycles).toBe(2);
      adjustPollerInterval(0);
      expect(getPollerThrottleState().idleCycles).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Active behaviour: interval decreases when events are processed
  // -------------------------------------------------------------------------

  describe("active behaviour", () => {
    it("interval decreases immediately when events are processed", () => {
      // First push interval up a bit by idling past threshold
      for (let i = 0; i < IDLE_THRESHOLD; i++) adjustPollerInterval(0);
      const elevated = getCurrentPollIntervalMs();
      expect(elevated).toBeGreaterThan(BASE_INTERVAL);

      // Now process events
      adjustPollerInterval(5);
      expect(getCurrentPollIntervalMs()).toBeLessThan(elevated);
    });

    it("interval approaches MIN_POLL_INTERVAL_MS under sustained load", () => {
      for (let i = 0; i < 30; i++) {
        adjustPollerInterval(10);
      }
      expect(getCurrentPollIntervalMs()).toBe(MIN_INTERVAL);
    });

    it("interval does not drop below MIN_POLL_INTERVAL_MS", () => {
      for (let i = 0; i < 50; i++) {
        adjustPollerInterval(100);
      }
      expect(getCurrentPollIntervalMs()).toBeGreaterThanOrEqual(MIN_INTERVAL);
    });

    it("processing even 1 event resets idle cycles to 0", () => {
      adjustPollerInterval(0);
      adjustPollerInterval(0);
      expect(getPollerThrottleState().idleCycles).toBe(2);

      adjustPollerInterval(1);
      expect(getPollerThrottleState().idleCycles).toBe(0);
    });

    it("lastProcessedEventCount is updated to the event count passed in", () => {
      adjustPollerInterval(42);
      expect(getPollerThrottleState().lastProcessedEventCount).toBe(42);

      adjustPollerInterval(0);
      expect(getPollerThrottleState().lastProcessedEventCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Activity resumption: poller becomes responsive again after idle
  // -------------------------------------------------------------------------

  describe("activity resumption after idleness", () => {
    it("resumes responsiveness after several idle cycles", () => {
      // Drive interval up to near max
      for (let i = 0; i < 20; i++) adjustPollerInterval(0);
      const elevated = getCurrentPollIntervalMs();
      expect(elevated).toBeGreaterThan(BASE_INTERVAL);

      // Activity resumes
      adjustPollerInterval(10);
      const afterResume = getCurrentPollIntervalMs();

      // Must have decreased from the elevated value
      expect(afterResume).toBeLessThan(elevated);
      expect(afterResume).toBeGreaterThanOrEqual(MIN_INTERVAL);
    });

    it("sustained activity after idleness brings interval all the way down to MIN", () => {
      // First idle
      for (let i = 0; i < 20; i++) adjustPollerInterval(0);
      expect(getCurrentPollIntervalMs()).toBeGreaterThan(BASE_INTERVAL);

      // Then sustained activity
      for (let i = 0; i < 30; i++) adjustPollerInterval(5);
      expect(getCurrentPollIntervalMs()).toBe(MIN_INTERVAL);
    });

    it("idleCycles resets to 0 when activity resumes, preventing phantom threshold triggers", () => {
      // Accumulate idle cycles
      for (let i = 0; i < IDLE_THRESHOLD + 2; i++) adjustPollerInterval(0);
      expect(getPollerThrottleState().idleCycles).toBeGreaterThan(0);

      // Resume with a single event
      adjustPollerInterval(1);
      expect(getPollerThrottleState().idleCycles).toBe(0);

      // Now go idle again — should take IDLE_THRESHOLD cycles to grow again
      const intervalAfterResume = getCurrentPollIntervalMs();
      for (let i = 0; i < IDLE_THRESHOLD - 1; i++) adjustPollerInterval(0);
      // Should not have grown yet
      expect(getCurrentPollIntervalMs()).toBe(intervalAfterResume);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Bounds
  // -------------------------------------------------------------------------

  describe("interval bounds", () => {
    it("starts at BASE_POLL_INTERVAL_MS", () => {
      expect(getCurrentPollIntervalMs()).toBe(BASE_INTERVAL);
    });

    it("never goes below MIN_POLL_INTERVAL_MS", () => {
      for (let i = 0; i < 100; i++) adjustPollerInterval(50);
      expect(getCurrentPollIntervalMs()).toBeGreaterThanOrEqual(MIN_INTERVAL);
    });

    it("never goes above MAX_POLL_INTERVAL_MS", () => {
      for (let i = 0; i < 100; i++) adjustPollerInterval(0);
      expect(getCurrentPollIntervalMs()).toBeLessThanOrEqual(MAX_INTERVAL);
    });

    it("MIN < BASE < MAX (sanity check for configured values)", () => {
      expect(MIN_INTERVAL).toBeLessThan(BASE_INTERVAL);
      expect(BASE_INTERVAL).toBeLessThan(MAX_INTERVAL);
    });
  });

  // -------------------------------------------------------------------------
  // 5. State snapshot integrity
  // -------------------------------------------------------------------------

  describe("state snapshot integrity", () => {
    it("getPollerThrottleState returns a copy — mutations do not affect internal state", () => {
      const s = getPollerThrottleState();
      const originalInterval = s.currentIntervalMs;

      // Mutate the returned copy
      (s as any).currentIntervalMs = 999999;

      // Internal state must be unchanged
      expect(getCurrentPollIntervalMs()).toBe(originalInterval);
      expect(getPollerThrottleState().currentIntervalMs).toBe(originalInterval);
    });

    it("adjustPollerInterval returns a snapshot reflecting the new state", () => {
      const returned = adjustPollerInterval(10);
      const current = getPollerThrottleState();

      expect(returned.currentIntervalMs).toBe(current.currentIntervalMs);
      expect(returned.idleCycles).toBe(current.idleCycles);
    });

    it("lastLoadAdjustmentAt is updated on every adjustPollerInterval call", () => {
      const t1 = getPollerThrottleState().lastLoadAdjustmentAt;
      adjustPollerInterval(1);
      const t2 = getPollerThrottleState().lastLoadAdjustmentAt;

      expect(t2).toBeGreaterThanOrEqual(t1);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Reset
  // -------------------------------------------------------------------------

  describe("reset behaviour", () => {
    it("resetPollerThrottleState restores currentIntervalMs to BASE", () => {
      for (let i = 0; i < 30; i++) adjustPollerInterval(0);
      expect(getCurrentPollIntervalMs()).not.toBe(BASE_INTERVAL);

      resetPollerThrottleState();
      expect(getCurrentPollIntervalMs()).toBe(BASE_INTERVAL);
    });

    it("resetPollerThrottleState resets idleCycles to 0", () => {
      for (let i = 0; i < 10; i++) adjustPollerInterval(0);
      expect(getPollerThrottleState().idleCycles).toBeGreaterThan(0);

      resetPollerThrottleState();
      expect(getPollerThrottleState().idleCycles).toBe(0);
    });

    it("resetPollerThrottleState resets lastProcessedEventCount to 0", () => {
      adjustPollerInterval(77);
      expect(getPollerThrottleState().lastProcessedEventCount).toBe(77);

      resetPollerThrottleState();
      expect(getPollerThrottleState().lastProcessedEventCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Deterministic scenario: simulate a realistic polling session
  // -------------------------------------------------------------------------

  describe("realistic polling scenario", () => {
    it("interval stays low during a burst, grows during a quiet period, recovers on next burst", () => {
      // Phase 1: active burst (10 events per cycle × 15 cycles)
      for (let i = 0; i < 15; i++) adjustPollerInterval(10);
      const afterBurst = getCurrentPollIntervalMs();
      expect(afterBurst).toBe(MIN_INTERVAL);

      // Phase 2: quiet period (no events × 10 cycles)
      for (let i = 0; i < 10; i++) adjustPollerInterval(0);
      const afterQuiet = getCurrentPollIntervalMs();
      expect(afterQuiet).toBeGreaterThan(MIN_INTERVAL);
      expect(afterQuiet).toBeLessThanOrEqual(MAX_INTERVAL);

      // Phase 3: burst again — interval must decrease
      for (let i = 0; i < 10; i++) adjustPollerInterval(5);
      const afterRecovery = getCurrentPollIntervalMs();
      expect(afterRecovery).toBeLessThan(afterQuiet);
      expect(afterRecovery).toBeGreaterThanOrEqual(MIN_INTERVAL);
    });
  });
});
