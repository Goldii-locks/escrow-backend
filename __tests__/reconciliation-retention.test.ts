/**
 * Tests for reconciliation_results retention pruning (#925).
 *
 * Covers:
 *  - Default RECONCILIATION_RETENTION_DAYS is 14
 *  - Custom RECONCILIATION_RETENTION_DAYS is respected
 *  - runMaintenanceCycle prunes rows older than the retention cutoff
 *  - runMaintenanceCycle preserves recent rows
 *  - After many runs the table stays bounded by the configured retention window
 *  - getLatestReconciliationResults returns only the most recent row per contract
 *  - getLatestReconciliationResults output is unchanged after retention prune
 *  - Existing reconciliation behavior is intact
 */

import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import { setDb, runMigrations, insertEvent } from "../src/indexer/db.js";
import { runMaintenanceCycle } from "../src/indexer/poller.js";
import { config } from "../src/config.js";

let testDb: Database.Database;

const CONTRACT_A = "CA3RETENTION000000000000000000000000000000000000000000000001";
const CONTRACT_B = "CA3RETENTION000000000000000000000000000000000000000000000002";
const CONTRACT_C = "CA3RETENTION000000000000000000000000000000000000000000000003";
const TOKEN = "CTOKEN000000000000000000000000000000000000000000000000000001";

const NOW_S = Math.floor(Date.now() / 1000);

