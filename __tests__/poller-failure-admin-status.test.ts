import { jest } from "@jest/globals";

// ---------------------------------------------------------------------------
// Poller failure accounting → the admin status endpoint's consecutiveFailures
// field (#644). The poll loop and the admin route read the same failure
// monitor, so a failed poll must show up in the status response.
// ---------------------------------------------------------------------------

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

jest.unstable_mockModule("../src/indexer/webhook-delivery.js", () => ({
  deliverWebhooks: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

// The poll loop reads its contract list and event buffer from the db
// module. Stubbing it keeps this test free of a real SQLite file, so the
// failure accounting can be exercised on its own.
const { dbModuleMock } = await import("./helpers/db-module-mock.js");
jest.unstable_mockModule("../src/indexer/db.js", () => dbModuleMock);

const {
  pollEvents,
  getConsecutiveFailures,
  getLastSuccessfulPollAt,
  resetFailureState,
  getCurrentPollIntervalMs,
  getChainHeadSequence,
  resetChainHeadCache,
} = await import("../src/indexer/poller.js");

describe("poller failure accounting surfaced by the admin status endpoint", () => {
  beforeEach(() => {
    resetFailureState();
    resetChainHeadCache();
    mockGetLatestLedger.mockReset();
    mockGetEvents.mockReset();
    jest.clearAllMocks();
  });

  it("increments consecutiveFailures after a mocked poll failure", async () => {
    expect(getConsecutiveFailures()).toBe(0);

    mockGetLatestLedger.mockRejectedValue(new Error("RPC connection failed"));
    await pollEvents();
    expect(getConsecutiveFailures()).toBe(1);

    await pollEvents();
    expect(getConsecutiveFailures()).toBe(2);
  });

  it("resets consecutiveFailures after a successful poll", async () => {
    mockGetLatestLedger.mockRejectedValue(new Error("fail"));
    await pollEvents();
    expect(getConsecutiveFailures()).toBe(1);

    mockGetLatestLedger.mockResolvedValue({ sequence: 7 });
    mockGetEvents.mockResolvedValue({ events: [] });
    await pollEvents();
    expect(getConsecutiveFailures()).toBe(0);
  });

  it("records the time of the last successful poll", async () => {
    expect(getLastSuccessfulPollAt()).toBeNull();

    mockGetLatestLedger.mockResolvedValue({ sequence: 7 });
    mockGetEvents.mockResolvedValue({ events: [] });
    await pollEvents();

    expect(typeof getLastSuccessfulPollAt()).toBe("number");
  });

  it("exposes the current poll interval", () => {
    expect(typeof getCurrentPollIntervalMs()).toBe("number");
    expect(getCurrentPollIntervalMs()).toBeGreaterThan(0);
  });
});

describe("getChainHeadSequence (#644)", () => {
  beforeEach(() => {
    resetChainHeadCache();
    mockGetLatestLedger.mockReset();
    jest.clearAllMocks();
  });

  it("returns the latest ledger sequence", async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 250 });
    await expect(getChainHeadSequence()).resolves.toBe(250);
  });

  it("returns null when the RPC call fails", async () => {
    mockGetLatestLedger.mockRejectedValue(new Error("RPC unreachable"));
    await expect(getChainHeadSequence()).resolves.toBeNull();
  });

  it("caches the chain head for subsequent calls", async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 300 });

    await getChainHeadSequence();
    await getChainHeadSequence();
    await getChainHeadSequence();

    // A cached head must not issue another RPC round trip.
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed lookup", async () => {
    mockGetLatestLedger.mockRejectedValueOnce(new Error("RPC unreachable"));
    await expect(getChainHeadSequence()).resolves.toBeNull();

    mockGetLatestLedger.mockResolvedValue({ sequence: 310 });
    await expect(getChainHeadSequence()).resolves.toBe(310);
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(2);
  });
});
