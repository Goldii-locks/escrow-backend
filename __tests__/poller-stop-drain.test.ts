import { jest } from "@jest/globals";
import Database from "better-sqlite3";

const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetEvents = jest.fn<() => Promise<{ events: unknown[] }>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getLatestLedger = mockGetLatestLedger;
    getEvents = mockGetEvents;
  },
}));

jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  scValToNative: (value: unknown) => value,
}));

const { startPoller, stopPoller } = await import("../src/indexer/poller.js");
const { setDb, runMigrations } = await import("../src/indexer/db.js");
const logger = (await import("../src/utils/logger.js")).default;

describe("stopPoller drains the in-flight cycle (#870)", () => {
  let testDb: Database.Database;

  beforeEach(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
    runMigrations();
    process.env.CONTRACT_ID = "CSTOPDRAINCONTRACT";
  });

  it("closes the DB only after a poll whose RPC resolves after stopPoller()", async () => {
    let releaseRpc!: () => void;
    mockGetLatestLedger.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRpc = () => resolve({ sequence: 100 });
        }),
    );
    mockGetEvents.mockResolvedValue({ events: [] });
    const errorSpy = jest.spyOn(logger, "error");

    startPoller();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockGetLatestLedger).toHaveBeenCalled();

    const order: string[] = [];
    const closeDb = jest.fn(() => {
      order.push("closeDb");
      testDb.close();
    });
    // Same order as shutdown(): await stopPoller() before closeDb().
    const pending = stopPoller().then(() => {
      order.push("pollerStopped");
      closeDb();
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closeDb).not.toHaveBeenCalled();

    releaseRpc();
    await pending;

    expect(order).toEqual(["pollerStopped", "closeDb"]);
    const messages = errorSpy.mock.calls.map((c) => JSON.stringify(c));
    expect(messages.join("\n")).not.toMatch(/database connection is not open/);
    errorSpy.mockRestore();
  });
});
