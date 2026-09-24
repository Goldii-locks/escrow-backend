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

const { pollEvents, getConsecutiveFailures, resetFailureState } =
  await import("../src/indexer/poller.js");
const { IndexerRunnerFailureMonitor } = await import(
  "../src/indexer/indexer_runner.js"
);

describe("indexer_runner alerting notifications (#253)", () => {
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

  describe("IndexerRunnerFailureMonitor unit alerts", () => {
    it("does not warn below the configured error count", () => {
      const monitor = new IndexerRunnerFailureMonitor({
        name: "unit",
        failureThreshold: 3,
      });
      monitor.recordFailure("poll", { error: "one" });
      monitor.recordFailure("poll", { error: "two" });

      const warns = mockLogger.warn.mock.calls.filter((call: any[]) =>
        String(call[0]).includes("consecutive failure threshold reached"),
      );
      expect(warns).toHaveLength(0);
      expect(monitor.getConsecutiveFailures()).toBe(2);
    });

    it("emits a warning exactly when the threshold is reached", () => {
      const monitor = new IndexerRunnerFailureMonitor({
        name: "unit",
        failureThreshold: 3,
      });
      monitor.recordFailure("poll", { error: "one" });
      monitor.recordFailure("poll", { error: "two" });
      monitor.recordFailure("poll", { error: "three" });

      const warns = mockLogger.warn.mock.calls.filter((call: any[]) =>
        String(call[0]).includes("consecutive failure threshold reached"),
      );
      expect(warns).toHaveLength(1);
      expect(warns[0][1]).toMatchObject({
        runner: "unit",
        consecutiveFailures: 3,
        threshold: 3,
        error: "three",
      });
      expect(monitor.isAlertActive()).toBe(true);
    });

    it("does not re-alert while already over the threshold", () => {
      const monitor = new IndexerRunnerFailureMonitor({
        name: "unit",
        failureThreshold: 2,
      });
      monitor.recordFailure("rpc", { error: "a" });
      monitor.recordFailure("rpc", { error: "b" });
      monitor.recordFailure("rpc", { error: "c" });

      const warns = mockLogger.warn.mock.calls.filter((call: any[]) =>
        String(call[0]).includes("consecutive failure threshold reached"),
      );
      expect(warns).toHaveLength(1);
      expect(monitor.getConsecutiveFailures()).toBe(3);
    });

    it("resets consecutive failures after success", () => {
      const monitor = new IndexerRunnerFailureMonitor({ failureThreshold: 3 });
      monitor.recordFailure("poll", { error: "x" });
      expect(monitor.getConsecutiveFailures()).toBe(1);
      monitor.recordSuccess();
      expect(monitor.getConsecutiveFailures()).toBe(0);
      expect(monitor.isAlertActive()).toBe(false);
      expect(monitor.getLastSuccessfulAt()).toBeTruthy();
    });
  });

  describe("poller integration", () => {
    it("increments consecutive failures on poll error", async () => {
      mockGetLatestLedger.mockRejectedValue(new Error("RPC connection failed"));
      await pollEvents();
      expect(getConsecutiveFailures()).toBe(1);
      await pollEvents();
      expect(getConsecutiveFailures()).toBe(2);
    });

    it("triggers indexer_runner warning after configured error counts", async () => {
      mockGetLatestLedger.mockRejectedValue(new Error("persistent failure"));

      await pollEvents();
      await pollEvents();
      await pollEvents();

      const alertCalls = mockLogger.warn.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" &&
          call[0].includes("indexer_runner alert: consecutive failure threshold reached"),
      );
      expect(alertCalls.length).toBeGreaterThanOrEqual(1);
      expect(alertCalls[0][1]).toMatchObject({
        consecutiveFailures: 3,
        threshold: expect.any(Number),
      });
    });

    it("resets consecutive failures after a successful poll", async () => {
      mockGetLatestLedger.mockRejectedValue(new Error("fail 1"));
      await pollEvents();
      expect(getConsecutiveFailures()).toBe(1);

      mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
      mockGetEvents.mockResolvedValue({ events: [] });
      await pollEvents();
      expect(getConsecutiveFailures()).toBe(0);
    });
  });
});
