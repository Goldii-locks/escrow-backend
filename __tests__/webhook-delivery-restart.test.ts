import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { initSchema, setDb, addSubscription, insertEvent } from "../src/indexer/db.js";

/**
 * #850: delivery is driven by a persisted per-subscription cursor, so events
 * that were indexed but not yet delivered when the process stopped are
 * delivered, exactly once, by the next process.
 *
 * A restart is simulated with a file-backed database: the first "process"
 * is abandoned mid-delivery (its receiver never answers), then a fresh
 * connection to the same file and a fresh delivery queue take over.
 */

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {},
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { enqueueWebhookDelivery, resetWebhookDeliveryQueueForTests } = await import(
  "../src/indexer/poller.js"
);

const CONTRACT = "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";
// A public IP literal: the #605 guard accepts it without a DNS lookup.
const HOOK = "https://93.184.215.14/hook";
const LEDGERS = [100, 101, 102, 103, 104];

let tmpDir: string;
let dbFile: string;
const openDbs: Database.Database[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(5);
  }
}

/** Start a "process": open the database file and a fresh delivery queue. */
function startProcess(): Database.Database {
  resetWebhookDeliveryQueueForTests();
  const db = new Database(dbFile);
  openDbs.push(db);
  setDb(db);
  initSchema();
  return db;
}

function ledgerOf(init: { body: string }): number {
  return (JSON.parse(init.body) as { ledger_sequence: number }).ledger_sequence;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "webhook-restart-"));
  dbFile = path.join(tmpDir, "indexer.db");
});

afterEach(() => {
  delete (global as any).fetch;
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("webhook delivery survives a restart (#850)", () => {
  it("delivers every event exactly once when the process stops mid-delivery", async () => {
    // --- Process 1: index events, deliver two, die during the third. ---
    startProcess();
    addSubscription(CONTRACT, HOOK, ["funded"]);
    for (const ledger of LEDGERS) {
      insertEvent(CONTRACT, "funded", ledger, ledger, "{}");
    }

    /** Events the receiver acknowledged with a 2xx, across both processes. */
    const acknowledged: number[] = [];
    let firstProcessCalls = 0;
    (global as any).fetch = jest.fn((_url: string, init: { body: string }) => {
      firstProcessCalls += 1;
      if (firstProcessCalls <= 2) {
        acknowledged.push(ledgerOf(init));
        return Promise.resolve({ ok: true, status: 200 });
      }
      // The process is killed while this request is in flight.
      return new Promise(() => {});
    });

    void enqueueWebhookDelivery(100, 104);
    await waitFor(() => firstProcessCalls === 3);
    expect(acknowledged).toEqual([100, 101]);
    // The abandoned run never finishes: nothing else is written by process 1.

    // --- Process 2: restart and let the startup delivery run. ---
    startProcess();
    (global as any).fetch = jest.fn((_url: string, init: { body: string }) => {
      acknowledged.push(ledgerOf(init));
      return Promise.resolve({ ok: true, status: 200 });
    });

    await enqueueWebhookDelivery();
    expect(acknowledged).toEqual(LEDGERS);

    // A later cycle has nothing left to send.
    await enqueueWebhookDelivery();
    expect(acknowledged).toEqual(LEDGERS);
  });

  it("delivers events that were indexed but never queued before the restart", async () => {
    // --- Process 1: events are committed, then the process stops before any
    // delivery run starts (the in-memory queue is simply lost). ---
    startProcess();
    addSubscription(CONTRACT, HOOK, ["funded"]);
    for (const ledger of LEDGERS) {
      insertEvent(CONTRACT, "funded", ledger, ledger, "{}");
    }

    // --- Process 2 ---
    const db = startProcess();
    const received: number[] = [];
    (global as any).fetch = jest.fn((_url: string, init: { body: string }) => {
      received.push(ledgerOf(init));
      return Promise.resolve({ ok: true, status: 200 });
    });

    await enqueueWebhookDelivery();
    await enqueueWebhookDelivery();

    expect(received).toEqual(LEDGERS);
    const rows = db
      .prepare("SELECT status FROM webhook_deliveries")
      .all() as Array<{ status: string }>;
    expect(rows).toHaveLength(LEDGERS.length);
    expect(rows.every((row) => row.status === "delivered")).toBe(true);
  });

  it("does not send a new subscription the events stored before it existed", async () => {
    startProcess();
    insertEvent(CONTRACT, "funded", 99, 99, "{}");
    addSubscription(CONTRACT, HOOK, ["funded"]);
    insertEvent(CONTRACT, "funded", 100, 100, "{}");

    const received: number[] = [];
    (global as any).fetch = jest.fn((_url: string, init: { body: string }) => {
      received.push(ledgerOf(init));
      return Promise.resolve({ ok: true, status: 200 });
    });

    await enqueueWebhookDelivery();
    expect(received).toEqual([100]);
  });
});
