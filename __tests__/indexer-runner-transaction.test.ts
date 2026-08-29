import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import { setDb, runMigrations, registerContract, getEventsByContract, getLastIndexedLedger, setLastIndexedLedger, executeInTransaction, insertEventBatch } from "../src/indexer/db.js";

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: mockLogger,
}));

jest.unstable_mockModule("../src/indexer/webhook-delivery.js", () => ({
  deliverWebhooks: jest.fn().mockResolvedValue(undefined),
}));

const mockGetLatestLedger = jest.fn();
const mockGetEvents = jest.fn();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: jest.fn().mockImplementation(() => ({
    getLatestLedger: mockGetLatestLedger,
    getEvents: mockGetEvents,
  })),
}));

jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  scValToNative: (val: unknown) => val,
}));

// We'll import poller which uses db.js
const { pollEvents, resetFailureState } = await import("../src/indexer/poller.js");

describe("indexer_runner transaction isolation", () => {
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
    testDb.exec(
      "UPDATE indexer_state SET value = '0' WHERE key = 'last_ledger_sequence'",
    );
    registerContract("TEST-CONTRACT", "test");
  });

  it("should rollback database updates fully on execution failures", async () => {
    setLastIndexedLedger(100);
    
    mockGetLatestLedger.mockResolvedValue({ sequence: 101 });
    
    // We mock getEvents to return a valid event, but we will mock insertEventBatch to fail
    mockGetEvents.mockResolvedValue({
      events: [
        {
          contractId: { contractId: () => "TEST-CONTRACT" },
          topic: ["funded"],
          ledger: 101,
          ledgerClosedAt: "2024-01-01T00:00:00Z",
          value: { amount: "100" },
        },
      ],
    });

    // To simulate an execution failure in the middle of poller's DB updates,
    // we can use a SQLite trick: insert an event that violates a NOT NULL constraint
    // by making its dataJson undefined, which is stringified to undefined if not careful.
    // Wait, JSON.stringify(undefined) returns undefined, which SQLite will reject for TEXT NOT NULL.
    // However, the poller does: JSON.stringify(event.value ?? null).
    // So if event.value is undefined, it stringifies to "null", which is valid string!

    // Let's just drop the events table temporarily to force an error on insert!
    testDb.exec("DROP TABLE events");

    await pollEvents();

    // Verify rollback: last_ledger_sequence should still be 100, not 101!
    expect(getLastIndexedLedger()).toBe(100);
  });
});
