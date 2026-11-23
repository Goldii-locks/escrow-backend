import { jest } from "@jest/globals";
import Database from "better-sqlite3";

/**
 * #657: scValToNative returns i128/u64/u128 as bigint and JSON.stringify
 * throws on bigint, which failed the whole poll and froze the ledger pointer.
 * This test feeds real SDK-built ScVals through pollEvents.
 */

const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetEvents = jest.fn<(params: any) => Promise<{ events: unknown[] }>>();
const mockDeliverWebhooks = jest.fn<(start: number, end: number) => Promise<unknown[]>>();

// Only the RPC server is mocked. The real SDK builds and decodes the ScVals.
jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getLatestLedger = mockGetLatestLedger;
    getEvents = mockGetEvents;
  },
}));

jest.unstable_mockModule("../src/indexer/webhook-delivery.js", () => ({
  deliverWebhooks: mockDeliverWebhooks,
}));

const { nativeToScVal, xdr } = await import("@stellar/stellar-sdk");
const { pollEvents, resetFailureState } = await import("../src/indexer/poller.js");
const { setDb, runMigrations, registerContract, setLastIndexedLedger, getLastIndexedLedger } =
  await import("../src/indexer/db.js");

let testDb: Database.Database;


const MAX_I128 = 2n ** 127n - 1n;
const ABOVE_2_53 = 9007199254740993n; // Number.MAX_SAFE_INTEGER + 2

function mapEntry(key: string, val: any) {
  return new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
}

/** An InitializedEvent-shaped event built with the real SDK. */
function buildEvent(ledger: number, eventType: string, totalAmount: bigint, autoRelease: bigint) {
  return {
    topic: [xdr.ScVal.scvSymbol(eventType)],
    value: xdr.ScVal.scvMap([
      mapEntry("auto_release_seconds", nativeToScVal(autoRelease, { type: "u64" })),
      mapEntry("total_amount", nativeToScVal(totalAmount, { type: "i128" })),
    ]),
    ledger,
    ledgerClosedAt: "2026-10-21T00:00:00Z",
  };
}

function storedRows(): Array<{ ledger_sequence: number; data_json: string }> {
  return testDb
    .prepare("SELECT ledger_sequence, data_json FROM events ORDER BY ledger_sequence")
    .all() as Array<{ ledger_sequence: number; data_json: string }>;
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
  testDb.exec("DELETE FROM monitored_contracts");
  setLastIndexedLedger(1000);
  registerContract("C-BIGINT");
  mockGetLatestLedger.mockReset();
  mockGetEvents.mockReset();
  mockDeliverWebhooks.mockReset();
  mockDeliverWebhooks.mockResolvedValue([]);
  mockGetLatestLedger.mockResolvedValue({ sequence: 1010 });
});

describe("pollEvents() with i128/u64 event fields (#657)", () => {
  it("stores amounts as decimal strings and advances the ledger pointer", async () => {
    mockGetEvents.mockResolvedValue({
      events: [buildEvent(1005, "initialized", 1000n, 86400n)],
    });

    await pollEvents();

    const rows = storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].data_json).toContain('"total_amount":"1000"');
    expect(rows[0].data_json).toContain('"auto_release_seconds":"86400"');
    expect(getLastIndexedLedger()).toBe(1010);
  });


  it("round-trips amounts above 2^53 exactly", async () => {
    mockGetEvents.mockResolvedValue({
      events: [
        buildEvent(1004, "initialized", ABOVE_2_53, 1n),
        buildEvent(1006, "funded", MAX_I128, 2n),
      ],
    });

    await pollEvents();

    const rows = storedRows();
    expect(rows).toHaveLength(2);
    expect(BigInt(JSON.parse(rows[0].data_json).total_amount)).toBe(ABOVE_2_53);
    expect(BigInt(JSON.parse(rows[1].data_json).total_amount)).toBe(MAX_I128);
  });
});