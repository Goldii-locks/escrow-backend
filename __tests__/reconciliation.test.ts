import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import {
  initSchema,
  setDb,
  insertEvent,
} from "../src/indexer/db.js";

let testDb: Database.Database;

const CONTRACT = "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";
const TOKEN = "CTOKEN000000000000000000000000000000000000000000000000000000001";

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
  testDb.exec("DELETE FROM monitored_contracts");
  testDb.exec("DELETE FROM reconciliation_results");
  testDb.prepare(
    "INSERT INTO monitored_contracts (contract_id, active) VALUES (?, 1)"
  ).run(CONTRACT);
});

function seedFundedEscrow(fundAmount: string, approveAmount: string) {
  insertEvent(
    CONTRACT,
    "fund",
    100,
    1000,
    JSON.stringify({ token: TOKEN, total_amount: fundAmount })
  );
  insertEvent(
    CONTRACT,
    "approve",
    101,
    1100,
    JSON.stringify({ token: TOKEN, amount: approveAmount })
  );
}

describe("reconciliation (#714)", () => {
  it("reports match when on-chain balance equals inflow minus outflow", async () => {
    seedFundedEscrow("1000", "300");
    const { reconcileContract } = await import("../src/indexer/reconciliation.js");
    const reader = jest.fn<(c: string, t: string) => Promise<bigint>>().mockResolvedValue(700n);

    const result = await reconcileContract(CONTRACT, reader);

    expect(reader).toHaveBeenCalledWith(CONTRACT, TOKEN);
    expect(result.status).toBe("match");
    expect(result.inflow_total).toBe("1000");
    expect(result.outflow_total).toBe("300");
    expect(result.expected_balance).toBe("700");
    expect(result.onchain_balance).toBe("700");
    expect(result.delta).toBe("0");
  });

  it("reports mismatch with signed delta", async () => {
    seedFundedEscrow("1000", "300");
    const { reconcileContract } = await import("../src/indexer/reconciliation.js");

    const result = await reconcileContract(CONTRACT, async () => 650n);

    expect(result.status).toBe("mismatch");
    expect(result.delta).toBe("-50");
  });

  it("records an error without throwing when the balance read fails", async () => {
    seedFundedEscrow("1000", "0");
    const { reconcileContract } = await import("../src/indexer/reconciliation.js");

    const result = await reconcileContract(CONTRACT, async () => {
      throw new Error("RPC unavailable");
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("RPC unavailable");
    expect(result.onchain_balance).toBeNull();
  });

  it("records an error when no token address is indexed", async () => {
    insertEvent(CONTRACT, "fund", 100, 1000, JSON.stringify({ total_amount: "10" }));
    const { reconcileContract } = await import("../src/indexer/reconciliation.js");
    const reader = jest.fn<(c: string, t: string) => Promise<bigint>>();

    const result = await reconcileContract(CONTRACT, reader);

    expect(reader).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
    expect(result.error).toContain("no token address");
  });

  it("persists results and exposes the latest per contract", async () => {
    seedFundedEscrow("1000", "0");
    const { reconcileContract, getLatestReconciliationResults } = await import(
      "../src/indexer/reconciliation.js"
    );

    await reconcileContract(CONTRACT, async () => 900n);
    await reconcileContract(CONTRACT, async () => 1000n);

    const rows = testDb
      .prepare("SELECT COUNT(*) AS n FROM reconciliation_results")
      .get() as { n: number };
    expect(rows.n).toBe(2);

    const latest = getLatestReconciliationResults();
    expect(latest).toHaveLength(1);
    expect(latest[0].status).toBe("match");
    expect(latest[0].onchain_balance).toBe("1000");
  });

  it("runReconciliation skips inactive contracts", async () => {
    testDb.prepare("UPDATE monitored_contracts SET active = 0").run();
    const { runReconciliation } = await import("../src/indexer/reconciliation.js");
    const reader = jest.fn<(c: string, t: string) => Promise<bigint>>();

    const results = await runReconciliation(reader);

    expect(results).toHaveLength(0);
    expect(reader).not.toHaveBeenCalled();
  });

  it("applies the configured RPC timeout and shared simulation source (#926)", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const { getActiveServer } = await import("../src/indexer/poller.js");
    const { config } = await import("../src/config.js");

    // Acceptance criterion: No new Server( in reconciliation.ts
    const reconSource = fs.readFileSync(
      path.resolve("src/indexer/reconciliation.ts"),
      "utf8"
    );
    expect(reconSource).not.toContain("new Server(");

    // Acceptance criterion: A test asserts that the configured timeout applies
    const activeServer = getActiveServer();
    expect((activeServer as any).httpClient?.defaults?.timeout).toBe(config.rpcTimeoutMs);
  });
});
