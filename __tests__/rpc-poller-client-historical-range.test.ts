import Database from "better-sqlite3";
import { setDb, runMigrations, closeDb } from "../src/indexer/db.js";
import {
  RpcPollerClient,
  countEventsByLedger,
  mapRpcEventToRow,
  DEFAULT_RPC_HISTORICAL_PAGE_SIZE,
  type RpcServerLike,
} from "../src/indexer/rpc-poller-client.js";
import { LedgerRangeValidationError } from "../src/indexer/ledger-range-tracker.js";

const CONTRACT_ID = "CTEST0000000000000000000000000000000000000000000000000001";
const EVENT_TYPES = ["initialized", "funded", "approved"];

interface StubEvent {
  id: string;
  pagingToken: string;
  contractId: string;
  topic: string[];
  ledger: number;
  ledgerClosedAt: string;
  value: { ledger: number; index: number };
}

/**
 * Build `perLedger` distinct events for every ledger in [start, end].
 * Event types differ within a ledger so each row is a distinct identity under
 * the events table's UNIQUE(contract_id, ledger_sequence, event_type).
 */
function buildEvents(
  start: number,
  end: number,
  perLedger: number,
  contractId = CONTRACT_ID
): StubEvent[] {
  const events: StubEvent[] = [];
  for (let ledger = start; ledger <= end; ledger++) {
    for (let index = 0; index < perLedger; index++) {
      events.push({
        id: `${ledger}-${index}`,
        pagingToken: `${ledger}-${index}`,
        contractId,
        topic: [EVENT_TYPES[index % EVENT_TYPES.length]],
        ledger,
        ledgerClosedAt: new Date(1_700_000_000_000 + ledger * 5000).toISOString(),
        value: { ledger, index },
      });
    }
  }
  return events;
}

/**
 * Stub RPC server that serves a fixed, ledger-ordered event list with cursor
 * pagination, mirroring the Soroban RPC getEvents contract.
 */
class StubRpcServer implements RpcServerLike {
  readonly calls: any[] = [];

  constructor(
    private readonly events: StubEvent[],
    private readonly latestLedger = 10_000
  ) {}

  async getLatestLedger(): Promise<{ sequence: number }> {
    return { sequence: this.latestLedger };
  }

  async getEvents(params: any): Promise<any> {
    this.calls.push({ ...params });
    const limit = params.limit ?? 100;

    let from: number;
    if (params.cursor) {
      from = this.events.findIndex((e) => e.pagingToken === params.cursor) + 1;
    } else {
      const idx = this.events.findIndex((e) => e.ledger >= params.startLedger);
      from = idx === -1 ? this.events.length : idx;
    }

    const page = this.events.slice(from, from + limit);
    return {
      events: page,
      latestLedger: this.latestLedger,
      cursor: page.length > 0 ? page[page.length - 1].pagingToken : undefined,
    };
  }
}

function makeClient(
  events: StubEvent[],
  options: Record<string, unknown> = {}
): { client: RpcPollerClient; server: StubRpcServer } {
  const server = new StubRpcServer(events);
  const client = new RpcPollerClient("https://rpc.invalid", {
    server,
    initialBackoffMs: 1,
    maxRetries: 1,
    ...options,
  });
  return { client, server };
}

