import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import {
  setDb,
  runMigrations,
  registerContract,
  getLastIndexedLedger,
  getEventsByContract,
} from "../src/indexer/db.js";

/**
 * In-memory mock integration tests for indexer_runner (#257).
 *
 * Simulates Soroban RPC events through the poller and asserts every event is
 * persisted into the SQLite schema (events + ledger pointer).
 */

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

const { pollEvents, resetFailureState } = await import(
  "../src/indexer/poller.js"
);

function makeRpcEvent(overrides: {
  contractId?: string;
  eventType?: string;
  ledger?: number;
  value?: unknown;
  ledgerClosedAt?: string;
} = {}) {
  const contractId = overrides.contractId ?? "C-INTEGRATION-1";
  return {
    contractId: { contractId: () => contractId },
    topic: [overrides.eventType ?? "initialized"],
    ledger: overrides.ledger ?? 100,
    ledgerClosedAt: overrides.ledgerClosedAt ?? "2024-06-01T12:00:00Z",
    value: overrides.value ?? { ok: true },
  };
}

describe("indexer_runner in-memory mock integration (#257)", () => {
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
    registerContract("C-INTEGRATION-1", "integration");
  });

  it("writes a single simulated RPC event into the events schema", async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 150 });
    mockGetEvents.mockResolvedValue({
      events: [
        makeRpcEvent({
          eventType: "funded",
          ledger: 120,
          value: { amount: "500" },
        }),
      ],
    });

    const advanced = await pollEvents();
    expect(advanced).toBe(true);

    const rows = testDb.prepare("SELECT * FROM events").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].contract_id).toBe("C-INTEGRATION-1");
    expect(rows[0].event_type).toBe("funded");
    expect(rows[0].ledger_sequence).toBe(120);
    expect(JSON.parse(rows[0].data_json)).toEqual({ amount: "500" });
    expect(getLastIndexedLedger()).toBe(150);
  });

  it("persists a batch of mixed event types from a mocked RPC poll", async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 200 });
    mockGetEvents.mockResolvedValue({
      events: [
        makeRpcEvent({ eventType: "initialized", ledger: 101 }),
        makeRpcEvent({ eventType: "funded", ledger: 102, value: { amount: "1" } }),
        makeRpcEvent({
          eventType: "delivered",
          ledger: 103,
          value: { milestone: 0 },
        }),
        makeRpcEvent({
          eventType: "approved",
          ledger: 104,
          value: { milestone: 0 },
        }),
      ],
    });

    await pollEvents();

    const rows = testDb
      .prepare("SELECT event_type, ledger_sequence FROM events ORDER BY ledger_sequence")
      .all() as Array<{ event_type: string; ledger_sequence: number }>;

    expect(rows.map((r) => r.event_type)).toEqual([
      "initialized",
      "funded",
      "delivered",
      "approved",
    ]);
    expect(rows.map((r) => r.ledger_sequence)).toEqual([101, 102, 103, 104]);
    expect(getLastIndexedLedger()).toBe(200);

    const byContract = getEventsByContract("C-INTEGRATION-1");
    expect(byContract.total).toBe(4);
  });

  it("writes events for multiple monitored contracts", async () => {
    registerContract("C-INTEGRATION-2", "second");

    mockGetLatestLedger.mockResolvedValue({ sequence: 300 });
    mockGetEvents.mockResolvedValue({
      events: [
        makeRpcEvent({
          contractId: "C-INTEGRATION-1",
          eventType: "token_whitelisted",
          ledger: 201,
        }),
        makeRpcEvent({
          contractId: "C-INTEGRATION-2",
          eventType: "partial_release",
          ledger: 202,
          value: { amount: "10" },
        }),
      ],
    });

    await pollEvents();

    const rows = testDb
      .prepare("SELECT contract_id, event_type FROM events ORDER BY ledger_sequence")
      .all() as Array<{ contract_id: string; event_type: string }>;

    expect(rows).toEqual([
      { contract_id: "C-INTEGRATION-1", event_type: "token_whitelisted" },
      { contract_id: "C-INTEGRATION-2", event_type: "partial_release" },
    ]);
  });

  it("advances the ledger pointer even when the RPC payload is empty", async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 88 });
    mockGetEvents.mockResolvedValue({ events: [] });

    await pollEvents();

    expect(testDb.prepare("SELECT COUNT(*) as c FROM events").get()).toEqual({
      c: 0,
    });
    expect(getLastIndexedLedger()).toBe(88);
  });

  it("does not write events when RPC reports no new ledgers", async () => {
    testDb
      .prepare(
        "UPDATE indexer_state SET value = ? WHERE key = 'last_ledger_sequence'",
      )
      .run("500");
    mockGetLatestLedger.mockResolvedValue({ sequence: 500 });
    mockGetEvents.mockResolvedValue({
      events: [makeRpcEvent({ ledger: 499 })],
    });

    const advanced = await pollEvents();
    expect(advanced).toBeFalsy();
    expect(mockGetEvents).not.toHaveBeenCalled();
    expect(testDb.prepare("SELECT COUNT(*) as c FROM events").get()).toEqual({
      c: 0,
    });
    expect(getLastIndexedLedger()).toBe(500);
  });

  it("leaves the schema unchanged when the mocked RPC call fails", async () => {
    mockGetLatestLedger.mockRejectedValue(new Error("RPC unavailable"));

    await pollEvents();

    expect(testDb.prepare("SELECT COUNT(*) as c FROM events").get()).toEqual({
      c: 0,
    });
    expect(getLastIndexedLedger()).toBe(0);
  });

  it("deduplicates repeated simulated events via UNIQUE schema constraint", async () => {
    const duplicate = makeRpcEvent({
      eventType: "dispute_raised",
      ledger: 77,
      value: { reason: "late" },
    });

    mockGetLatestLedger.mockResolvedValue({ sequence: 80 });
    mockGetEvents.mockResolvedValue({ events: [duplicate] });
    await pollEvents();

    // Reset pointer so a second poll can fetch again
    testDb
      .prepare(
        "UPDATE indexer_state SET value = ? WHERE key = 'last_ledger_sequence'",
      )
      .run("0");
    mockGetLatestLedger.mockResolvedValue({ sequence: 81 });
    mockGetEvents.mockResolvedValue({
      events: [
        duplicate,
        makeRpcEvent({
          eventType: "dispute_resolved",
          ledger: 78,
          value: { outcome: "client" },
        }),
      ],
    });
    await pollEvents();

    const rows = testDb
      .prepare("SELECT event_type FROM events ORDER BY ledger_sequence")
      .all() as Array<{ event_type: string }>;
    expect(rows.map((r) => r.event_type)).toEqual([
      "dispute_raised",
      "dispute_resolved",
    ]);
  });

  it("confirms required indexer tables exist after migration for runner writes", () => {
    const tables = (
      testDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((t) => t.name);

    expect(tables).toEqual(
      expect.arrayContaining([
        "events",
        "indexer_state",
        "monitored_contracts",
        "schema_migrations",
      ]),
    );
  });
});
