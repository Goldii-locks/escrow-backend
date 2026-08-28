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

const { pollEvents, getConsecutiveFailures, getLastSuccessfulPollAt, resetFailureState } =
  await import("../src/indexer/poller.js");

describe("Poller Alerting & Diagnostics (#271, #270)", () => {
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
    testDb.exec("UPDATE indexer_state SET value = '0' WHERE key = 'last_ledger_sequence'");
    registerContract("TEST-CONTRACT", "test");
  });

  describe("Consecutive failure tracking (#271)", () => {
    it("starts with zero consecutive failures", () => {
      expect(getConsecutiveFailures()).toBe(0);
    });

    it("increments consecutive failures on poll error", async () => {
      mockGetLatestLedger.mockRejectedValue(new Error("RPC connection failed"));

      await pollEvents();
      expect(getConsecutiveFailures()).toBe(1);

      await pollEvents();
      expect(getConsecutiveFailures()).toBe(2);
    });

    it("resets consecutive failures after successful poll", async () => {
      mockGetLatestLedger.mockRejectedValue(new Error("fail 1"));
      await pollEvents();
      expect(getConsecutiveFailures()).toBe(1);

      mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
      mockGetEvents.mockResolvedValue({ events: [] });
      await pollEvents();
      expect(getConsecutiveFailures()).toBe(0);
    });

    it("resets via resetFailureState()", async () => {
      mockGetLatestLedger.mockRejectedValue(new Error("fail"));
      await pollEvents();
      expect(getConsecutiveFailures()).toBe(1);

      resetFailureState();
      expect(getConsecutiveFailures()).toBe(0);
      expect(getLastSuccessfulPollAt()).toBeNull();
    });

    it("logs error alert when failure threshold is exceeded", async () => {
      mockGetLatestLedger.mockRejectedValue(new Error("persistent failure"));

      await pollEvents();
      await pollEvents();
      await pollEvents();

      const alertCalls = mockLogger.error.mock.calls.filter(
        (call: any[]) => typeof call[0] === "string" && call[0].includes("consecutive failure threshold exceeded")
      );
      expect(alertCalls.length).toBeGreaterThanOrEqual(1);
      expect(alertCalls[0][1]).toMatchObject({
        consecutiveFailures: 3,
        threshold: expect.any(Number),
      });
    });
  });

  describe("Stall detection (#271)", () => {
    it("logs stall diagnostics when lastSuccessfulPollAt is set", async () => {
      // First poll: set lastSuccessfulPollAt
      mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
      mockGetEvents.mockResolvedValue({ events: [] });
      await pollEvents();

      expect(getLastSuccessfulPollAt()).toBeTruthy();

      // Second poll: stall diagnostics should fire
      mockGetLatestLedger.mockResolvedValue({ sequence: 101 });
      mockGetEvents.mockResolvedValue({ events: [] });
      await pollEvents();

      const debugCalls = mockLogger.debug.mock.calls;
      const stallDiagCalls = debugCalls.filter(
        (call: any[]) => typeof call[0] === "string" && call[0].includes("Poller stall diagnostics")
      );
      expect(stallDiagCalls.length).toBeGreaterThanOrEqual(1);
      expect(stallDiagCalls[stallDiagCalls.length - 1][1]).toHaveProperty("elapsedMsSinceLastSuccess");
      expect(stallDiagCalls[stallDiagCalls.length - 1][1]).toHaveProperty("stallThresholdMs");
    });

    it("logs stall warning when elapsed exceeds threshold", async () => {
      // Set a very low threshold so the warning triggers
      const originalThreshold = process.env.POLLER_STALL_THRESHOLD_MS;
      process.env.POLLER_STALL_THRESHOLD_MS = "1";

      // First poll: set lastSuccessfulPollAt
      mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
      mockGetEvents.mockResolvedValue({ events: [] });
      await pollEvents();

      // Wait slightly so elapsed > 1ms threshold
      await new Promise((r) => setTimeout(r, 5));

      // Second poll: should trigger stall warning
      mockGetLatestLedger.mockResolvedValue({ sequence: 101 });
      mockGetEvents.mockResolvedValue({ events: [] });
      mockLogger.warn.mockClear();
      await pollEvents();

      const stallCalls = mockLogger.warn.mock.calls.filter(
        (call: any[]) => typeof call[0] === "string" && call[0].includes("Poller stall detected")
      );
      expect(stallCalls.length).toBeGreaterThanOrEqual(1);
      expect(stallCalls[0][1]).toHaveProperty("elapsedMs");
      expect(stallCalls[0][1]).toHaveProperty("stallThresholdMs", 1);

      process.env.POLLER_STALL_THRESHOLD_MS = originalThreshold;
    });
  });

  describe("Diagnostics logging (#270)", () => {
    it("logs elapsed time in poll diagnostics", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
      mockGetEvents.mockResolvedValue({ events: [] });

      await pollEvents();

      const diagnosticCalls = mockLogger.debug.mock.calls.filter(
        (call: any[]) => typeof call[0] === "string" && call[0].includes("RPC getEvents diagnostics")
      );
      expect(diagnosticCalls.length).toBeGreaterThanOrEqual(1);
      expect(diagnosticCalls[0][1]).toHaveProperty("elapsedMs");
    });

    it("logs payload size in diagnostics", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
      mockGetEvents.mockResolvedValue({ events: [] });

      await pollEvents();

      const payloadCalls = mockLogger.debug.mock.calls.filter(
        (call: any[]) => typeof call[0] === "string" && call[0].includes("RPC getEvents diagnostics")
      );
      expect(payloadCalls.length).toBeGreaterThanOrEqual(1);
      expect(payloadCalls[0][1]).toHaveProperty("payloadSizeBytes");
    });

    it("includes elapsedMs in error log on failure", async () => {
      mockGetLatestLedger.mockRejectedValue(new Error("test error"));

      await pollEvents();

      const errorCalls = mockLogger.error.mock.calls.filter(
        (call: any[]) => typeof call[0] === "string" && call[0].includes("Error polling events")
      );
      expect(errorCalls.length).toBeGreaterThanOrEqual(1);
      expect(errorCalls[0][1]).toHaveProperty("elapsedMs");
      expect(errorCalls[0][1]).toHaveProperty("consecutiveFailures");
    });
  });
});
