import { jest } from "@jest/globals";
import Database from "better-sqlite3";

/**
 * #930: topics_json stores every topic after the first, decoded and
 * BigInt-safe. topic[0] must decode to a string; non-string first topics
 * are routed to undecodable_events.
 */

const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetEvents = jest.fn<(params: any) => Promise<{ events: unknown[] }>>();
const mockDeliverWebhooks = jest.fn<(start: number, end: number) => Promise<unknown[]>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getLatestLedger = mockGetLatestLedger;
    getEvents = mockGetEvents;
  },
}));

jest.unstable_mockModule("../src/indexer/webhook-delivery.js", () => ({
  deliverWebhooks: mockDeliverWebhooks,
}));

const { nativeToScVal, xdr, Address } = await import("@stellar/stellar-sdk");
const { pollEvents, resetFailureState } = await import("../src/indexer/poller.js");
const { setDb, runMigrations, registerContract, setLastIndexedLedger } =
  await import("../src/indexer/db.js");

let testDb: Database.Database;

const GABC = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function buildEvent(ledger: number, topics: unknown[], value?: unknown) {
  return {
    topic: topics,
    value: value ?? xdr.ScVal.scvU32(0),
    ledger,
    ledgerClosedAt: "2026-10-21T00:00:00Z",
  };
}

function storedEvents(): Array<{ event_type: string; topics_json: string | null; data_json: string }> {
  return testDb
    .prepare("SELECT event_type, topics_json, data_json FROM events ORDER BY ledger_sequence")
    .all() as Array<{ event_type: string; topics_json: string | null; data_json: string }>;
}

function storedUndecodable(): Array<{ error_message: string }> {
  return testDb
    .prepare("SELECT error_message FROM undecodable_events")
    .all() as Array<{ error_message: string }>;
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
  registerContract("C-TOPICS");
  mockGetLatestLedger.mockReset();
  mockGetEvents.mockReset();
  mockDeliverWebhooks.mockReset();
  mockDeliverWebhooks.mockResolvedValue([]);
  mockGetLatestLedger.mockResolvedValue({ sequence: 1010 });
});

describe("event topics_json (#930)", () => {
  it("stores topics_json as JSON array of extra topics", async () => {
    mockGetEvents.mockResolvedValue({
      events: [
        buildEvent(1005, [
          xdr.ScVal.scvSymbol("approve"),
          new Address(GABC).toScVal(),
        ]),
      ],
    });

    await pollEvents();

    const rows = storedEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("approve");
    expect(JSON.parse(rows[0].topics_json!)).toEqual([GABC]);
  });

  it("stores null topics_json when there are no extra topics", async () => {
    mockGetEvents.mockResolvedValue({
      events: [
        buildEvent(1005, [xdr.ScVal.scvSymbol("initialized")]),
      ],
    });

    await pollEvents();

    const rows = storedEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0].topics_json).toBeNull();
  });

  it("preserves all extra topics", async () => {
    const GABC2 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF";
    mockGetEvents.mockResolvedValue({
      events: [
        buildEvent(1005, [
          xdr.ScVal.scvSymbol("transfer"),
          new Address(GABC).toScVal(),
          new Address(GABC).toScVal(),
          nativeToScVal(42n, { type: "i128" }),
        ]),
      ],
    });

    await pollEvents();

    const rows = storedEvents();
    expect(rows).toHaveLength(1);
    const extra = JSON.parse(rows[0].topics_json!);
    expect(extra).toHaveLength(3);
    expect(extra[0]).toBe(GABC);
    expect(extra[1]).toBe(GABC);
    // bigint decodes to string via stringifyWithBigInt
    expect(extra[2]).toBe("42");
  });

  it("BigInt extra topic is serialized as decimal string", async () => {
    const ABOVE_SAFE = 9007199254740993n;
    mockGetEvents.mockResolvedValue({
      events: [
        buildEvent(1005, [
          xdr.ScVal.scvSymbol("funded"),
          nativeToScVal(ABOVE_SAFE, { type: "i128" }),
        ]),
      ],
    });

    await pollEvents();

    const rows = storedEvents();
    expect(rows).toHaveLength(1);
    const extra = JSON.parse(rows[0].topics_json!);
    expect(extra).toHaveLength(1);
    expect(extra[0]).toBe("9007199254740993");
  });

  it("routes non-string topic[0] to undecodable_events", async () => {
    mockGetEvents.mockResolvedValue({
      events: [
        buildEvent(1005, [nativeToScVal(123n, { type: "i128" })]),
      ],
    });

    await pollEvents();

    const events = storedEvents();
    const undecodable = storedUndecodable();
    expect(events).toHaveLength(0);
    expect(undecodable).toHaveLength(1);
    expect(undecodable[0].error_message.length).toBeGreaterThan(0);
  });

  it("existing event persistence behavior is unchanged", async () => {
    mockGetEvents.mockResolvedValue({
      events: [
        buildEvent(
          1005,
          [xdr.ScVal.scvSymbol("initialized")],
          xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvSymbol("amount"),
              val: nativeToScVal(1000n, { type: "i128" }),
            }),
          ]),
        ),
      ],
    });

    await pollEvents();

    const rows = storedEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("initialized");
    expect(rows[0].data_json).toContain('"amount"');
    expect(rows[0].topics_json).toBeNull();
  });
});
