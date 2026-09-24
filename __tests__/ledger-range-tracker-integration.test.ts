/**
 * Issue #302 — In-memory mock integration tests for ledger_range_tracker
 *
 * These tests simulate the full RPC-event → poller → database pipeline
 * using an in-memory SQLite database and a mocked Stellar RPC server.
 * They verify that real observable database state (rows, ledger pointer,
 * metadata) is correct after simulated RPC events are processed — not
 * merely that mocked functions were called.
 */

import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import { setDb, runMigrations, registerContract, getLastIndexedLedger } from "../src/indexer/db.js";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any dynamic imports
// ---------------------------------------------------------------------------

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule("../src/indexer/webhook-delivery.js", () => ({
  deliverWebhooks: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

// scValToNative: for tests we use plain string values for topic[0], so
// just return the value as-is.
jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  scValToNative: (val: unknown) => val,
}));

const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetEvents = jest.fn<() => Promise<{ events: any[] }>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: jest.fn().mockImplementation(() => ({
    getLatestLedger: mockGetLatestLedger,
    getEvents: mockGetEvents,
  })),
}));

// Dynamic imports after mocks are registered
const { pollEvents, resetFailureState } = await import("../src/indexer/poller.js");
const {
  getLedgerRangeSnapshot,
  readLedgerRange,
  getLedgerRangeMetadata,
  advanceLedgerIfMatch,
} = await import("../src/indexer/ledger-range-tracker.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock RPC event that matches what pollEvents() consumes. */
function makeMockEvent(opts: {
  contractId: string;
  eventType: string;
  ledger: number;
  closedAt?: string;
  value?: unknown;
}) {
  return {
    contractId: { contractId: () => opts.contractId },
    topic: [opts.eventType], // scValToNative returns value as-is in tests
    ledger: opts.ledger,
    ledgerClosedAt: opts.closedAt ?? new Date(opts.ledger * 1000).toISOString(),
    value: opts.value ?? { amount: "1000" },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("LedgerRangeTracker — RPC mock integration tests (#302)", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    testDb.pragma("journal_mode = WAL");
    setDb(testDb);
    runMigrations();
  });

  afterAll(() => {
    testDb.close();
  });

  beforeEach(() => {
    // Reset DB state between tests
    testDb.exec("DELETE FROM events");
    testDb.exec("DELETE FROM monitored_contracts");
    testDb.exec(
      "UPDATE indexer_state SET value = '0' WHERE key = 'last_ledger_sequence'"
    );
    resetFailureState();
    jest.clearAllMocks();

    // Always have one active contract so pollEvents() doesn't exit early
    registerContract("CONTRACT-ALPHA", "integration-test");
  });

  // -------------------------------------------------------------------------
  // 1. Normal event: single RPC event processed successfully
  // -------------------------------------------------------------------------

  describe("normal RPC event processing", () => {
    it("processes a single RPC event and writes it to the database", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
      mockGetEvents.mockResolvedValue({
        events: [
          makeMockEvent({
            contractId: "CONTRACT-ALPHA",
            eventType: "initialized",
            ledger: 100,
          }),
        ],
      });

      await pollEvents();

      const rows = testDb.prepare("SELECT * FROM events").all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].contract_id).toBe("CONTRACT-ALPHA");
      expect(rows[0].event_type).toBe("initialized");
      expect(rows[0].ledger_sequence).toBe(100);
    });

    it("advances the ledger pointer after a successful poll", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 200 });
      mockGetEvents.mockResolvedValue({ events: [] });

      await pollEvents();

      expect(getLastIndexedLedger()).toBe(200);
    });

    it("records the correct timestamp derived from ledgerClosedAt", async () => {
      const closedAt = "2024-01-15T12:00:00.000Z";
      const expectedTimestamp = Math.floor(new Date(closedAt).getTime() / 1000);

      mockGetLatestLedger.mockResolvedValue({ sequence: 150 });
      mockGetEvents.mockResolvedValue({
        events: [
          makeMockEvent({
            contractId: "CONTRACT-ALPHA",
            eventType: "funded",
            ledger: 150,
            closedAt,
          }),
        ],
      });

      await pollEvents();

      const row = testDb
        .prepare("SELECT timestamp FROM events WHERE event_type = 'funded'")
        .get() as any;
      expect(row).toBeTruthy();
      expect(row.timestamp).toBe(expectedTimestamp);
    });

    it("stores event data_json as the serialised value from the RPC event", async () => {
      const payload = { client: "GCLIENT", freelancer: "GFREELANCER", amount: "5000" };

      mockGetLatestLedger.mockResolvedValue({ sequence: 101 });
      mockGetEvents.mockResolvedValue({
        events: [
          makeMockEvent({
            contractId: "CONTRACT-ALPHA",
            eventType: "initialized",
            ledger: 101,
            value: payload,
          }),
        ],
      });

      await pollEvents();

      const row = testDb
        .prepare("SELECT data_json FROM events WHERE ledger_sequence = 101")
        .get() as any;
      expect(JSON.parse(row.data_json)).toEqual(payload);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Database records are created correctly
  // -------------------------------------------------------------------------

  describe("database record integrity", () => {
    it("creates a complete event row with all required columns populated", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 300 });
      mockGetEvents.mockResolvedValue({
        events: [
          makeMockEvent({
            contractId: "CONTRACT-ALPHA",
            eventType: "delivered",
            ledger: 300,
            closedAt: "2024-06-01T00:00:00.000Z",
            value: { milestone_index: 0 },
          }),
        ],
      });

      await pollEvents();

      const row = testDb
        .prepare("SELECT * FROM events WHERE ledger_sequence = 300")
        .get() as any;

      expect(row.id).toBeGreaterThan(0);
      expect(row.contract_id).toBe("CONTRACT-ALPHA");
      expect(row.event_type).toBe("delivered");
      expect(row.ledger_sequence).toBe(300);
      expect(row.timestamp).toBeGreaterThan(0);
      expect(row.data_json).toBeTruthy();
      expect(row.created_at).toBeTruthy();
    });

    it("does not create a row if the event already exists (deduplication)", async () => {
      // Seed an existing event for ledger 400
      testDb
        .prepare(
          "INSERT INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json) VALUES (?,?,?,?,?)"
        )
        .run("CONTRACT-ALPHA", "initialized", 400, 1234567890, '{"existing":true}');

      // Poll returns the same event again
      mockGetLatestLedger.mockResolvedValue({ sequence: 400 });
      mockGetEvents.mockResolvedValue({
        events: [
          makeMockEvent({
            contractId: "CONTRACT-ALPHA",
            eventType: "initialized",
            ledger: 400,
            value: { duplicate: true },
          }),
        ],
      });

      await pollEvents();

      const rows = testDb
        .prepare("SELECT * FROM events WHERE ledger_sequence = 400")
        .all() as any[];
      expect(rows).toHaveLength(1);
      // Original data_json must be preserved
      expect(JSON.parse(rows[0].data_json)).toEqual({ existing: true });
    });
  });

  // -------------------------------------------------------------------------
  // 3. Multiple events across multiple ledgers
  // -------------------------------------------------------------------------

  describe("multiple events processed correctly", () => {
    it("processes a batch of multiple events in one poll and writes all rows", async () => {
      const events = [
        makeMockEvent({ contractId: "CONTRACT-ALPHA", eventType: "initialized", ledger: 500 }),
        makeMockEvent({ contractId: "CONTRACT-ALPHA", eventType: "funded", ledger: 501 }),
        makeMockEvent({ contractId: "CONTRACT-ALPHA", eventType: "delivered", ledger: 502 }),
      ];

      mockGetLatestLedger.mockResolvedValue({ sequence: 502 });
      mockGetEvents.mockResolvedValue({ events });

      await pollEvents();

      const rows = testDb
        .prepare("SELECT ledger_sequence, event_type FROM events ORDER BY ledger_sequence")
        .all() as any[];

      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ ledger_sequence: 500, event_type: "initialized" });
      expect(rows[1]).toMatchObject({ ledger_sequence: 501, event_type: "funded" });
      expect(rows[2]).toMatchObject({ ledger_sequence: 502, event_type: "delivered" });
    });

    it("processes events across multiple contracts in the same poll", async () => {
      registerContract("CONTRACT-BETA", "integration-test-2");

      const events = [
        makeMockEvent({ contractId: "CONTRACT-ALPHA", eventType: "initialized", ledger: 600 }),
        makeMockEvent({ contractId: "CONTRACT-BETA", eventType: "initialized", ledger: 600 }),
        makeMockEvent({ contractId: "CONTRACT-ALPHA", eventType: "funded", ledger: 601 }),
      ];

      mockGetLatestLedger.mockResolvedValue({ sequence: 601 });
      mockGetEvents.mockResolvedValue({ events });

      await pollEvents();

      const alphaRows = testDb
        .prepare("SELECT * FROM events WHERE contract_id = 'CONTRACT-ALPHA'")
        .all();
      const betaRows = testDb
        .prepare("SELECT * FROM events WHERE contract_id = 'CONTRACT-BETA'")
        .all();

      expect(alphaRows).toHaveLength(2);
      expect(betaRows).toHaveLength(1);
    });

    it("accumulates events correctly over two sequential polls", async () => {
      // First poll: ledgers 1–100
      mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
      mockGetEvents.mockResolvedValue({
        events: [
          makeMockEvent({ contractId: "CONTRACT-ALPHA", eventType: "initialized", ledger: 100 }),
        ],
      });
      await pollEvents();

      expect(getLastIndexedLedger()).toBe(100);

      // Second poll: ledgers 101–200
      mockGetLatestLedger.mockResolvedValue({ sequence: 200 });
      mockGetEvents.mockResolvedValue({
        events: [
          makeMockEvent({ contractId: "CONTRACT-ALPHA", eventType: "funded", ledger: 200 }),
          makeMockEvent({ contractId: "CONTRACT-ALPHA", eventType: "delivered", ledger: 200 }),
        ],
      });
      await pollEvents();

      expect(getLastIndexedLedger()).toBe(200);

      const total = testDb
        .prepare("SELECT COUNT(*) as cnt FROM events")
        .get() as any;
      expect(total.cnt).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Ledger range / state updated correctly
  // -------------------------------------------------------------------------

  describe("ledger range state management", () => {
    it("getLedgerRangeSnapshot reflects the ledger pointer after a poll", async () => {
      const snapshotBefore = getLedgerRangeSnapshot();
      expect(snapshotBefore.lastIndexedLedger).toBe(0);

      mockGetLatestLedger.mockResolvedValue({ sequence: 750 });
      mockGetEvents.mockResolvedValue({ events: [] });

      await pollEvents();

      const snapshotAfter = getLedgerRangeSnapshot();
      expect(snapshotAfter.lastIndexedLedger).toBe(750);
      expect(snapshotAfter.timestamp).toBeGreaterThanOrEqual(snapshotBefore.timestamp);
    });

    it("readLedgerRange returns all events inserted by pollEvents in the given range", async () => {
      const events = [
        makeMockEvent({ contractId: "CONTRACT-ALPHA", eventType: "initialized", ledger: 800 }),
        makeMockEvent({ contractId: "CONTRACT-ALPHA", eventType: "funded", ledger: 850 }),
        makeMockEvent({ contractId: "CONTRACT-ALPHA", eventType: "delivered", ledger: 900 }),
      ];

      mockGetLatestLedger.mockResolvedValue({ sequence: 900 });
      mockGetEvents.mockResolvedValue({ events });
      await pollEvents();

      const rangeEvents = readLedgerRange(800, 900);
      expect(rangeEvents).toHaveLength(3);
    });

    it("getLedgerRangeMetadata returns correct totals after poll", async () => {
      const events = [
        makeMockEvent({ contractId: "CONTRACT-ALPHA", eventType: "initialized", ledger: 1000 }),
        makeMockEvent({ contractId: "CONTRACT-ALPHA", eventType: "initialized", ledger: 1001 }),
        makeMockEvent({ contractId: "CONTRACT-ALPHA", eventType: "funded", ledger: 1002 }),
      ];

      mockGetLatestLedger.mockResolvedValue({ sequence: 1002 });
      mockGetEvents.mockResolvedValue({ events });
      await pollEvents();

      const meta = getLedgerRangeMetadata(1000, 1002);
      expect(meta.totalEvents).toBe(3);
      expect(meta.eventsByType["initialized"]).toBe(2);
      expect(meta.eventsByType["funded"]).toBe(1);
    });

    it("does not advance ledger pointer when network is at same ledger as last indexed", async () => {
      // Set last indexed ledger to 500
      testDb.exec(
        "UPDATE indexer_state SET value = '500' WHERE key = 'last_ledger_sequence'"
      );

      // Network reports same ledger
      mockGetLatestLedger.mockResolvedValue({ sequence: 500 });

      await pollEvents();

      // getEvents should NOT have been called (poller exits early)
      expect(mockGetEvents).not.toHaveBeenCalled();
      // Ledger must remain unchanged
      expect(getLastIndexedLedger()).toBe(500);
    });

    it("advanceLedgerIfMatch reflects the state written by pollEvents", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 1100 });
      mockGetEvents.mockResolvedValue({ events: [] });
      await pollEvents();

      // After the poll, last indexed ledger = 1100
      // Now attempt a CAS advance
      const success = advanceLedgerIfMatch(1100, 1200);
      expect(success).toBe(true);
      expect(getLastIndexedLedger()).toBe(1200);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Error / failure cases
  // -------------------------------------------------------------------------

  describe("error and failure cases", () => {
    it("does not persist any events when the RPC call throws", async () => {
      mockGetLatestLedger.mockRejectedValue(new Error("network timeout"));

      await pollEvents();

      const rows = testDb.prepare("SELECT * FROM events").all();
      expect(rows).toHaveLength(0);
      expect(getLastIndexedLedger()).toBe(0);
    });

    it("does not advance the ledger pointer when getEvents throws", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 999 });
      mockGetEvents.mockRejectedValue(new Error("getEvents failed"));

      await pollEvents();

      expect(getLastIndexedLedger()).toBe(0);
    });

    it("recovers and processes events normally on the next poll after an error", async () => {
      // First poll fails
      mockGetLatestLedger.mockRejectedValue(new Error("transient failure"));
      await pollEvents();
      expect(getLastIndexedLedger()).toBe(0);

      // Second poll succeeds
      mockGetLatestLedger.mockResolvedValue({ sequence: 1300 });
      mockGetEvents.mockResolvedValue({
        events: [
          makeMockEvent({
            contractId: "CONTRACT-ALPHA",
            eventType: "initialized",
            ledger: 1300,
          }),
        ],
      });
      await pollEvents();

      expect(getLastIndexedLedger()).toBe(1300);
      const rows = testDb.prepare("SELECT * FROM events").all();
      expect(rows).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Duplicate / repeated events
  // -------------------------------------------------------------------------

  describe("duplicate and repeated event handling", () => {
    it("processing the same events twice does not create duplicate rows", async () => {
      const events = [
        makeMockEvent({ contractId: "CONTRACT-ALPHA", eventType: "initialized", ledger: 1400 }),
        makeMockEvent({ contractId: "CONTRACT-ALPHA", eventType: "funded", ledger: 1401 }),
      ];

      mockGetLatestLedger.mockResolvedValue({ sequence: 1401 });
      mockGetEvents.mockResolvedValue({ events });
      await pollEvents();

      // Reset pointer to re-poll the same range
      testDb.exec(
        "UPDATE indexer_state SET value = '0' WHERE key = 'last_ledger_sequence'"
      );

      mockGetLatestLedger.mockResolvedValue({ sequence: 1401 });
      mockGetEvents.mockResolvedValue({ events });
      await pollEvents();

      const rows = testDb.prepare("SELECT * FROM events").all();
      expect(rows).toHaveLength(2); // must remain 2, not 4
    });

    it("two events with the same contract+type+ledger triple are stored as one row", async () => {
      const event = makeMockEvent({
        contractId: "CONTRACT-ALPHA",
        eventType: "initialized",
        ledger: 1500,
        value: { original: true },
      });
      const duplicate = makeMockEvent({
        contractId: "CONTRACT-ALPHA",
        eventType: "initialized",
        ledger: 1500,
        value: { duplicate: true },
      });

      mockGetLatestLedger.mockResolvedValue({ sequence: 1500 });
      mockGetEvents.mockResolvedValue({ events: [event, duplicate] });

      await pollEvents();

      const rows = testDb
        .prepare(
          "SELECT * FROM events WHERE contract_id='CONTRACT-ALPHA' AND ledger_sequence=1500 AND event_type='initialized'"
        )
        .all() as any[];
      expect(rows).toHaveLength(1);
      // First write wins
      expect(JSON.parse(rows[0].data_json)).toEqual({ original: true });
    });
  });

  // -------------------------------------------------------------------------
  // 7. Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles an empty events array from RPC without errors", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 1600 });
      mockGetEvents.mockResolvedValue({ events: [] });

      await expect(pollEvents()).resolves.not.toThrow();
      expect(getLastIndexedLedger()).toBe(1600);
      expect(testDb.prepare("SELECT COUNT(*) as cnt FROM events").get()).toMatchObject({
        cnt: 0,
      });
    });

    it("handles a large batch of events atomically (all-or-nothing)", async () => {
      const bigBatch = Array.from({ length: 100 }, (_, i) =>
        makeMockEvent({
          contractId: "CONTRACT-ALPHA",
          eventType: i % 2 === 0 ? "initialized" : "funded",
          ledger: 2000 + i,
        })
      );

      mockGetLatestLedger.mockResolvedValue({ sequence: 2099 });
      mockGetEvents.mockResolvedValue({ events: bigBatch });

      await pollEvents();

      const count = testDb
        .prepare("SELECT COUNT(*) as cnt FROM events")
        .get() as any;
      expect(count.cnt).toBe(100);
      expect(getLastIndexedLedger()).toBe(2099);
    });

    it("events are queryable via readLedgerRange immediately after poll completes", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 2200 });
      mockGetEvents.mockResolvedValue({
        events: [
          makeMockEvent({ contractId: "CONTRACT-ALPHA", eventType: "approved", ledger: 2200 }),
        ],
      });

      await pollEvents();

      const events = readLedgerRange(2200, 2200);
      expect(events).toHaveLength(1);
      expect((events[0] as any).event_type).toBe("approved");
    });
  });
});
