import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import { setDb, runMigrations, registerContract } from "../src/indexer/db.js";

/**
 * Failover wiring in the indexer poll loop (#531): with two configured nodes
 * a node that keeps failing is marked unhealthy and the poller switches to
 * the other one.
 */

const NODE_A = "https://rpc-a.example.org";
const NODE_B = "https://rpc-b.example.org";
process.env.SOROBAN_RPC_URLS = `${NODE_A}, ${NODE_B}`;

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule("../src/indexer/webhook-delivery.js", () => ({
  deliverWebhooks: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));
jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: jest.fn().mockImplementation((url: unknown) => ({
    getLatestLedger: () =>
      url === NODE_A
        ? Promise.reject(new Error("connection refused"))
        : Promise.resolve({ sequence: 100 }),
    getEvents: () => Promise.resolve({ events: [] }),
  })),
}));

const { pollEvents, getActiveRpcNodeUrl } = await import("../src/indexer/poller.js");

describe("indexer RPC node failover (#531)", () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(":memory:");
    setDb(db);
    runMigrations();
    registerContract("TEST-CONTRACT", "test");
  });

  afterAll(() => {
    db.close();
    delete process.env.SOROBAN_RPC_URLS;
  });

  it("creates the failover tables in runMigrations()", () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining(["rpc_node_health", "failover_state", "node_failure_events"]),
    );
  });

  it("switches to the second node once the first is marked unhealthy", async () => {
    for (let i = 0; i < 5; i++) await pollEvents();

    expect(getActiveRpcNodeUrl()).toBe(NODE_B);
    const state = db.prepare("SELECT active_node_url FROM failover_state WHERE id = 1").get() as {
      active_node_url: string;
    };
    expect(state.active_node_url).toBe(NODE_B);

    await expect(pollEvents()).resolves.toBe(true);
  });
});
