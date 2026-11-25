import { jest } from "@jest/globals";
import Database from "better-sqlite3";

// Mock the alerting module so the call sites can be asserted in isolation:
// any real POST to an operator webhook is irrelevant here.
const mockSendOpsAlert = jest.fn(async () => {});
jest.unstable_mockModule("../src/utils/ops-alerts.js", () => ({
  sendOpsAlert: mockSendOpsAlert,
  resetOpsAlertsForTests: jest.fn(),
}));

// A permanently dead endpoint must not need real DNS.
jest.unstable_mockModule("../src/utils/webhook-url-guard.js", () => ({
  assertDeliveryTargetAllowed: jest.fn(async () => true),
  validateWebhookUrl: jest.fn(() => ({ ok: true })),
}));

// The RPC Server reports a mismatched network so the startup check fires.
jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: jest.fn().mockImplementation(() => ({
    getNetwork: async () => ({ passphrase: "A completely different network" }),
  })),
}));

// One delivery failure is enough to auto-disable.
process.env.WEBHOOK_DISABLE_AFTER = "1";

const {
  addSubscription,
  insertEvent,
  initSchema,
  setDb,
} = await import("../src/indexer/db.js");
const { deliverWebhooks } = await import("../src/indexer/webhook-delivery.js");
const { reconcileContract } = await import("../src/indexer/reconciliation.js");
const { assertRpcNetworkMatches } = await import("../src/routes/jobs/shared.js");

let testDb: Database.Database;

const CONTRACT = "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";
const TOKEN = "CTOKEN000000000000000000000000000000000000000000000000000000001";

function alertTitles(): string[] {
  return mockSendOpsAlert.mock.calls.map(
    (c) => (c as unknown as [{ title: string }])[0].title,
  );
}

beforeAll(() => {
  testDb = new Database(":memory:");
  setDb(testDb);
  initSchema();
});

afterAll(() => {
  testDb.close();
  delete process.env.WEBHOOK_DISABLE_AFTER;
});

beforeEach(() => {
  mockSendOpsAlert.mockClear();
  testDb.exec("DELETE FROM webhook_subscriptions");
  testDb.exec("DELETE FROM events");
  testDb.exec("DELETE FROM webhook_deliveries");
  testDb.exec("DELETE FROM monitored_contracts");
  testDb.exec("DELETE FROM reconciliation_results");
});

describe("sendOpsAlert call sites", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("alerts when a webhook subscription is auto-disabled", async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 500 }) as unknown as Response) as unknown as typeof fetch;
    addSubscription(CONTRACT, "https://example.com/dead", ["*"], null);
    insertEvent(CONTRACT, "fund", 5000, 1, "{}");

    await deliverWebhooks(5000, 5000);

    expect(alertTitles()).toContain("Webhook subscription auto-disabled");
  });

  it("alerts on a reconciliation mismatch", async () => {
    testDb
      .prepare("INSERT INTO monitored_contracts (contract_id, active) VALUES (?, 1)")
      .run(CONTRACT);
    insertEvent(
      CONTRACT,
      "fund",
      100,
      1000,
      JSON.stringify({ token: TOKEN, total_amount: "1000" }),
    );

    const result = await reconcileContract(CONTRACT, async () => 650n);

    expect(result.status).toBe("mismatch");
    expect(alertTitles()).toContain("Reconciliation mismatch");
  });

  it("alerts before refusing to start on a network mismatch", async () => {
    await expect(assertRpcNetworkMatches()).rejects.toThrow(/mismatch/i);

    expect(alertTitles()).toContain("Startup network mismatch");
  });
});
