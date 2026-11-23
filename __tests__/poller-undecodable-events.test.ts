import { jest } from "@jest/globals";
import Database from "better-sqlite3";

/**
 * #658: one event that cannot be decoded must not block the poll.
 * A page of 3 events where the middle one throws stores 2 events and
 * 1 undecodable row, and the ledger pointer still advances.
 */

const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetEvents = jest.fn<(params: any) => Promise<{ events: unknown[] }>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getLatestLedger = mockGetLatestLedger;
    getEvents = mockGetEvents;
  },
}));

jest.unstable_mockModule("../src/indexer/webhook-delivery.js", () => ({
  deliverWebhooks: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
}));

const { xdr } = await import("@stellar/stellar-sdk");
const { pollEvents, resetFailureState } = await import("../src/indexer/poller.js");
const {
  setDb,
  runMigrations,
  registerContract,
  setLastIndexedLedger,
  getLastIndexedLedger,
  getIndexerStatusData,

} = await import("../src/indexer/db.js");

let testDb: Database.Database;

function goodEvent(ledger: number, eventType: string) {
  return {
    topic: [xdr.ScVal.scvSymbol(eventType)],
    value: xdr.ScVal.scvU32(5),
    ledger,
    ledgerClosedAt: "2026-10-21T00:00:00Z",
  };
}

/** topic is null, so reading topic[0] throws while decoding. */
function brokenEvent(ledger: number) {
  return {
    id: "evt-broken",
    topic: null,
    value: xdr.ScVal.scvU32(9),
    ledger,
    ledgerClosedAt: "2026-10-21T00:00:00Z",
  };
}

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
  testDb.exec("DELETE FROM events");
  testDb.exec("DELETE FROM undecodable_events");
  testDb.exec("DELETE FROM monitored_contracts");
  setLastIndexedLedger(1000);
  registerContract("C-UNDEC");
  mockGetLatestLedger.mockReset();
  mockGetEvents.mockReset();
  mockGetLatestLedger.mockResolvedValue({ sequence: 1010 });
});

describe("pollEvents() with an undecodable event (#658)", () => {
  it("stores 2 events and 1 undecodable row, and the pointer advances", async () => {
    mockGetEvents.mockResolvedValue({
      events: [goodEvent(1003, "initialized"), brokenEvent(1005), goodEvent(1007, "funded")],
    });

    await pollEvents();

    const events = testDb.prepare("SELECT * FROM events").all();
    const undecodable = testDb.prepare("SELECT * FROM undecodable_events").all() as any[];

    expect(events).toHaveLength(2);
    expect(undecodable).toHaveLength(1);
    expect(undecodable[0].ledger_sequence).toBe(1005);
    expect(undecodable[0].event_id).toBe("evt-broken");
    expect(undecodable[0].error_message.length).toBeGreaterThan(0);
    expect(getLastIndexedLedger()).toBe(1010);
  });


  it("reports the undecodable count in the status data", async () => {
    mockGetEvents.mockResolvedValue({
      events: [goodEvent(1003, "initialized"), brokenEvent(1005), goodEvent(1007, "funded")],
    });

    await pollEvents();

    expect(getIndexerStatusData().undecodableEvents).toBe(1);
  });
});