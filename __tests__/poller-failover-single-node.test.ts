import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import { setDb, runMigrations, registerContract } from "../src/indexer/db.js";

/** With only SOROBAN_RPC_URL configured the poller never writes failover state (#531). */

delete process.env.SOROBAN_RPC_URLS;

const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule("../src/indexer/webhook-delivery.js", () => ({
  deliverWebhooks: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));
jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: jest.fn().mockImplementation(() => ({
    getLatestLedger: mockGetLatestLedger,
    getEvents: () => Promise.resolve({ events: [] }),
  })),
}));

const { pollEvents } = await import("../src/indexer/poller.js");

it("does not touch the failover tables with a single node", async () => {
  const db = new Database(":memory:");
  setDb(db);
  runMigrations();
  registerContract("TEST-CONTRACT", "test");

  mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
  await expect(pollEvents()).resolves.toBe(true);
  mockGetLatestLedger.mockRejectedValue(new Error("connection refused"));
  await expect(pollEvents()).resolves.toBe(false);

  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  expect(count("rpc_node_health")).toBe(0);
  expect(count("node_failure_events")).toBe(0);
  expect(
    (db.prepare("SELECT active_node_url FROM failover_state").get() as { active_node_url: null })
      .active_node_url,
  ).toBeNull();
  db.close();
});
