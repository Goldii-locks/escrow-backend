import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import { setDb, runMigrations, registerContract } from "../src/indexer/db.js";

// Configure tiny backoff delays so retry tests run fast: 2 retries with
// 1ms / 2ms sleeps instead of the production 1s / 2s defaults.
process.env.INDEXER_RPC_MAX_RETRIES = "2";
process.env.INDEXER_RPC_INITIAL_BACKOFF_MS = "1";
process.env.INDEXER_RPC_BACKOFF_MULTIPLIER = "2";
process.env.INDEXER_RPC_MAX_BACKOFF_MS = "10";

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

const { pollEvents, getConsecutiveFailures, resetFailureState } = await import(
  "../src/indexer/poller.js"
);

describe("Poller RPC exponential backoff retry (#249)", () => {
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
    jest.clearAllMocks();
    testDb.exec("DELETE FROM events");
    testDb.exec("DELETE FROM monitored_contracts");
    testDb.exec("UPDATE indexer_state SET value = '0' WHERE key = 'last_ledger_sequence'");
    registerContract("TEST-CONTRACT", "test");
  });

  it("retries getLatestLedger on a transient timeout and recovers", async () => {
    mockGetLatestLedger
      .mockRejectedValueOnce(new Error("connect timeout"))
      .mockResolvedValue({ sequence: 100 });
    mockGetEvents.mockResolvedValue({ events: [] });

    const result = await pollEvents();

    expect(result).toBe(true);
    // initial attempt + 1 retry
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(2);
    expect(getConsecutiveFailures()).toBe(0);
  });

  it("retries getEvents on a transient connection reset and recovers", async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
    mockGetEvents
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue({ events: [] });

    const result = await pollEvents();

    expect(result).toBe(true);
    expect(mockGetEvents).toHaveBeenCalledTimes(2);
    expect(getConsecutiveFailures()).toBe(0);
  });

  it("retries up to max attempts on persistent connection dropouts, then reports failure", async () => {
    mockGetLatestLedger.mockRejectedValue(new Error("socket hang up"));

    const result = await pollEvents();

    expect(result).toBe(false);
    // initial attempt + INDEXER_RPC_MAX_RETRIES (2) retries
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(3);
    expect(getConsecutiveFailures()).toBe(1);
  });

  it("exhausts retries on getEvents failures as well", async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
    mockGetEvents.mockRejectedValue(new Error("status 503"));

    await pollEvents();

    expect(mockGetEvents).toHaveBeenCalledTimes(3);
    expect(getConsecutiveFailures()).toBe(1);
  });

  it("does not retry non-retryable errors", async () => {
    mockGetLatestLedger.mockRejectedValue(new Error("invalid argument"));

    await pollEvents();

    expect(mockGetLatestLedger).toHaveBeenCalledTimes(1);
    expect(getConsecutiveFailures()).toBe(1);
  });

  it("logs a warn with the attempt count and backoff delay on retry", async () => {
    mockGetLatestLedger
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue({ sequence: 100 });
    mockGetEvents.mockResolvedValue({ events: [] });

    await pollEvents();

    const warnCalls = mockLogger.warn.mock.calls.filter(
      (call: any[]) =>
        typeof call[0] === "string" && call[0].includes("failed, retrying"),
    );
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    expect(warnCalls[0][1]).toMatchObject({
      attempt: 1,
      maxRetries: 2,
      backoffMs: 1,
    });
  });
});
