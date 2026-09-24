import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import {
  setDb,
  runMigrations,
  getLastIndexedLedger,
} from "../src/indexer/db.js";

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

const {
  enqueueEventInsert,
  resetEventInsertQueueForTests,
  startPoller,
} = await import("../src/indexer/poller.js");

function countRows(
  db: Database.Database,
  contractId: string,
  ledger: number,
  eventType: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM events
       WHERE contract_id = ? AND ledger_sequence = ? AND event_type = ?`,
    )
    .get(contractId, ledger, eventType) as { cnt: number };
  return row.cnt;
}

describe("Indexer runner memory queue locks (#251)", () => {
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
    resetEventInsertQueueForTests();
    testDb.exec("DELETE FROM events");
    testDb.exec("UPDATE indexer_state SET value = '0' WHERE key = 'last_ledger_sequence'");
  });

  it("does not create duplicate entries for concurrent identical notifications", async () => {
    const event = {
      contractId: "C-RACE",
      eventType: "initialized",
      ledgerSequence: 500,
      timestamp: 2000,
      dataJson: '{"jobId":"race-1"}',
    };

    await Promise.all([
      enqueueEventInsert([event], 500),
      enqueueEventInsert([event], 500),
      enqueueEventInsert([event], 500),
    ]);

    expect(countRows(testDb, "C-RACE", 500, "initialized")).toBe(1);
  });

  it("serializes concurrent inserts without regressing the ledger pointer", async () => {
    const events = [
      {
        contractId: "C1",
        eventType: "funded",
        ledgerSequence: 100,
        timestamp: 1000,
        dataJson: "{}",
      },
      {
        contractId: "C2",
        eventType: "approved",
        ledgerSequence: 200,
        timestamp: 2000,
        dataJson: "{}",
      },
      {
        contractId: "C3",
        eventType: "delivered",
        ledgerSequence: 300,
        timestamp: 3000,
        dataJson: "{}",
      },
    ];

    await Promise.all(
      events.map((ev) => enqueueEventInsert([ev], ev.ledgerSequence)),
    );

    expect(getLastIndexedLedger()).toBe(300);
    expect(countRows(testDb, "C1", 100, "funded")).toBe(1);
    expect(countRows(testDb, "C2", 200, "approved")).toBe(1);
    expect(countRows(testDb, "C3", 300, "delivered")).toBe(1);
    const total = (
      testDb.prepare("SELECT COUNT(*) AS cnt FROM events").get() as { cnt: number }
    ).cnt;
    expect(total).toBe(3);
  });
});

describe("Indexer runner migration verification hook (#255)", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
    runMigrations();
  });

  afterAll(() => {
    testDb.close();
  });

  it("startPoller fails fast when the database schema is out of sync", () => {
    testDb.exec("DROP TABLE events");
    expect(() => startPoller()).toThrow(/Schema verification failed|out of sync/i);
  });
});
