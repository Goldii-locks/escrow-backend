import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import { initSchema, setDb, recordSkippedLedgerRange } from "../src/indexer/db.js";
import { resetOpsAlertsForTests } from "../src/utils/ops-alerts.js";

// This suite exercises the real sendOpsAlert integration (db.ts is loaded by
// jest.setup before per-test module mocks can apply), so it mocks global.fetch
// instead of the alerting module.

const originalFetch = global.fetch;
const originalUrl = process.env.OPS_ALERT_WEBHOOK_URL;

let testDb: Database.Database;

beforeAll(() => {
  testDb = new Database(":memory:");
  setDb(testDb);
  initSchema();
});

afterAll(() => {
  testDb.close();
  global.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.OPS_ALERT_WEBHOOK_URL;
  else process.env.OPS_ALERT_WEBHOOK_URL = originalUrl;
});

beforeEach(() => {
  resetOpsAlertsForTests();
  delete process.env.OPS_ALERT_WEBHOOK_URL;
});

it("recordSkippedLedgerRange sends an operator alert", () => {
  process.env.OPS_ALERT_WEBHOOK_URL = "https://alerts.example.com/hook";
  const fetchMock = jest.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
  global.fetch = fetchMock as unknown as typeof fetch;

  const entry = recordSkippedLedgerRange(100, 199);

  expect(entry).toMatchObject({ from: 100, to: 199, clampedTo: 200 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const body = JSON.parse(
    String(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body,
    ),
  );
  expect(body.text).toContain("Indexer skipped a ledger range");
  expect(body.text).toContain("100");
  expect(body.text).toContain("199");
});
