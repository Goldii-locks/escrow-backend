import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import {
  initSchema,
  setDb,
  insertEvent,
  addSubscription,
} from "../src/indexer/db.js";

const mockLogger = {
  info: jest.fn<(...args: any[]) => void>(),
  warn: jest.fn<(...args: any[]) => void>(),
  error: jest.fn<(...args: any[]) => void>(),
  debug: jest.fn<(...args: any[]) => void>(),
};

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: mockLogger,
}));

const {
  dispatchSubscribe,
  dispatchUnsubscribe,
  dispatchLedgerRange,
  WEBHOOK_DISPATCHER_ROUTE_PREFIX,
} = await import("../src/utils/webhook_dispatcher.js");

const CONTRACT_A =
  "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";
const WEBHOOK_URL = "https://example.com/webhook";

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
  testDb.exec("DELETE FROM webhook_subscriptions");
  testDb.exec("DELETE FROM events");
  jest.clearAllMocks();
});

describe("webhook_dispatcher telemetry (#520)", () => {
  it("logs handler-entered and response-sent tracking indicators on subscribe", () => {
    const result = dispatchSubscribe({
      contract_id: CONTRACT_A,
      webhook_url: WEBHOOK_URL,
      event_types: ["funded"],
    });

    expect(result.ok).toBe(true);
    expect(typeof result.traceId).toBe("string");

    const entered = mockLogger.debug.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" &&
        call[0] === "webhook_dispatcher subscribe handler entered"
    );
    expect(entered.length).toBe(1);
    expect(entered[0][1]).toMatchObject({
      route: `${WEBHOOK_DISPATCHER_ROUTE_PREFIX}/subscribe`,
      contractId: CONTRACT_A,
    });
    expect(typeof entered[0][1].traceId).toBe("string");
    expect(Array.isArray(entered[0][1].bodyKeys)).toBe(true);

    const responseSent = mockLogger.debug.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" &&
        call[0] === "webhook_dispatcher subscribe response sent"
    );
    expect(responseSent.length).toBe(1);
    expect(responseSent[0][1]).toMatchObject({
      status: 200,
      success: true,
      traceId: result.traceId,
    });
  });

  it("logs failure tracking indicators when subscribe validation fails", () => {
    const result = dispatchSubscribe({
      contract_id: "",
      webhook_url: WEBHOOK_URL,
    } as any);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.status).toBe(400);

    const responseSent = mockLogger.debug.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0] === "webhook_dispatcher subscribe response sent"
    );
    expect(responseSent?.[1]).toMatchObject({
      status: 400,
      success: false,
      traceId: result.traceId,
    });
  });

  it("logs unsubscribe pipeline telemetry with matching traceId", () => {
    addSubscription(CONTRACT_A, WEBHOOK_URL, ["funded"]);

    const result = dispatchUnsubscribe({
      contract_id: CONTRACT_A,
      webhook_url: WEBHOOK_URL,
    });

    expect(result.ok).toBe(true);

    const entered = mockLogger.debug.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0] === "webhook_dispatcher unsubscribe handler entered"
    );
    expect(entered?.[1]).toMatchObject({
      route: `${WEBHOOK_DISPATCHER_ROUTE_PREFIX}/unsubscribe`,
      traceId: result.traceId,
    });

    const responseSent = mockLogger.debug.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0] === "webhook_dispatcher unsubscribe response sent"
    );
    expect(responseSent?.[1]).toMatchObject({
      status: 200,
      success: true,
      traceId: result.traceId,
    });
  });

  it("logs delivery pipeline start/complete tracking indicators", async () => {
    const mockFetch = jest.fn<(...args: any[]) => any>();
    mockFetch.mockResolvedValue({ ok: true });
    (global as any).fetch = mockFetch;

    addSubscription(CONTRACT_A, WEBHOOK_URL, ["funded"]);
    insertEvent(
      CONTRACT_A,
      "funded",
      100,
      1000,
      JSON.stringify({ client: "GCLIENT" })
    );

    const { traceId, results } = await dispatchLedgerRange(100, 100);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);

    const started = mockLogger.debug.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0] === "webhook_dispatcher delivery pipeline started"
    );
    expect(started?.[1]).toMatchObject({
      traceId,
      startLedger: 100,
      endLedger: 100,
      subscriptionCount: 1,
    });

    const completed = mockLogger.debug.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0] === "webhook_dispatcher delivery pipeline completed"
    );
    expect(completed?.[1]).toMatchObject({
      traceId,
      total: 1,
      delivered: 1,
      failed: 0,
    });

    delete (global as any).fetch;
  });
});
