import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import { setDb, runMigrations, registerContract } from "../src/indexer/db.js";

const mockLogger = {
  info: jest.fn<(...args: any[]) => void>(),
  warn: jest.fn<(...args: any[]) => void>(),
  error: jest.fn<(...args: any[]) => void>(),
  debug: jest.fn<(...args: any[]) => void>(),
};

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: mockLogger,
}));

jest.unstable_mockModule("../src/indexer/webhook-delivery.js", () => ({
  deliverWebhooks: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetEvents = jest.fn<() => Promise<{ events: any[] }>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: jest.fn().mockImplementation(() => ({
    getLatestLedger: mockGetLatestLedger,
    getEvents: mockGetEvents,
  })),
}));

jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  scValToNative: (val: unknown) => val,
}));

const { pollEvents, resetFailureState } = await import("../src/indexer/poller.js");
const {
  logIndexerRunnerPollDiagnostics,
  payloadSizeBytes,
} = await import("../src/indexer/indexer_runner.js");

describe("indexer_runner polling diagnostics (#252)", () => {
  let testDb: Database.Database;

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
    jest.clearAllMocks();
    testDb.exec("DELETE FROM events");
    testDb.exec("DELETE FROM monitored_contracts");
    testDb.exec(
      "UPDATE indexer_state SET value = '0' WHERE key = 'last_ledger_sequence'",
    );
    registerContract("TEST-CONTRACT", "test");
  });

  it("helper logs include elapsedMs in diagnostic strings", () => {
    logIndexerRunnerPollDiagnostics({
      operation: "unit",
      status: "success",
      elapsedMs: 42,
      payloadSizeBytes: 128,
      eventCount: 2,
    });

    const calls = mockLogger.debug.mock.calls.filter(
      (call: any[]) =>
        typeof call[0] === "string" &&
        call[0].includes("indexer_runner poll diagnostics"),
    );
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toMatchObject({
      elapsedMs: 42,
      payloadSizeBytes: 128,
      eventCount: 2,
      status: "success",
    });
  });

  it("payloadSizeBytes measures JSON byte length", () => {
    expect(payloadSizeBytes([{ a: 1 }])).toBeGreaterThan(0);
    expect(payloadSizeBytes(null)).toBeGreaterThan(0);
  });

  it("pollEvents emits started diagnostics with elapsedMs", async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
    mockGetEvents.mockResolvedValue({ events: [] });

    await pollEvents();

    const started = mockLogger.debug.mock.calls.filter(
      (call: any[]) =>
        typeof call[0] === "string" &&
        call[0].includes("indexer_runner poll diagnostics") &&
        call[1]?.status === "started",
    );
    expect(started.length).toBeGreaterThanOrEqual(1);
    expect(started[0][1]).toHaveProperty("elapsedMs");
    expect(typeof started[0][1].elapsedMs).toBe("number");
  });

  it("pollEvents success diagnostics include elapsedMs and payloadSizeBytes", async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
    mockGetEvents.mockResolvedValue({
      events: [
        {
          contractId: { contractId: () => "TEST-CONTRACT" },
          topic: ["funded"],
          ledger: 50,
          ledgerClosedAt: "2024-01-01T00:00:00Z",
          value: { amount: "100" },
        },
      ],
    });

    await pollEvents();

    const successCalls = mockLogger.debug.mock.calls.filter(
      (call: any[]) =>
        typeof call[0] === "string" &&
        call[0].includes("indexer_runner poll diagnostics") &&
        call[1]?.status === "success",
    );
    expect(successCalls.length).toBeGreaterThanOrEqual(1);
    const last = successCalls[successCalls.length - 1][1];
    expect(last).toHaveProperty("elapsedMs");
    expect(typeof last.elapsedMs).toBe("number");
    expect(last.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(last).toHaveProperty("payloadSizeBytes");
    expect(last.payloadSizeBytes).toBeGreaterThan(0);
    expect(last.eventCount).toBe(1);
  });

  it("failure diagnostics still include elapsedMs", async () => {
    mockGetLatestLedger.mockRejectedValue(new Error("RPC down"));

    await pollEvents();

    const failureCalls = mockLogger.debug.mock.calls.filter(
      (call: any[]) =>
        typeof call[0] === "string" &&
        call[0].includes("indexer_runner poll diagnostics") &&
        call[1]?.status === "failure",
    );
    expect(failureCalls.length).toBeGreaterThanOrEqual(1);
    expect(failureCalls[0][1]).toHaveProperty("elapsedMs");
    expect(typeof failureCalls[0][1].elapsedMs).toBe("number");
    expect(failureCalls[0][1].error).toMatch(/RPC down/);
  });
});
