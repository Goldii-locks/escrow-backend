import { jest } from "@jest/globals";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Mock the Stellar RPC server and the logger (to assert on debug() calls
// directly), following the jest.unstable_mockModule convention already used
// in build-tx.test.ts / poller-dynamic-interval.test.ts.
// ---------------------------------------------------------------------------

const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetEvents = jest.fn<() => Promise<{ events: any[] }>>();
const mockDebug = jest.fn();
const mockInfo = jest.fn();
const mockError = jest.fn();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getLatestLedger = mockGetLatestLedger;
    getEvents = mockGetEvents;
  },
}));

jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  scValToNative: (value: unknown) => value,
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: mockInfo, warn: jest.fn(), error: mockError, debug: mockDebug },
}));

const { pollEvents, resetPollDiagnosticsThrottle } = await import("../src/indexer/poller.js");

const { setDb, runMigrations, registerContract } = await import("../src/indexer/db.js");

// A realistic payload shape containing job-participant wallet addresses,
// mirroring what db.ts's getJobsByWallet() extracts from data_json.
function fakeEvent(ledger: number, eventType: string) {
  return {
    contractId: { contractId: () => "CONTRACT-DIAG" },
    topic: [eventType],
    ledger,
    ledgerClosedAt: null,
    value: {
      client: "GA" + "X".repeat(54),
      freelancer: "GB" + "Y".repeat(54),
      arbiter: "GC" + "Z".repeat(54),
      amount: "5000",
    },
  };
}

describe("event_type_filter — high-frequency diagnostic logging", () => {
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
    registerContract("CONTRACT-DIAG", "diag-test");
    mockGetLatestLedger.mockReset();
    mockGetEvents.mockReset();
    mockDebug.mockReset();
    mockInfo.mockReset();
    mockError.mockReset();
    resetPollDiagnosticsThrottle();
  });

  it("logs a debug-level diagnostic string containing the elapsed time value", async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 501 });
    mockGetEvents.mockResolvedValue({ events: [fakeEvent(501, "funded")] });

    await pollEvents();

    expect(mockDebug).toHaveBeenCalledTimes(1);
    const [message, meta] = mockDebug.mock.calls[0] as [string, any];

    // Validation check: diagnostic log strings contain elapsed time values.
    expect(message).toMatch(/elapsedMs=\d+(\.\d+)?/);
    expect(typeof meta.elapsedMs).toBe("number");
    expect(meta.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("logs payload sizes (byte counts), never the raw payload contents", async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 501 });
    mockGetEvents.mockResolvedValue({ events: [fakeEvent(501, "funded")] });

    await pollEvents();

    const [message, meta] = mockDebug.mock.calls[0] as [string, any];

    expect(meta.totalPayloadBytes).toBeGreaterThan(0);
    expect(typeof meta.avgPayloadBytes).toBe("number");

    // Must never contain the actual sensitive field values from the payload.
    const serialized = message + JSON.stringify(meta);
    expect(serialized).not.toContain("GA" + "X".repeat(54)); // client address
    expect(serialized).not.toContain("GB" + "Y".repeat(54)); // freelancer address
    expect(serialized).not.toContain("GC" + "Z".repeat(54)); // arbiter address
    expect(serialized).not.toContain("5000"); // amount
  });

  it("reports the correct event count and total payload size for the poll", async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 502 });
    mockGetEvents.mockResolvedValue({
      events: [fakeEvent(501, "funded"), fakeEvent(502, "delivered")],
    });

    await pollEvents();

    const [, meta] = mockDebug.mock.calls[0] as [string, any];
    expect(meta.eventCount).toBe(2);

    const expectedBytes = 2 * Buffer.byteLength(JSON.stringify(fakeEvent(0, "x").value), "utf8");
    expect(meta.totalPayloadBytes).toBe(expectedBytes);
  });

  it("does not log a diagnostic when the poll is idle (no ledger advance, no events)", async () => {
    testDb.exec("UPDATE indexer_state SET value = '500' WHERE key = 'last_ledger_sequence'");
    mockGetLatestLedger.mockResolvedValue({ sequence: 500 });

    await pollEvents();

    expect(mockDebug).not.toHaveBeenCalled();
  });

  it("throttles consecutive diagnostic logs instead of firing unconditionally on every poll", async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 501 });
    mockGetEvents.mockResolvedValue({ events: [fakeEvent(501, "funded")] });

    await pollEvents(); // first call - always logs (throttle window starts empty)
    expect(mockDebug).toHaveBeenCalledTimes(1);

    // Simulate the ledger continuing to advance so subsequent polls are
    // "active" polls, back-to-back, well within the throttle window.
    mockGetLatestLedger.mockResolvedValue({ sequence: 502 });
    await pollEvents();
    mockGetLatestLedger.mockResolvedValue({ sequence: 503 });
    await pollEvents();

    // Still just the one diagnostic log - the throttle suppressed the rest.
    expect(mockDebug).toHaveBeenCalledTimes(1);
  });

  // Note: the "off by default in production" requirement is satisfied by
  // calling logger.debug() (asserted above) and relying on logger.ts's
  // existing, already-tested convention (LOG_LEVEL defaults to "info" under
  // NODE_ENV=production, "debug" otherwise) - see
  // event-type-filter-diagnostic-logging-level.test.ts for a real,
  // unmocked-logger test of that gating with this exact log call.
});
