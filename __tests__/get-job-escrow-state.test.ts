import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import Database from "better-sqlite3";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { autoAuth } from "./helpers/api-key-helper.js";
import { CLIENT, FREELANCER, ARBITER, TOKEN } from "./helpers/scval-fixtures.js";
import { initSchema, insertEvent, setDb } from "../src/indexer/db.js";

/**
 * #967: GET /api/jobs/:contractId serves per-milestone due dates and revision
 * counts, acceptance, and the pause / cancel state, at a fixed RPC cost per
 * uncached request: one get_escrow_state simulation plus one getLedgerEntries
 * read, whatever the milestone count.
 */

const CONTRACT = "CARZQMYKDGA4TTIE2XBDJ42EX27VYLLJGGG4WGUIXXWIVHPDTX3UCLJA";

const mockSimulateTransaction = jest.fn<(tx: any) => Promise<unknown>>();
const mockGetLedgerEntries = jest.fn<(...keys: any[]) => Promise<unknown>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    simulateTransaction = mockSimulateTransaction;
    getLedgerEntries = mockGetLedgerEntries;
  },
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: router } = await import("../src/routes/jobs.js");
const { resetJobContractRateLimitBuckets } = await import(
  "../src/middleware/job-contract-rate-limit.js"
);

const app = express();
app.use(express.json());
app.use(autoAuth);
app.use("/api/jobs", router);

/** A `#[contracttype]` struct: an scvMap with symbol keys sorted by name. */
function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((key) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: fields[key] })),
  );
}

const addr = (a: string) => new Address(a).toScVal();
const status = (variant: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant)]);

/** A get_escrow_state retval (EscrowState) for `statuses.length` milestones. */
function escrowStateScVal(
  statuses: string[],
  opts: { emergency?: boolean; admin?: boolean; locked?: boolean; approvalMask?: number } = {},
): xdr.ScVal {
  return struct({
    job: struct({
      client: addr(CLIENT),
      freelancer: addr(FREELANCER),
      arbiter: addr(ARBITER),
      token: addr(TOKEN),
      funded: xdr.ScVal.scvBool(true),
      auto_release_seconds: nativeToScVal(604800n, { type: "u64" }),
      milestones: xdr.ScVal.scvVec(
        statuses.map((s, i) =>
          struct({
            amount: nativeToScVal(BigInt((i + 1) * 1000), { type: "i128" }),
            released_amount: nativeToScVal(0n, { type: "i128" }),
            status: status(s),
            delivered_at: nativeToScVal(0n, { type: "u64" }),
            funded: xdr.ScVal.scvBool(true),
            spec_hash: xdr.ScVal.scvBytes(Buffer.alloc(32)),
            deliverable: xdr.ScVal.scvBytes(Buffer.alloc(32)),
          }),
        ),
      ),
    }),
    admin: addr(CLIENT),
    paused: struct({
      emergency: xdr.ScVal.scvBool(opts.emergency ?? false),
      admin: xdr.ScVal.scvBool(opts.admin ?? false),
    }),
    cancel: struct({
      locked: xdr.ScVal.scvBool(opts.locked ?? false),
      approval_mask: xdr.ScVal.scvU32(opts.approvalMask ?? 0),
    }),
    milestone_timing: xdr.ScVal.scvVec(
      statuses.map(() =>
        struct({
          extension_seconds: xdr.ScVal.scvU32(0),
          deadline: xdr.ScVal.scvVoid(),
        }),
      ),
    ),
    fee_allocation_set: xdr.ScVal.scvBool(false),
    fee_allocation: struct({
      client_bps: xdr.ScVal.scvU32(0),
      freelancer_bps: xdr.ScVal.scvU32(0),
      treasury_bps: xdr.ScVal.scvU32(0),
      locked: xdr.ScVal.scvBool(false),
    }),
    version: xdr.ScVal.scvString("test"),
  });
}

/** The persistent `DataKey::<variant>(index)` ledger key of CONTRACT. */
function dataKey(variant: "DueAt" | "RevCnt", index: number): string {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(CONTRACT).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant), xdr.ScVal.scvU32(index)]),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  ).toXDR("base64");
}

/**
 * Answer getLedgerEntries from `stored` (base64 key -> value). Keys with no
 * stored value are omitted from the response, as the RPC does.
 */
function ledgerEntriesFrom(stored: Map<string, xdr.ScVal>) {
  mockGetLedgerEntries.mockImplementation(async (...keys: xdr.LedgerKey[]) => ({
    latestLedger: 1000,
    entries: keys
      .filter((key) => stored.has(key.toXDR("base64")))
      .map((key) => ({
        key,
        val: { contractData: () => ({ val: () => stored.get(key.toXDR("base64")) }) },
      })),
  }));
}

/** Name of the contract function a simulated transaction invokes. */
function invokedFunction(tx: any): string {
  return tx.operations[0].func.invokeContract().functionName().toString();
}

let testDb: Database.Database;

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
  resetJobContractRateLimitBuckets();
  mockSimulateTransaction.mockReset();
  mockGetLedgerEntries.mockReset();
});

