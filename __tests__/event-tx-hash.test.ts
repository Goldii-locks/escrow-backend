import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import {
  getEventsByContract,
  initSchema,
  insertEventBatch,
  insertEvent,
  setDb,
} from "../src/indexer/db.js";

let testDb: Database.Database;

const CONTRACT_ID = "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";
const TX_HASH = "a".repeat(64);
const EVENT_ID = "000000001234-000000000001-0000000000000000000000000000000000000000000000000000000000000000";

beforeAll(() => {
  testDb = new Database(":memory:");
  setDb(testDb);
  initSchema();
});

afterAll(() => {
  testDb.close();
});

beforeEach(() => {
  testDb.exec("DELETE FROM events");
});

describe("events transaction hash indexing (#700)", () => {
  it("adds tx_hash and event_id columns to the events table", () => {
    const columns = testDb
      .prepare("PRAGMA table_info(events)")
      .all() as Array<{ name: string }>;

    const names = columns.map((column) => column.name);
    expect(names).toContain("tx_hash");
    expect(names).toContain("event_id");
  });

  it("stores the transaction hash and event id with a batch insert", () => {
    insertEventBatch(
      [
        {
          contractId: CONTRACT_ID,
          eventType: "fund",
          ledgerSequence: 1000,
          timestamp: 1700000000,
          dataJson: '{"total_amount":"100"}',
          txHash: TX_HASH,
          eventId: EVENT_ID,
        },
      ],
      1000,
    );

    const row = testDb
      .prepare("SELECT tx_hash, event_id FROM events WHERE contract_id = ?")
      .get(CONTRACT_ID) as { tx_hash: string; event_id: string };

    expect(row.tx_hash).toBe(TX_HASH);
    expect(row.event_id).toBe(EVENT_ID);
  });

  it("stores the transaction hash with a single insert", () => {
    insertEvent(
      CONTRACT_ID,
      "approve",
      1001,
      1700000001,
      '{"amount":"1"}',
      EVENT_ID,
      TX_HASH,
    );

    const row = testDb
      .prepare("SELECT tx_hash, event_id FROM events WHERE contract_id = ?")
      .get(CONTRACT_ID) as { tx_hash: string; event_id: string };

    expect(row.tx_hash).toBe(TX_HASH);
    expect(row.event_id).toBe(EVENT_ID);
  });

  it("writes null for rows without a transaction hash", () => {
    insertEventBatch(
      [
        {
          contractId: CONTRACT_ID,
          eventType: "fund",
          ledgerSequence: 1002,
          timestamp: 1700000002,
          dataJson: "{}",
        },
      ],
      1002,
    );

    const row = testDb
      .prepare("SELECT tx_hash, event_id FROM events WHERE contract_id = ?")
      .get(CONTRACT_ID) as { tx_hash: string | null; event_id: string | null };

    expect(row.tx_hash).toBeNull();
    // Without an RPC id the #607 dedupe key falls back to contract:ledger:type.
    expect(row.event_id).toBe(`${CONTRACT_ID}:1002:fund`);
  });

  it("returns txHash in the job history", () => {
    insertEventBatch(
      [
        {
          contractId: CONTRACT_ID,
          eventType: "fund",
          ledgerSequence: 1003,
          timestamp: 1700000003,
          dataJson: "{}",
          txHash: TX_HASH,
          eventId: EVENT_ID,
        },
      ],
      1003,
    );

    const history = getEventsByContract(CONTRACT_ID);

    expect(history.events).toHaveLength(1);
    expect(history.events[0].txHash).toBe(TX_HASH);
    expect(history.events[0].tx_hash).toBe(TX_HASH);
  });

  it("returns null txHash for older rows", () => {
    insertEventBatch(
      [
        {
          contractId: CONTRACT_ID,
          eventType: "fund",
          ledgerSequence: 1004,
          timestamp: 1700000004,
          dataJson: "{}",
        },
      ],
      1004,
    );

    const history = getEventsByContract(CONTRACT_ID);
    expect(history.events[0].txHash).toBeNull();
  });
});

describe("webhook payload transaction hash (#700)", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("includes the transaction hash in the delivered payload", async () => {
    const { deliverToUrl } = await import(
      "../src/indexer/webhook-delivery.js"
    );

    let body: Record<string, unknown> = {};
    global.fetch = jest.fn(async (_url: string, init?: { body?: string }) => {
      body = JSON.parse(String(init?.body ?? "{}"));
      return { ok: true, status: 200 } as unknown as Response;
    }) as unknown as typeof fetch;

    await deliverToUrl("https://example.com/hook", {
      id: 1,
      contract_id: CONTRACT_ID,
      event_type: "fund",
      ledger_sequence: 1000,
      timestamp: 1700000000,
      data_json: '{"total_amount":"100"}',
      tx_hash: TX_HASH,
      event_id: EVENT_ID,
      created_at: "2026-01-01 00:00:00",
    });

    expect(body.tx_hash).toBe(TX_HASH);
    expect(body.txHash).toBe(TX_HASH);
    expect(body.event_id).toBe(EVENT_ID);
    expect(body.version).toBe(1);
  });
});
