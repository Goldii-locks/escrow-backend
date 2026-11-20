import { jest } from "@jest/globals";
import Database from "better-sqlite3";

/**
 * Per-contract ledger pointers (#720): a contract registered with a start
 * ledger is backfilled from there instead of from the global pointer, groups
 * of contracts at the same pointer share one getEvents call, and webhooks
 * cover the earliest ledger any group fetched.
 */

const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetEvents = jest.fn<(params: any) => Promise<{ events: unknown[] }>>();
const mockDeliverWebhooks = jest.fn<(start: number, end: number, contractIds?: string[]) => Promise<unknown[]>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getLatestLedger = mockGetLatestLedger;
    getEvents = mockGetEvents;
  },
}));

jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  scValToNative: (value: unknown) => value,
}));

jest.unstable_mockModule("../src/indexer/webhook-delivery.js", () => ({
  deliverWebhooks: mockDeliverWebhooks,
}));

const { pollEvents, resetFailureState, flushWebhookDeliveryQueueForTests } = await import(
  "../src/indexer/poller.js"
);
const {
  setDb,
  runMigrations,
  registerContract,
  deregisterContract,
  setLastIndexedLedger,
  getLastIndexedLedger,
  getActiveContractsWithPointers,
  updateContractPointer,
} = await import("../src/indexer/db.js");

let testDb: Database.Database;

/** Contract IDs and start ledgers passed to each getEvents call, in order. */
function getEventsCalls(): Array<{ startLedger: number; contractIds: string[] }> {
  return mockGetEvents.mock.calls.map(([params]) => ({
    startLedger: params.startLedger,
    contractIds: params.filters[0].contractIds,
  }));
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
  resetFailureState();
  testDb.exec("DELETE FROM events");
  testDb.exec("DELETE FROM monitored_contracts");
  setLastIndexedLedger(0);
  delete process.env.CONTRACT_ID;
  mockGetLatestLedger.mockReset();
  mockGetEvents.mockReset();
  mockDeliverWebhooks.mockReset();
  mockGetEvents.mockResolvedValue({ events: [] });
  mockDeliverWebhooks.mockResolvedValue([]);
});

describe("getActiveContractsWithPointers()", () => {
  it("uses the contract's own pointer once it has been polled", () => {
    setLastIndexedLedger(500);
    registerContract("C-POLLED");
    updateContractPointer("C-POLLED", 420);
    expect(getActiveContractsWithPointers()).toEqual([
      { contractId: "C-POLLED", lastLedgerSequence: 420, startLedger: 0 },
    ]);
  });

  it("starts a never-polled contract just before its start ledger", () => {
    setLastIndexedLedger(500);
    registerContract("C-NEW", "new", 300);
    expect(getActiveContractsWithPointers()).toEqual([
      { contractId: "C-NEW", lastLedgerSequence: 299, startLedger: 300 },
    ]);
  });

  it("falls back to the global pointer when there is no start ledger", () => {
    setLastIndexedLedger(500);
    registerContract("C-LEGACY");
    expect(getActiveContractsWithPointers()).toEqual([
      { contractId: "C-LEGACY", lastLedgerSequence: 500, startLedger: 0 },
    ]);
  });

  it("keeps the original start ledger when a contract is re-registered", () => {
    registerContract("C-REACT", "first", 300);
    deregisterContract("C-REACT");
    registerContract("C-REACT", "again", 900);
    expect(getActiveContractsWithPointers()[0].startLedger).toBe(300);
  });
});

describe("pollEvents() with per-contract pointers", () => {
  it("backfills a newly registered contract from its start ledger in its own group", async () => {
    setLastIndexedLedger(1000);
    registerContract("C-EXISTING");
    registerContract("C-NEW", "new", 400);
    mockGetLatestLedger.mockResolvedValue({ sequence: 1010 });

    await pollEvents();

    expect(getEventsCalls()).toEqual(
      expect.arrayContaining([
        { startLedger: 1001, contractIds: ["C-EXISTING"] },
        { startLedger: 400, contractIds: ["C-NEW"] },
      ]),
    );
    expect(mockGetEvents).toHaveBeenCalledTimes(2);

    // Both contracts are now caught up to the chain head.
    for (const c of getActiveContractsWithPointers()) {
      expect(c.lastLedgerSequence).toBe(1010);
    }
    expect(getLastIndexedLedger()).toBe(1010);
  });

  it("delivers webhooks scoped to each polled contract group (#885)", async () => {
    setLastIndexedLedger(1000);
    registerContract("C-EXISTING");
    registerContract("C-NEW", "new", 400);
    mockGetLatestLedger.mockResolvedValue({ sequence: 1010 });

    await pollEvents();
    await flushWebhookDeliveryQueueForTests();

    expect(mockDeliverWebhooks).toHaveBeenCalledWith(1001, 1010, ["C-EXISTING"]);
    expect(mockDeliverWebhooks).toHaveBeenCalledWith(400, 1010, ["C-NEW"]);
  });

  it("merges contracts into one getEvents call once their pointers converge", async () => {
    setLastIndexedLedger(1000);
    registerContract("C-EXISTING");
    registerContract("C-NEW", "new", 400);
    mockGetLatestLedger.mockResolvedValue({ sequence: 1010 });
    await pollEvents();

    mockGetEvents.mockClear();
    mockGetLatestLedger.mockResolvedValue({ sequence: 1020 });
    await pollEvents();

    expect(getEventsCalls()).toEqual([
      { startLedger: 1011, contractIds: ["C-EXISTING", "C-NEW"] },
    ]);
  });

  it("skips groups that are already at the chain head and reports an idle poll", async () => {
    setLastIndexedLedger(1000);
    registerContract("C-EXISTING");
    mockGetLatestLedger.mockResolvedValue({ sequence: 1000 });

    await expect(pollEvents()).resolves.toBe(false);
    expect(mockGetEvents).not.toHaveBeenCalled();
    expect(mockDeliverWebhooks).not.toHaveBeenCalled();
  });

  it("keeps legacy single-contract setups on the global pointer", async () => {
    setLastIndexedLedger(700);
    process.env.CONTRACT_ID = "C-ENV";
    mockGetLatestLedger.mockResolvedValue({ sequence: 705 });

    await pollEvents();
    await flushWebhookDeliveryQueueForTests();

    expect(getEventsCalls()).toEqual([{ startLedger: 701, contractIds: ["C-ENV"] }]);
    expect(mockDeliverWebhooks).toHaveBeenCalledWith(701, 705, ["C-ENV"]);
  });
});
