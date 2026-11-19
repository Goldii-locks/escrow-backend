import { jest } from "@jest/globals";
import Database from "better-sqlite3";

const originalTimeout = process.env.RPC_TIMEOUT_MS;
process.env.RPC_TIMEOUT_MS = "1000";

const serverOptions: unknown[] = [];
const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetEvents = jest.fn<() => Promise<{ events: unknown[] }>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    constructor(url: string, options: unknown) {
      serverOptions.push({ url, options });
    }
    getLatestLedger = mockGetLatestLedger;
    getEvents = mockGetEvents;
  },
}));

jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  scValToNative: (value: unknown) => value,
}));

const {
  startPoller,
  stopPoller,
  resetFailureState,
  getConsecutiveFailures,
  pollCycleWatchdogMs,
  POLL_CYCLE_WATCHDOG_FACTOR,
} = await import("../src/indexer/poller.js");
const { setDb, runMigrations } = await import("../src/indexer/db.js");

const ENV_CONTRACT = "CENVFALLBACKCONTRACT";
let testDb: Database.Database;

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("indexer RPC timeouts and poll-cycle watchdog (#954)", () => {
  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
    runMigrations();
  });

  afterAll(() => {
    stopPoller();
    testDb.close();
    if (originalTimeout === undefined) delete process.env.RPC_TIMEOUT_MS;
    else process.env.RPC_TIMEOUT_MS = originalTimeout;
  });

  beforeEach(() => {
    stopPoller();
    resetFailureState();
    mockGetLatestLedger.mockReset();
    mockGetEvents.mockReset();
    mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
    mockGetEvents.mockResolvedValue({ events: [] });
    process.env.CONTRACT_ID = ENV_CONTRACT;
    testDb.exec("DELETE FROM events");
    testDb.exec("DELETE FROM monitored_contracts");
  });

  afterEach(() => {
    stopPoller();
    jest.useRealTimers();
  });

  it("passes RPC_TIMEOUT_MS to the indexer's Server instances", () => {
    expect(serverOptions.length).toBeGreaterThan(0);
    for (const entry of serverOptions) {
      expect(entry).toMatchObject({ options: { timeout: 1000 } });
    }
  });

  it("uses five RPC timeouts as the cycle deadline", () => {
    expect(POLL_CYCLE_WATCHDOG_FACTOR).toBe(5);
    expect(pollCycleWatchdogMs()).toBe(5000);
  });

  it("fails a hung getEvents cycle, records the failure and reschedules the next poll", async () => {
    jest.useFakeTimers();
    mockGetEvents.mockReturnValue(new Promise(() => {}));

    startPoller();
    await flushPromises();
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(1);
    expect(mockGetEvents).toHaveBeenCalledTimes(1);

    const before = getConsecutiveFailures();
    await jest.advanceTimersByTimeAsync(pollCycleWatchdogMs());
    await flushPromises();
    expect(getConsecutiveFailures()).toBeGreaterThan(before);

    // The loop schedules the next cycle off the watchdog failure instead of
    // waiting forever on the hung RPC.
    await jest.advanceTimersByTimeAsync(30_000);
    await flushPromises();
    expect(mockGetLatestLedger.mock.calls.length).toBeGreaterThan(1);
  });

  it("an abandoned cycle whose RPC finally answers writes nothing", async () => {
    jest.useFakeTimers();
    let answer!: (value: { events: unknown[] }) => void;
    mockGetEvents.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      })
    );

    startPoller();
    await flushPromises();
    await jest.advanceTimersByTimeAsync(pollCycleWatchdogMs());
    await flushPromises();
    const failuresAfterWatchdog = getConsecutiveFailures();

    // The hung getEvents resolves after the watchdog gave up on its cycle.
    answer({
      events: [
        {
          id: "stale-cycle-event",
          contractId: { contractId: () => ENV_CONTRACT },
          topic: ["fund"],
          ledger: 99,
          ledgerClosedAt: new Date(99_000).toISOString(),
          value: { client: "GCLIENT" },
        },
      ],
    });
    await flushPromises();

    expect(testDb.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
    // Neither a success nor a second failure is recorded for it.
    expect(getConsecutiveFailures()).toBe(failuresAfterWatchdog);
  });
});