describe("RpcPollerClient – dynamic historical sync ranges (#272)", () => {
  const envKeys = ["LEDGER_RANGE_START", "LEDGER_RANGE_END"];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  describe("resolveHistoricalRange", () => {
    it("accepts explicit dynamic start and end ledgers", () => {
      const { client } = makeClient([]);
      expect(client.resolveHistoricalRange({ startLedger: 25, endLedger: 90 })).toEqual({
        startLedger: 25,
        endLedger: 90,
      });
    });

    it("accepts a single-ledger range", () => {
      const { client } = makeClient([]);
      expect(client.resolveHistoricalRange({ startLedger: 7, endLedger: 7 })).toEqual({
        startLedger: 7,
        endLedger: 7,
      });
    });

    it("falls back to LEDGER_RANGE_START / LEDGER_RANGE_END", () => {
      process.env.LEDGER_RANGE_START = "120";
      process.env.LEDGER_RANGE_END = "180";
      const { client } = makeClient([]);
      expect(client.resolveHistoricalRange()).toEqual({
        startLedger: 120,
        endLedger: 180,
      });
    });

    it("prefers explicit values over env values", () => {
      process.env.LEDGER_RANGE_START = "120";
      process.env.LEDGER_RANGE_END = "180";
      const { client } = makeClient([]);
      expect(
        client.resolveHistoricalRange({ startLedger: 5, endLedger: 9 })
      ).toEqual({ startLedger: 5, endLedger: 9 });
    });

    it("falls back to caller defaults when nothing else is configured", () => {
      const { client } = makeClient([]);
      expect(
        client.resolveHistoricalRange({ defaultStart: 41, defaultEnd: 55 })
      ).toEqual({ startLedger: 41, endLedger: 55 });
    });

    it("rejects an inverted range", () => {
      const { client } = makeClient([]);
      expect(() =>
        client.resolveHistoricalRange({ startLedger: 90, endLedger: 20 })
      ).toThrow(LedgerRangeValidationError);
    });

    it("rejects non-positive and non-integer ledgers", () => {
      const { client } = makeClient([]);
      expect(() =>
        client.resolveHistoricalRange({ startLedger: 0, endLedger: 10 })
      ).toThrow(LedgerRangeValidationError);
      expect(() =>
        client.resolveHistoricalRange({ startLedger: -3, endLedger: 10 })
      ).toThrow(LedgerRangeValidationError);
      expect(() =>
        client.resolveHistoricalRange({ startLedger: 1, endLedger: 10.5 })
      ).toThrow(LedgerRangeValidationError);
    });

    it("requires a start and an end to be resolvable", () => {
      const { client } = makeClient([]);
      expect(() => client.resolveHistoricalRange()).toThrow(
        LedgerRangeValidationError
      );
      expect(() => client.resolveHistoricalRange({ startLedger: 4 })).toThrow(
        /end ledger is required/
      );
      expect(() => client.resolveHistoricalRange({ endLedger: 4 })).toThrow(
        /start ledger is required/
      );
    });
  });

  describe("fetchEventRange", () => {
    it("returns exactly the events inside the requested range", async () => {
      const { client } = makeClient(buildEvents(1, 40, 2));

      const result = await client.fetchEventRange({
        startLedger: 10,
        endLedger: 19,
      });

      expect(result.range).toEqual({ startLedger: 10, endLedger: 19 });
      expect(result.eventCount).toBe(20);
      const ledgers = result.events.map((e) => e.ledger);
      expect(Math.min(...ledgers)).toBe(10);
      expect(Math.max(...ledgers)).toBe(19);
    });

    it("reports the correct block event count for every ledger in range", async () => {
      const { client } = makeClient(buildEvents(1, 30, 3));

      const result = await client.fetchEventRange({
        startLedger: 5,
        endLedger: 12,
      });

      expect(result.ledgerEventCounts).toEqual(
        Array.from({ length: 8 }, (_, i) => ({
          ledgerSequence: 5 + i,
          eventCount: 3,
        }))
      );
      expect(
        result.ledgerEventCounts.reduce((sum, c) => sum + c.eventCount, 0)
      ).toBe(result.eventCount);
    });

    it("preserves uneven per-block counts", async () => {
      const events = [
        ...buildEvents(5, 5, 3),
        ...buildEvents(6, 6, 1),
        ...buildEvents(7, 7, 2),
      ];
      const { client } = makeClient(events);

      const result = await client.fetchEventRange({
        startLedger: 5,
        endLedger: 7,
      });

      expect(result.ledgerEventCounts).toEqual([
        { ledgerSequence: 5, eventCount: 3 },
        { ledgerSequence: 6, eventCount: 1 },
        { ledgerSequence: 7, eventCount: 2 },
      ]);
    });

    it("splits a wide range into inclusive pages of pageSize ledgers", async () => {
      const { client } = makeClient(buildEvents(1, 25, 1));

      const result = await client.fetchEventRange({
        startLedger: 1,
        endLedger: 25,
        pageSize: 10,
      });

      expect(result.pages).toEqual([
        { startLedger: 1, endLedger: 10 },
        { startLedger: 11, endLedger: 20 },
        { startLedger: 21, endLedger: 25 },
      ]);
      expect(result.eventCount).toBe(25);
    });

    it("walks the RPC cursor when a page holds more events than one limit", async () => {
      const { client, server } = makeClient(buildEvents(1, 20, 3));

      const result = await client.fetchEventRange({
        startLedger: 1,
        endLedger: 20,
        pageSize: 20,
        limit: 5,
      });

      // 60 in-range events at 5 per call cannot come from a single request.
      expect(result.eventCount).toBe(60);
      expect(result.requestCount).toBeGreaterThan(1);
      expect(server.calls.filter((c) => c.cursor).length).toBeGreaterThan(0);
      expect(result.ledgerEventCounts).toHaveLength(20);
      expect(result.ledgerEventCounts.every((c) => c.eventCount === 3)).toBe(true);
    });

    it("never counts an event twice when pages and cursors overlap", async () => {
      const { client } = makeClient(buildEvents(1, 12, 2));

      const result = await client.fetchEventRange({
        startLedger: 1,
        endLedger: 12,
        pageSize: 3,
        limit: 4,
      });

      const ids = result.events.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(result.eventCount).toBe(24);
    });

    it("stops at the end ledger and drops later events", async () => {
      const { client } = makeClient(buildEvents(1, 100, 1));

      const result = await client.fetchEventRange({
        startLedger: 2,
        endLedger: 4,
        limit: 50,
      });

      expect(result.events.map((e) => e.ledger)).toEqual([2, 3, 4]);
    });

    it("returns an empty result for a range with no events", async () => {
      const { client } = makeClient(buildEvents(1, 5, 1));

      const result = await client.fetchEventRange({
        startLedger: 50,
        endLedger: 60,
      });

      expect(result.eventCount).toBe(0);
      expect(result.ledgerEventCounts).toEqual([]);
    });

    it("forwards filters and the resolved page start to the RPC", async () => {
      const { client, server } = makeClient(buildEvents(1, 10, 1));
      const filters = [{ type: "contract", contractIds: [CONTRACT_ID] }];

      await client.fetchEventRange({
        startLedger: 3,
        endLedger: 6,
        filters,
        limit: 25,
      });

      expect(server.calls[0]).toMatchObject({
        startLedger: 3,
        filters,
        limit: 25,
      });
    });

    it("resolves the range from env when no explicit values are given", async () => {
      process.env.LEDGER_RANGE_START = "4";
      process.env.LEDGER_RANGE_END = "6";
      const { client } = makeClient(buildEvents(1, 20, 2));

      const result = await client.fetchEventRange();

      expect(result.range).toEqual({ startLedger: 4, endLedger: 6 });
      expect(result.eventCount).toBe(6);
    });

    it("rejects invalid page sizes and limits", async () => {
      const { client } = makeClient(buildEvents(1, 5, 1));

      await expect(
        client.fetchEventRange({ startLedger: 1, endLedger: 5, pageSize: 0 })
      ).rejects.toThrow(LedgerRangeValidationError);
      await expect(
        client.fetchEventRange({ startLedger: 1, endLedger: 5, limit: -2 })
      ).rejects.toThrow(LedgerRangeValidationError);
    });

    it("rejects an invalid range before issuing any RPC call", async () => {
      const { client, server } = makeClient(buildEvents(1, 5, 1));

      await expect(
        client.fetchEventRange({ startLedger: 9, endLedger: 2 })
      ).rejects.toThrow(LedgerRangeValidationError);
      expect(server.calls).toHaveLength(0);
    });

    it("retries a transient RPC failure and still returns the full range", async () => {
      const events = buildEvents(1, 5, 2);
      const server = new StubRpcServer(events);
      const realGetEvents = server.getEvents.bind(server);
      let failed = false;
      (server as any).getEvents = async (params: any) => {
        if (!failed) {
          failed = true;
          throw new Error("ETIMEDOUT");
        }
        return realGetEvents(params);
      };

      const client = new RpcPollerClient("https://rpc.invalid", {
        server,
        initialBackoffMs: 1,
        maxRetries: 3,
      });

      const result = await client.fetchEventRange({
        startLedger: 1,
        endLedger: 5,
      });
      expect(result.eventCount).toBe(10);
    });
  });

  describe("countEventsByLedger", () => {
    it("counts raw RPC events and mapped rows alike", () => {
      expect(
        countEventsByLedger([{ ledger: 4 }, { ledger: 4 }, { ledger: 6 }])
      ).toEqual([
        { ledgerSequence: 4, eventCount: 2 },
        { ledgerSequence: 6, eventCount: 1 },
      ]);
      expect(
        countEventsByLedger([{ ledgerSequence: 9 }, { ledgerSequence: 8 }])
      ).toEqual([
        { ledgerSequence: 8, eventCount: 1 },
        { ledgerSequence: 9, eventCount: 1 },
      ]);
    });

    it("ignores events without a usable ledger", () => {
      expect(countEventsByLedger([{ ledger: "abc" }, { ledger: 2 }])).toEqual([
        { ledgerSequence: 2, eventCount: 1 },
      ]);
    });
  });

  describe("mapRpcEventToRow", () => {
    it("maps SDK-shaped events into indexer rows", () => {
      const row = mapRpcEventToRow({
        contractId: { contractId: () => CONTRACT_ID },
        topic: ["funded"],
        ledger: 12,
        ledgerClosedAt: "2024-01-01T00:00:00Z",
        value: { amount: 5 },
      });

      expect(row).toEqual({
        contractId: CONTRACT_ID,
        eventType: "funded",
        ledgerSequence: 12,
        timestamp: Math.floor(Date.parse("2024-01-01T00:00:00Z") / 1000),
        dataJson: JSON.stringify({ amount: 5 }),
      });
    });

    it("falls back to the supplied contract id", () => {
      const row = mapRpcEventToRow({ topic: ["funded"], ledger: 3 }, "CFALLBACK");
      expect(row.contractId).toBe("CFALLBACK");
    });
  });

  it("exposes a sane default page size", () => {
    expect(DEFAULT_RPC_HISTORICAL_PAGE_SIZE).toBe(100);
  });

  describe("syncHistoricalRange – indexed block event counts", () => {
    let testDb: Database.Database;

    beforeEach(() => {
      testDb = new Database(":memory:");
      setDb(testDb);
      runMigrations();
    });

    afterEach(() => {
      closeDb();
    });

    function indexedCountsByLedger(): Array<{
      ledgerSequence: number;
      eventCount: number;
    }> {
      return (
        testDb
          .prepare(
            `SELECT ledger_sequence AS ledgerSequence, COUNT(*) AS eventCount
             FROM events GROUP BY ledger_sequence ORDER BY ledger_sequence`
          )
          .all() as Array<{ ledgerSequence: number; eventCount: number }>
      ).map((row) => ({
        ledgerSequence: row.ledgerSequence,
        eventCount: row.eventCount,
      }));
    }

    it("indexes the correct block event count for every ledger in the range", async () => {
      const { client } = makeClient(buildEvents(1, 40, 3), { historicalPageSize: 7 });

      const result = await client.syncHistoricalRange({
        startLedger: 10,
        endLedger: 20,
      });

      const expected = Array.from({ length: 11 }, (_, i) => ({
        ledgerSequence: 10 + i,
        eventCount: 3,
      }));

      expect(result.eventCount).toBe(33);
      expect(result.insertedCount).toBe(33);
      expect(result.ledgerEventCounts).toEqual(expected);
      expect(indexedCountsByLedger()).toEqual(expected);
    });

    it("indexes uneven per-block counts exactly as fetched", async () => {
      const events = [
        ...buildEvents(101, 101, 3),
        ...buildEvents(102, 102, 1),
        ...buildEvents(104, 104, 2),
      ];
      const { client } = makeClient(events);

      const result = await client.syncHistoricalRange({
        startLedger: 100,
        endLedger: 105,
      });

      const expected = [
        { ledgerSequence: 101, eventCount: 3 },
        { ledgerSequence: 102, eventCount: 1 },
        { ledgerSequence: 104, eventCount: 2 },
      ];
      expect(result.insertedCount).toBe(6);
      expect(indexedCountsByLedger()).toEqual(expected);
      expect(result.ledgerEventCounts).toEqual(expected);
    });

    it("does not index events outside the requested range", async () => {
      const { client } = makeClient(buildEvents(1, 50, 2));

      await client.syncHistoricalRange({ startLedger: 20, endLedger: 22 });

      expect(indexedCountsByLedger()).toEqual([
        { ledgerSequence: 20, eventCount: 2 },
        { ledgerSequence: 21, eventCount: 2 },
        { ledgerSequence: 22, eventCount: 2 },
      ]);
    });

    it("is idempotent when the same range is re-imported", async () => {
      const { client } = makeClient(buildEvents(1, 10, 2));

      const first = await client.syncHistoricalRange({
        startLedger: 3,
        endLedger: 6,
      });
      const second = await client.syncHistoricalRange({
        startLedger: 3,
        endLedger: 6,
      });

      expect(first.insertedCount).toBe(8);
      expect(second.insertedCount).toBe(0);
      expect(second.duplicateCount).toBe(8);
      expect(
        (testDb.prepare("SELECT COUNT(*) AS c FROM events").get() as any).c
      ).toBe(8);
    });

    it("indexes an adjacent range without touching the first one", async () => {
      const { client } = makeClient(buildEvents(1, 20, 1));

      await client.syncHistoricalRange({ startLedger: 1, endLedger: 5 });
      const second = await client.syncHistoricalRange({
        startLedger: 6,
        endLedger: 10,
      });

      expect(second.insertedCount).toBe(5);
      expect(indexedCountsByLedger()).toHaveLength(10);
    });

    it("leaves the live ledger pointer untouched", async () => {
      const { client } = makeClient(buildEvents(1, 10, 1));

      await client.syncHistoricalRange({ startLedger: 2, endLedger: 4 });

      const row = testDb
        .prepare(
          "SELECT value FROM indexer_state WHERE key = 'last_ledger_sequence'"
        )
        .get() as { value: string } | undefined;
      expect(row?.value).toBe("0");
    });
  });
});