function insertReconciliationRow(contractId: string, checkedAt: number): void {
  testDb
    .prepare(
      `INSERT INTO reconciliation_results
        (contract_id, token, inflow_total, outflow_total, expected_balance,
         onchain_balance, delta, status, error, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(contractId, TOKEN, "1000", "0", "1000", "1000", "0", "match", null, checkedAt);
}

function countReconciliationRows(): number {
  return (
    testDb.prepare("SELECT COUNT(*) AS n FROM reconciliation_results").get() as { n: number }
  ).n;
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
  testDb.exec("DELETE FROM reconciliation_results");
  testDb.exec("DELETE FROM monitored_contracts");
  testDb.exec("DELETE FROM events");
  delete process.env.RECONCILIATION_RETENTION_DAYS;
});

// ---------------------------------------------------------------------------
// 1. Default retention is 14 days
// ---------------------------------------------------------------------------
it("default RECONCILIATION_RETENTION_DAYS is 14", () => {
  delete process.env.RECONCILIATION_RETENTION_DAYS;
  expect(config.reconciliationRetentionDays).toBe(14);
});

// ---------------------------------------------------------------------------
// 2. Custom retention is respected
// ---------------------------------------------------------------------------
it("custom RECONCILIATION_RETENTION_DAYS is respected", () => {
  process.env.RECONCILIATION_RETENTION_DAYS = "7";
  try {
    expect(config.reconciliationRetentionDays).toBe(7);
  } finally {
    delete process.env.RECONCILIATION_RETENTION_DAYS;
  }
});

// ---------------------------------------------------------------------------
// 3. runMaintenanceCycle prunes rows older than the retention cutoff
// ---------------------------------------------------------------------------
it("runMaintenanceCycle prunes rows older than retention cutoff", () => {
  const thirtyDaysAgo = NOW_S - 30 * 86400;
  for (let i = 0; i < 5; i++) {
    insertReconciliationRow(CONTRACT_A, thirtyDaysAgo + i);
  }
  expect(countReconciliationRows()).toBe(5);

  process.env.RECONCILIATION_RETENTION_DAYS = "14";
  runMaintenanceCycle();

  expect(countReconciliationRows()).toBe(0);
});

// ---------------------------------------------------------------------------
// 4. runMaintenanceCycle preserves recent rows
// ---------------------------------------------------------------------------
it("runMaintenanceCycle preserves recent rows", () => {
  const fiveDaysAgo = NOW_S - 5 * 86400;
  for (let i = 0; i < 3; i++) {
    insertReconciliationRow(CONTRACT_A, fiveDaysAgo + i);
  }
  expect(countReconciliationRows()).toBe(3);

  process.env.RECONCILIATION_RETENTION_DAYS = "14";
  runMaintenanceCycle();

  expect(countReconciliationRows()).toBe(3);
});

// ---------------------------------------------------------------------------
// 5. After 100 runs across 3 contracts, table holds at most configured days
// ---------------------------------------------------------------------------
it("after 100 runs across 3 contracts, table holds at most configured days of history", () => {
  const contracts = [CONTRACT_A, CONTRACT_B, CONTRACT_C];

  // Insert 100 rows per contract, spread hourly over 100 hours in the past.
  // With a 1-day (24h) retention, only the last 24 hours should survive.
  for (const contractId of contracts) {
    for (let i = 0; i < 100; i++) {
      const checkedAt = NOW_S - (100 - i) * 3600; // oldest first
      insertReconciliationRow(contractId, checkedAt);
    }
  }
  expect(countReconciliationRows()).toBe(300);

  process.env.RECONCILIATION_RETENTION_DAYS = "1";
  runMaintenanceCycle();

  const remaining = countReconciliationRows();
  // At most 24 rows per contract (last 24 hours of hourly runs)
  expect(remaining).toBeLessThanOrEqual(3 * 24);
  // Should be greater than 0 since recent rows are preserved
  expect(remaining).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// 6. getLatestReconciliationResults returns only the most recent row per contract
// ---------------------------------------------------------------------------
it("getLatestReconciliationResults returns only the most recent row per contract", async () => {
  const olderTime = NOW_S - 3600;
  const newerTime = NOW_S - 100;

  insertReconciliationRow(CONTRACT_A, olderTime);
  insertReconciliationRow(CONTRACT_A, newerTime);

  const { getLatestReconciliationResults } = await import(
    "../src/indexer/reconciliation.js"
  );

  const results = getLatestReconciliationResults();
  expect(results).toHaveLength(1);
  expect(results[0].checked_at).toBe(newerTime);
});

// ---------------------------------------------------------------------------
// 7. getLatestReconciliationResults output is unchanged after retention prune
// ---------------------------------------------------------------------------
it("getLatestReconciliationResults output is unchanged after retention prune", async () => {
  const oldTime = NOW_S - 30 * 86400;
  const recentTime = NOW_S - 100;

  insertReconciliationRow(CONTRACT_B, oldTime);
  insertReconciliationRow(CONTRACT_B, recentTime);

  process.env.RECONCILIATION_RETENTION_DAYS = "14";
  runMaintenanceCycle();

  const { getLatestReconciliationResults } = await import(
    "../src/indexer/reconciliation.js"
  );

  const results = getLatestReconciliationResults();
  expect(results).toHaveLength(1);
  expect(results[0].contract_id).toBe(CONTRACT_B);
  expect(results[0].checked_at).toBe(recentTime);
});

// ---------------------------------------------------------------------------
// 8. Existing reconciliation behavior is intact
// ---------------------------------------------------------------------------
it("existing reconciliation behavior is intact", async () => {
  testDb
    .prepare("INSERT INTO monitored_contracts (contract_id, active) VALUES (?, 1)")
    .run(CONTRACT_C);

  insertEvent(
    CONTRACT_C,
    "fund",
    100,
    NOW_S - 200,
    JSON.stringify({ token: TOKEN, total_amount: "1000" })
  );
  insertEvent(
    CONTRACT_C,
    "approve",
    101,
    NOW_S - 100,
    JSON.stringify({ token: TOKEN, amount: "300" })
  );

  const { reconcileContract } = await import("../src/indexer/reconciliation.js");
  const mockReader = jest.fn<(c: string, t: string) => Promise<bigint>>().mockResolvedValue(700n);

  const result = await reconcileContract(CONTRACT_C, mockReader);

  expect(result.status).toBe("match");
  expect(result.inflow_total).toBe("1000");
  expect(result.outflow_total).toBe("300");
  expect(result.expected_balance).toBe("700");
  expect(result.onchain_balance).toBe("700");
  expect(result.delta).toBe("0");
});
