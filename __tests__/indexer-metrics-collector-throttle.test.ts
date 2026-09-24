import Database from "better-sqlite3";
import { runMigrations, setDb, insertEvent } from "../src/indexer/db.js";
import {
  collectIndexerMetrics,
  onIndexerMetricsCollected,
  adjustIndexerMetricsPollingInterval,
  computeIndexerMetricsProcessedCount,
  getIndexerMetricsPollDelayMs,
  getIndexerMetricsThrottleParameters,
  getIndexerMetricsThrottleState,
  resetIndexerMetricsThrottleState,
  resetIndexerMetricsCollectorState,
} from "../src/indexer/indexer_metrics_collector.js";

describe("indexer_metrics_collector dynamic poll throttling (#341)", () => {
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
    resetIndexerMetricsCollectorState();
    resetIndexerMetricsThrottleState();
    testDb.exec("DELETE FROM events");
    testDb.exec("UPDATE indexer_state SET value = '0' WHERE key = 'last_ledger_sequence'");
  });

  it("starts with the base poll interval", () => {
    expect(getIndexerMetricsPollDelayMs()).toBe(60000);
    expect(getIndexerMetricsThrottleState().currentIntervalMs).toBe(60000);
    expect(getIndexerMetricsThrottleState().idleCycles).toBe(0);
  });

  it("exposes the configured throttle parameters", () => {
    const params = getIndexerMetricsThrottleParameters();
    expect(params.baseIntervalMs).toBe(60000);
    expect(params.minIntervalMs).toBe(15000);
    expect(params.maxIntervalMs).toBe(600000);
    expect(params.idleMultiplier).toBe(2);
    expect(params.idleThresholdCycles).toBe(3);
  });

  it("increases the collection poll wait delay when the network is idle", () => {
    const delays: number[] = [];

    // Idle cycles 1 and 2 are below the threshold of 3.
    adjustIndexerMetricsPollingInterval(0);
    delays.push(getIndexerMetricsPollDelayMs());
    adjustIndexerMetricsPollingInterval(0);
    delays.push(getIndexerMetricsPollDelayMs());

    // From cycle 3 onward the poll interval backs off.
    for (let i = 0; i < 4; i++) {
      adjustIndexerMetricsPollingInterval(0);
      delays.push(getIndexerMetricsPollDelayMs());
    }

    expect(delays[0]).toBe(60000);
    expect(delays[1]).toBe(60000);
    expect(delays[2]).toBe(120000);
    expect(delays[3]).toBe(240000);
    expect(delays[1]).toBeLessThanOrEqual(delays[2]);
    expect(delays[2]).toBeLessThan(delays[3]);
  });

  it("backs off further on every subsequent idle collection up to the max", () => {
    for (let i = 0; i < 12; i++) {
      adjustIndexerMetricsPollingInterval(0);
    }
    expect(getIndexerMetricsPollDelayMs()).toBe(600000);
  });

  it("resets the poll interval to the minimum when events are processed", () => {
    for (let i = 0; i < 5; i++) adjustIndexerMetricsPollingInterval(0);
    expect(getIndexerMetricsPollDelayMs()).toBeGreaterThan(60000);

    adjustIndexerMetricsPollingInterval(7);
    expect(getIndexerMetricsPollDelayMs()).toBe(15000);
    expect(getIndexerMetricsThrottleState().idleCycles).toBe(0);
  });

  it("counts processed events as the delta between consecutive snapshots", () => {
    const first = { totalEvents: 10, lastIndexedLedger: 100 };
    const second = { totalEvents: 14, lastIndexedLedger: 120 };
    const third = { totalEvents: 14, lastIndexedLedger: 122 };

    expect(computeIndexerMetricsProcessedCount(first, null)).toBe(10);
    expect(computeIndexerMetricsProcessedCount(second, first)).toBe(4);
    // No new events while the network stays idle → 0 processed.
    expect(computeIndexerMetricsProcessedCount(third, second)).toBe(0);
  });

  it("uses the processed-event delta from actual collections to back off when idle", async () => {
    // Seed two events so the first collection observes load.
    insertEvent("c1", "initialized", 1, 1_700_000_000, "{}");
    insertEvent("c1", "funded", 2, 1_700_000_001, "{}");

    // First collection: sees 2 events → interval stays responsive.
    onIndexerMetricsCollected(collectIndexerMetrics(testDb));
    expect(getIndexerMetricsPollDelayMs()).toBe(15000);

    // Subsequent collections see no growth (idle) → the wait delay increases.
    onIndexerMetricsCollected(collectIndexerMetrics(testDb));
    const afterSecond = getIndexerMetricsPollDelayMs();

    onIndexerMetricsCollected(collectIndexerMetrics(testDb));
    onIndexerMetricsCollected(collectIndexerMetrics(testDb));
    const afterFourth = getIndexerMetricsPollDelayMs();

    expect(afterSecond).toBeGreaterThanOrEqual(15000);
    expect(afterFourth).toBeGreaterThan(afterSecond);

    // New events arrive → the delay is pulled back to the minimum again.
    insertEvent("c1", "approved", 3, 1_700_000_002, "{}");
    onIndexerMetricsCollected(collectIndexerMetrics(testDb));
    expect(getIndexerMetricsPollDelayMs()).toBe(15000);
  });

  it("resetIndexerMetricsThrottleState restores defaults", () => {
    for (let i = 0; i < 10; i++) adjustIndexerMetricsPollingInterval(0);
    expect(getIndexerMetricsPollDelayMs()).toBeGreaterThan(60000);

    resetIndexerMetricsThrottleState();
    expect(getIndexerMetricsPollDelayMs()).toBe(60000);
    expect(getIndexerMetricsThrottleState().idleCycles).toBe(0);
  });
});