describe("GET /api/jobs/:contractId escrow state (#967)", () => {
  it("returns dueAt, revisionCount, acceptance, pause and cancel state", async () => {
    mockSimulateTransaction.mockResolvedValue({
      result: {
        retval: escrowStateScVal(["Pending", "Delivered", "Pending"], {
          emergency: true,
          locked: true,
          approvalMask: 1,
        }),
      },
    });
    ledgerEntriesFrom(
      new Map([
        [dataKey("DueAt", 0), nativeToScVal(1735689600n, { type: "u64" })],
        [dataKey("RevCnt", 0), xdr.ScVal.scvU32(2)],
        // Milestone 1: an explicit 0 due date means "none".
        [dataKey("DueAt", 1), nativeToScVal(0n, { type: "u64" })],
        [dataKey("RevCnt", 1), xdr.ScVal.scvU32(3)],
        // Milestone 2: no entries at all (contract defaults).
      ]),
    );
    insertEvent(
      CONTRACT,
      "acceptjob",
      500,
      1_735_000_000,
      JSON.stringify({ party: FREELANCER, acceptance_mask: 1 }),
    );

    const res = await request(app).get(`/api/jobs/${CONTRACT}`).expect(200);

    expect(res.body.data).toEqual({
      id: CONTRACT,
      client: CLIENT,
      freelancer: FREELANCER,
      arbiter: ARBITER,
      token: TOKEN,
      funded: true,
      milestones: [
        { index: 0, amount: "1000", status: "Pending", dueAt: "1735689600", revisionCount: 2 },
        { index: 1, amount: "2000", status: "Delivered", dueAt: null, revisionCount: 3 },
        { index: 2, amount: "3000", status: "Pending", dueAt: null, revisionCount: 0 },
      ],
      acceptance: { freelancer: true, arbiter: false },
      paused: { emergency: true, admin: false },
      cancel: { locked: true, clientApproved: true, freelancerApproved: false },
    });
  });

  it("simulates get_escrow_state, not get_job", async () => {
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: escrowStateScVal(["Pending"]) },
    });
    ledgerEntriesFrom(new Map());

    await request(app).get(`/api/jobs/${CONTRACT}`).expect(200);

    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
    expect(invokedFunction(mockSimulateTransaction.mock.calls[0][0])).toBe("get_escrow_state");
  });

  it("costs one simulation and one ledger read regardless of the milestone count", async () => {
    const statuses = Array.from({ length: 50 }, () => "Pending");
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: escrowStateScVal(statuses) },
    });
    ledgerEntriesFrom(new Map([[dataKey("RevCnt", 49), xdr.ScVal.scvU32(1)]]));

    const res = await request(app).get(`/api/jobs/${CONTRACT}`).expect(200);

    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
    expect(mockGetLedgerEntries).toHaveBeenCalledTimes(1);
    // DueAt + RevCnt for every milestone, in a single request.
    expect(mockGetLedgerEntries.mock.calls[0]).toHaveLength(100);
    expect(res.body.data.milestones[49].revisionCount).toBe(1);
  });

  it("serves a repeat request from the job-state cache with no RPC calls", async () => {
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: escrowStateScVal(["Pending", "Pending"]) },
    });
    ledgerEntriesFrom(new Map());

    await request(app).get(`/api/jobs/${CONTRACT}`).expect(200);
    await request(app).get(`/api/jobs/${CONTRACT}`).expect(200);

    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
    expect(mockGetLedgerEntries).toHaveBeenCalledTimes(1);
  });

  it("reports both acceptances once acceptjob and acceptarb are indexed", async () => {
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: escrowStateScVal(["Pending"]) },
    });
    ledgerEntriesFrom(new Map());
    insertEvent(CONTRACT, "acceptjob", 500, 1, JSON.stringify({ acceptance_mask: 1 }));
    insertEvent(CONTRACT, "acceptarb", 501, 2, JSON.stringify({ acceptance_mask: 3 }));

    const res = await request(app).get(`/api/jobs/${CONTRACT}`).expect(200);

    expect(res.body.data.acceptance).toEqual({ freelancer: true, arbiter: true });
  });

  it("degrades dueAt and revisionCount to null when the ledger read fails", async () => {
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: escrowStateScVal(["Pending"]) },
    });
    mockGetLedgerEntries.mockRejectedValue(new Error("rpc down"));

    const res = await request(app).get(`/api/jobs/${CONTRACT}`).expect(200);

    expect(res.body.data.milestones).toEqual([
      { index: 0, amount: "1000", status: "Pending", dueAt: null, revisionCount: null },
    ]);
    expect(res.body.data.paused).toEqual({ emergency: false, admin: false });
  });

  it("skips the ledger read for a job with no milestones", async () => {
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: escrowStateScVal([]) },
    });

    const res = await request(app).get(`/api/jobs/${CONTRACT}`).expect(200);

    expect(res.body.data.milestones).toEqual([]);
    expect(mockGetLedgerEntries).not.toHaveBeenCalled();
  });
});
