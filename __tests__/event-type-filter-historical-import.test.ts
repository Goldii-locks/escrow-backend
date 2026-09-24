import { jest } from "@jest/globals";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Mock the Stellar RPC server, following the same jest.unstable_mockModule
// convention used in build-tx.test.ts / poller-dynamic-interval.test.ts.
// ---------------------------------------------------------------------------

const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetEvents = jest.fn<(req: any) => Promise<{ events: any[]; cursor: string }>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getLatestLedger = mockGetLatestLedger;
    getEvents = mockGetEvents;
  },
}));

jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  scValToNative: (value: unknown) => value,
}));

const { fetchHistoricalEvents, validateHistoricalRange } = await import(
  "../src/indexer/poller.js"
);

const { setDb, runMigrations, registerContract, getLastIndexedLedger, setLastIndexedLedger } =
  await import("../src/indexer/db.js");

function fakeEvent(ledger: number, eventType: string, contractId = "CONTRACT-HIST") {
  return {
    contractId: { contractId: () => contractId },
    topic: [eventType],
    ledger,
    ledgerClosedAt: null,
    value: { some: "value" },
  };
}

describe("event_type_filter — dynamic start/end ledger historical import", () => {
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
    registerContract("CONTRACT-HIST", "hist-test");
    mockGetLatestLedger.mockReset();
    mockGetEvents.mockReset();
  });

  // -------------------------------------------------------------------
  // Range validation - reuse-worthy, standalone logic
  // -------------------------------------------------------------------

  describe("validateHistoricalRange()", () => {
    it("accepts a sane in-range request", () => {
      expect(validateHistoricalRange(100, 200, 500)).toEqual({ valid: true });
    });

    it("rejects start > end", () => {
      const result = validateHistoricalRange(200, 100, 500);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/startLedger must be <= endLedger/);
    });

    it("rejects a ledger sequence that does not exist yet (end beyond chain head)", () => {
      const result = validateHistoricalRange(100, 600, 500);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/does not exist yet/);
    });

    it("rejects non-positive ledger numbers", () => {
      expect(validateHistoricalRange(0, 100, 500).valid).toBe(false);
      expect(validateHistoricalRange(-5, 100, 500).valid).toBe(false);
    });

    it("rejects a range exceeding the max ledgers per import", () => {
      const result = validateHistoricalRange(1, 50_000, 100_000);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/exceeding the/);
    });
  });

  // -------------------------------------------------------------------
  // fetchHistoricalEvents() — correct block event counts are indexed
  // -------------------------------------------------------------------

  describe("fetchHistoricalEvents()", () => {
    it("imports exactly the events returned for the requested range (correct event counts indexed)", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 1000 });
      mockGetEvents.mockResolvedValue({
        events: [
          fakeEvent(100, "initialized"),
          fakeEvent(101, "funded"),
          fakeEvent(102, "delivered"),
        ],
        cursor: "c1",
      });

      const result = await fetchHistoricalEvents(100, 102);

      expect(result.eventsFound).toBe(3);
      expect(result.eventsImported).toBe(3);

      const rows = testDb.prepare("SELECT * FROM events ORDER BY ledger_sequence").all() as any[];
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.ledger_sequence)).toEqual([100, 101, 102]);
      expect(rows.map((r) => r.event_type)).toEqual(["initialized", "funded", "delivered"]);
    });

    it("does not advance or rewind the live last_ledger_sequence pointer", async () => {
      setLastIndexedLedger(5000); // live poller is far ahead of this backfill range

      mockGetLatestLedger.mockResolvedValue({ sequence: 6000 });
      mockGetEvents.mockResolvedValue({
        events: [fakeEvent(100, "initialized")],
        cursor: "c1",
      });

      await fetchHistoricalEvents(100, 100);

      expect(getLastIndexedLedger()).toBe(5000); // unchanged
    });

    it("is idempotent - re-running the same import produces zero duplicate rows", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 1000 });
      mockGetEvents.mockResolvedValue({
        events: [fakeEvent(100, "initialized"), fakeEvent(101, "funded")],
        cursor: "c1",
      });

      const first = await fetchHistoricalEvents(100, 101);
      expect(first.eventsImported).toBe(2);

      const second = await fetchHistoricalEvents(100, 101);
      expect(second.eventsFound).toBe(2); // still found on the wire
      expect(second.eventsImported).toBe(0); // but nothing new written (dup-prevented)

      const rows = testDb.prepare("SELECT COUNT(*) as n FROM events").get() as { n: number };
      expect(rows.n).toBe(2);
    });

    it("pages through multiple 100-event pages via cursor until the range is fully collected", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 1000 });

      const pageOne = Array.from({ length: 100 }, (_, i) => fakeEvent(200 + i, "funded"));
      const pageTwo = Array.from({ length: 40 }, (_, i) => fakeEvent(300 + i, "delivered"));

      mockGetEvents
        .mockResolvedValueOnce({ events: pageOne, cursor: "page-2-cursor" })
        .mockResolvedValueOnce({ events: pageTwo, cursor: "page-3-cursor" });

      const result = await fetchHistoricalEvents(200, 400);

      expect(result.eventsFound).toBe(140);
      expect(result.eventsImported).toBe(140);
      expect(mockGetEvents).toHaveBeenCalledTimes(2);

      // Second call uses cursor-mode pagination, not startLedger/endLedger again.
      const secondCallArgs = mockGetEvents.mock.calls[1][0] as any;
      expect(secondCallArgs.cursor).toBe("page-2-cursor");
      expect(secondCallArgs.startLedger).toBeUndefined();
    });

    it("rejects an invalid range before ever calling getEvents", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 1000 });

      await expect(fetchHistoricalEvents(500, 100)).rejects.toThrow(
        /startLedger must be <= endLedger/
      );
      expect(mockGetEvents).not.toHaveBeenCalled();
    });

    it("rejects a range whose end is beyond the current chain head", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 500 });

      await expect(fetchHistoricalEvents(100, 600)).rejects.toThrow(/does not exist yet/);
      expect(mockGetEvents).not.toHaveBeenCalled();
    });
  });
});
