import { jest } from "@jest/globals";
import Database from "better-sqlite3";

const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetEvents = jest.fn<(params: any) => Promise<{ events: unknown[] }>>();
const mockDeliverWebhooks = jest.fn<(start: number, end: number) => Promise<unknown[]>>();

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
  deliverWebhooks: mockDeliverWebhooks,
}));

const { pollEvents, resetFailureState, extractOldestLedger } = await import(
  "../src/indexer/poller.js"
);
const { setDb, runMigrations, getActiveContractsWithPointers } = await import(
  "../src/indexer/db.js"
);

const CONTRACT_ID = "CRETENTION000000000000000000000000000000000000000000000001";

describe("extractOldestLedger (#609)", () => {
  it.each([
    ["stellar-rpc's range message", "startLedger must be within the ledger range: 7 - 33", 7],
    ["a range message without the colon", "start must be within ledger range 120 - 999", 120],
    ["an 'oldest ledger' message", "start is before oldest ledger 42", 42],
  ])("reads the oldest retained ledger from %s", (_label, message, expected) => {
    expect(extractOldestLedger(new Error(message))).toBe(expected);
  });

  it("returns undefined for unrelated errors", () => {
    expect(extractOldestLedger(new Error("socket hang up"))).toBeUndefined();
  });
});

describe("pollEvents with a start ledger older than the RPC retention window", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
    runMigrations();
  });

  afterAll(() => {
    testDb.close();
    delete process.env.CONTRACT_ID;
  });

  it("clamps to the oldest retained ledger instead of failing every poll", async () => {
    resetFailureState();
    process.env.CONTRACT_ID = CONTRACT_ID;
    mockGetLatestLedger.mockResolvedValue({ sequence: 33 });
    mockDeliverWebhooks.mockResolvedValue([]);
    // A fresh contract starts from ledger 1, before the RPC's 7-33 window.
    mockGetEvents.mockImplementation(async (params: any) => {
      if (!params.cursor && params.startLedger < 7) {
        throw new Error("startLedger must be within the ledger range: 7 - 33");
      }
      return { events: [] };
    });

    await pollEvents();

    const starts = mockGetEvents.mock.calls.map(([p]) => (p as any).startLedger);
    expect(starts).toEqual([1, 7]);
    const [pointer] = getActiveContractsWithPointers();
    expect(pointer).toMatchObject({ contractId: CONTRACT_ID, lastLedgerSequence: 33 });
  });
});
