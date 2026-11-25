import { jest } from "@jest/globals";
import Database from "better-sqlite3";

const mockSendOpsAlert = jest.fn(async () => {});
jest.unstable_mockModule("../src/utils/ops-alerts.js", () => ({
  sendOpsAlert: mockSendOpsAlert,
  resetOpsAlertsForTests: jest.fn(),
}));

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: mockLogger,
}));

jest.unstable_mockModule("../src/indexer/webhook-delivery.js", () => ({
  deliverWebhooks: jest.fn(async () => []),
}));

const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetEvents = jest.fn<() => Promise<{ events: unknown[] }>>();
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
const { setDb, runMigrations, registerContract } = await import("../src/indexer/db.js");

let testDb: Database.Database;

function alertTitles(): string[] {
  return mockSendOpsAlert.mock.calls.map(
    (c) => (c as unknown as [{ title: string }])[0].title,
  );
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
  mockSendOpsAlert.mockClear();
  testDb.exec("DELETE FROM events");
  testDb.exec("DELETE FROM monitored_contracts");
  testDb.exec("UPDATE indexer_state SET value = '0' WHERE key = 'last_ledger_sequence'");
  registerContract("TEST-CONTRACT", "test");
});

describe("poller ops alerts", () => {
  it("alerts when the consecutive failure threshold is exceeded", async () => {
    mockGetLatestLedger.mockRejectedValue(new Error("persistent failure"));

    await pollEvents();
    await pollEvents();
    await pollEvents();

    expect(alertTitles()).toContain(
      "Poller alert: consecutive failure threshold exceeded",
    );
  });

  it("alerts when a poll stall is detected", async () => {
    const original = process.env.POLLER_STALL_THRESHOLD_MS;
    process.env.POLLER_STALL_THRESHOLD_MS = "1";

    try {
      mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
      mockGetEvents.mockResolvedValue({ events: [] });
      await pollEvents();

      await new Promise((r) => setTimeout(r, 5));

      mockGetLatestLedger.mockResolvedValue({ sequence: 101 });
      mockGetEvents.mockResolvedValue({ events: [] });
      await pollEvents();

      expect(alertTitles()).toContain("Poller stall detected");
    } finally {
      if (original === undefined) delete process.env.POLLER_STALL_THRESHOLD_MS;
      else process.env.POLLER_STALL_THRESHOLD_MS = original;
    }
  });
});
