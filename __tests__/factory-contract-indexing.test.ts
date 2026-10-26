import { jest } from "@jest/globals";
import Database from "better-sqlite3";

const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetEvents = jest.fn<(params: any) => Promise<{ events: unknown[] }>>();
const mockDeliverWebhooks = jest.fn<(start: number, end: number) => Promise<unknown[]>>();

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

const { pollEvents, resetFailureState } = await import("../src/indexer/poller.js");
const {
  setDb,
  runMigrations,
  getActiveContractIds,
  getActiveContractsWithPointers,
  getJobsByWallet,
  setLastIndexedLedger,
} = await import("../src/indexer/db.js");

let testDb: Database.Database;

const FACTORY_ID = "CFACTORY00000000000000000000000000000000000000000000000001";
const CHILD_CONTRACT_1 = "CCHILD000000000000000000000000000000000000000000000000001";
const CHILD_CONTRACT_2 = "CCHILD000000000000000000000000000000000000000000000000002";
const CLIENT_WALLET = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";

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
  delete process.env.FACTORY_CONTRACT_ID;
  mockGetLatestLedger.mockReset();
  mockGetEvents.mockReset();
  mockDeliverWebhooks.mockReset();
  mockGetEvents.mockResolvedValue({ events: [] });
  mockDeliverWebhooks.mockResolvedValue([]);
});

describe("Factory contract indexing and child contract registration (#660)", () => {
  it("registers child contract from factory created event and indexes init event in same cycle", async () => {
    process.env.FACTORY_CONTRACT_ID = FACTORY_ID;
    mockGetLatestLedger.mockResolvedValue({ sequence: 100 });

    // Mock factory created event, and child contract's init event in the same ledger
    mockGetEvents.mockImplementation(async (params: any) => {
      const contractIds = params.filters?.[0]?.contractIds ?? params.contractIds ?? [];
      if (contractIds.includes(FACTORY_ID)) {
        return {
          events: [
            {
              contractId: { contractId: () => FACTORY_ID },
              topic: ["created"],
              ledger: 50,
              ledgerClosedAt: new Date(50 * 1000).toISOString(),
              value: { contract_id: CHILD_CONTRACT_1 },
            },
          ],
        };
      }
      if (contractIds.includes(CHILD_CONTRACT_1)) {
        return {
          events: [
            {
              contractId: { contractId: () => CHILD_CONTRACT_1 },
              topic: ["init"],
              ledger: 50,
              ledgerClosedAt: new Date(50 * 1000).toISOString(),
              value: { client: CLIENT_WALLET, freelancer: "GFREELANCER1", arbiter: "GARBITER1" },
            },
          ],
        };
      }
      return { events: [] };
    });

    const hadActivity = await pollEvents();
    expect(hadActivity).toBe(true);

    // Verify child contract was registered
    const activeIds = getActiveContractIds();
    expect(activeIds).toContain(CHILD_CONTRACT_1);

    // Verify by-wallet returns the job from the child contract
    const jobsResult = await getJobsByWallet(CLIENT_WALLET);
    expect(jobsResult.total).toBe(1);
    expect(jobsResult.jobs[0].contract_id).toBe(CHILD_CONTRACT_1);
  });

  it("by-wallet returns jobs from two different child contracts for the same client", async () => {
    process.env.FACTORY_CONTRACT_ID = FACTORY_ID;
    mockGetLatestLedger.mockResolvedValue({ sequence: 200 });

    // Cycle 1: Child 1 created and initialized
    mockGetEvents.mockImplementation(async (params: any) => {
      const contractIds = params.filters?.[0]?.contractIds ?? params.contractIds ?? [];
      if (contractIds.includes(FACTORY_ID)) {
        return {
          events: [
            {
              contractId: { contractId: () => FACTORY_ID },
              topic: ["created"],
              ledger: 100,
              ledgerClosedAt: new Date(100 * 1000).toISOString(),
              value: { contract_id: CHILD_CONTRACT_1 },
            },
          ],
        };
      }
      if (contractIds.includes(CHILD_CONTRACT_1)) {
        return {
          events: [
            {
              contractId: { contractId: () => CHILD_CONTRACT_1 },
              topic: ["init"],
              ledger: 100,
              ledgerClosedAt: new Date(100 * 1000).toISOString(),
              value: { client: CLIENT_WALLET, freelancer: "GFREELANCER1" },
            },
          ],
        };
      }
      return { events: [] };
    });

    await pollEvents();

    // Cycle 2: Child 2 created and initialized
    mockGetLatestLedger.mockResolvedValue({ sequence: 300 });
    mockGetEvents.mockImplementation(async (params: any) => {
      const contractIds = params.filters?.[0]?.contractIds ?? params.contractIds ?? [];
      if (contractIds.includes(FACTORY_ID)) {
        return {
          events: [
            {
              contractId: { contractId: () => FACTORY_ID },
              topic: ["created"],
              ledger: 250,
              ledgerClosedAt: new Date(250 * 1000).toISOString(),
              value: { contract_id: CHILD_CONTRACT_2 },
            },
          ],
        };
      }
      if (contractIds.includes(CHILD_CONTRACT_2)) {
        return {
          events: [
            {
              contractId: { contractId: () => CHILD_CONTRACT_2 },
              topic: ["init"],
              ledger: 250,
              ledgerClosedAt: new Date(250 * 1000).toISOString(),
              value: { client: CLIENT_WALLET, freelancer: "GFREELANCER2" },
            },
          ],
        };
      }
      return { events: [] };
    });

    await pollEvents();

    const jobsResult = await getJobsByWallet(CLIENT_WALLET);
    expect(jobsResult.total).toBe(2);
    const returnedContractIds = jobsResult.jobs.map((j) => j.contract_id);
    expect(returnedContractIds).toContain(CHILD_CONTRACT_1);
    expect(returnedContractIds).toContain(CHILD_CONTRACT_2);
  });
});
