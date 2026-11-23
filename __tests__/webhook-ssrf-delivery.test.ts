/**
 * Delivery-time SSRF coverage (#605).
 *
 * The subscribe-time check cannot be the last word: a public hostname can be
 * re-pointed at an internal address after the record is stored. Delivery
 * therefore re-validates the target before every attempt and never follows
 * redirects, so a public URL cannot bounce the POST into the private network.
 */

import Database from "better-sqlite3";
import { jest } from "@jest/globals";
import {
  initSchema,
  setDb,
  type EventDbRow,
} from "../src/indexer/db.js";

const CONTRACT =
  "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";

const EVENT: EventDbRow = {
  id: 1,
  contract_id: CONTRACT,
  event_type: "funded",
  ledger_sequence: 100,
  timestamp: 1_700_000_000,
  data_json: JSON.stringify({ client: "GCLIENT" }),
  created_at: "2026-01-01T00:00:00Z",
};

type FetchMock = jest.Mock<
  (url: string, init?: RequestInit) => Promise<{ ok: boolean; status?: number }>
>;

let testDb: Database.Database;
let mockFetch: FetchMock;

beforeAll(() => {
  testDb = new Database(":memory:");
  setDb(testDb);
  initSchema();

  mockFetch = jest.fn<
    (url: string, init?: RequestInit) => Promise<{ ok: boolean; status?: number }>
  >();
  (global as unknown as { fetch: unknown }).fetch = mockFetch;
});

afterAll(() => {
  delete (global as unknown as { fetch?: unknown }).fetch;
  testDb.close();
});

beforeEach(() => {
  mockFetch.mockReset();
});

describe("delivery-time guard (#605)", () => {
  it("blocks a private IP literal before calling fetch", async () => {
    const { deliverToUrl } = await import(
      "../src/indexer/webhook-delivery.js"
    );

    const outcome = await deliverToUrl("http://169.254.169.254/latest", EVENT);

    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe("BLOCKED_URL");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("blocks loopback and RFC 1918 targets before calling fetch", async () => {
    const { deliverToUrl } = await import(
      "../src/indexer/webhook-delivery.js"
    );

    for (const url of [
      "http://127.0.0.1:3001/hook",
      "https://10.0.0.5/hook",
      "https://192.168.0.10/hook",
      "https://[::1]/hook",
    ]) {
      const outcome = await deliverToUrl(url, EVENT);
      expect(outcome.ok).toBe(false);
      expect(outcome.errorCode).toBe("BLOCKED_URL");
    }

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not follow redirects", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 302 });

    const { deliverToUrl } = await import(
      "../src/indexer/webhook-delivery.js"
    );

    const outcome = await deliverToUrl(
      "https://example.com/redirect-to-metadata",
      EVENT
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(302);
    expect(outcome.errorCode).toBe("REDIRECT_302");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect(options.redirect).toBe("manual");
  });
});
