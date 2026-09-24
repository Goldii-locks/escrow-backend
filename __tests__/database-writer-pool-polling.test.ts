import {
  adjustWriterPoolPollingInterval,
  getWriterPoolPollingState,
  resetWriterPoolPollingState,
  DEFAULT_WRITER_POOL_POLL_INTERVAL_MS,
  MIN_WRITER_POOL_POLL_INTERVAL_MS,
  MAX_WRITER_POOL_POLL_INTERVAL_MS,
  WRITER_POOL_IDLE_BACKOFF_FACTOR,
  WRITER_POOL_IDLE_THRESHOLD_CYCLES,
} from "../src/indexer/database-writer-pool.js";

describe("database_writer_pool – dynamic polling frequency intervals", () => {
  beforeEach(() => {
    resetWriterPoolPollingState();
  });

  it("returns default polling state initially", () => {
    const state = getWriterPoolPollingState();
    expect(state.currentIntervalMs).toBe(DEFAULT_WRITER_POOL_POLL_INTERVAL_MS);
    expect(state.idleCycles).toBe(0);
  });

  it("resets interval to minimum when events are processed", () => {
    const state = adjustWriterPoolPollingInterval(10); // 10 events processed
    expect(state.idleCycles).toBe(0);
    expect(state.currentIntervalMs).toBe(MIN_WRITER_POOL_POLL_INTERVAL_MS);
  });

  it("increases idle cycles when no events are processed but does not backoff immediately", () => {
    const state = adjustWriterPoolPollingInterval(0); // 0 events processed
    expect(state.idleCycles).toBe(1);
    expect(state.currentIntervalMs).toBe(DEFAULT_WRITER_POOL_POLL_INTERVAL_MS); // Still default
  });

  it("asserts polling wait delays increase if network is idle", () => {
    // We process 0 events repeatedly to simulate idle network
    let state = getWriterPoolPollingState();

    // Cycle 1: idle
    state = adjustWriterPoolPollingInterval(0);
    expect(state.idleCycles).toBe(1);
    expect(state.currentIntervalMs).toBe(DEFAULT_WRITER_POOL_POLL_INTERVAL_MS);

    // Cycle 2: reaches threshold
    state = adjustWriterPoolPollingInterval(0);
    expect(state.idleCycles).toBe(WRITER_POOL_IDLE_THRESHOLD_CYCLES); // 2
    expect(state.currentIntervalMs).toBe(
      DEFAULT_WRITER_POOL_POLL_INTERVAL_MS * WRITER_POOL_IDLE_BACKOFF_FACTOR
    ); // 1000 * 2 = 2000

    // Cycle 3: idle again, doubles again
    state = adjustWriterPoolPollingInterval(0);
    expect(state.idleCycles).toBe(3);
    expect(state.currentIntervalMs).toBe(
      DEFAULT_WRITER_POOL_POLL_INTERVAL_MS * WRITER_POOL_IDLE_BACKOFF_FACTOR * WRITER_POOL_IDLE_BACKOFF_FACTOR
    ); // 2000 * 2 = 4000
  });

  it("caps the polling interval at the maximum configured value", () => {
    let state = getWriterPoolPollingState();

    // Loop until we should hit the max
    for (let i = 0; i < 10; i++) {
      state = adjustWriterPoolPollingInterval(0);
    }

    expect(state.currentIntervalMs).toBe(MAX_WRITER_POOL_POLL_INTERVAL_MS);
  });

  it("recovers to minimum interval when events are processed again after backoff", () => {
    // Backoff first
    for (let i = 0; i < 5; i++) {
      adjustWriterPoolPollingInterval(0);
    }

    let state = getWriterPoolPollingState();
    expect(state.currentIntervalMs).toBeGreaterThan(DEFAULT_WRITER_POOL_POLL_INTERVAL_MS);
    expect(state.idleCycles).toBe(5);

    // Now process some events
    state = adjustWriterPoolPollingInterval(1);

    expect(state.idleCycles).toBe(0);
    expect(state.currentIntervalMs).toBe(MIN_WRITER_POOL_POLL_INTERVAL_MS);
  });
});
