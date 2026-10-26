/**
 * Delivery-timeout coverage (#606).
 *
 * Undici has no overall deadline for a request, so a receiver that accepts
 * the connection and then never answers used to pin the delivery loop. These
 * tests use real local HTTP servers: one that accepts and never responds, one
 * that answers 200. The hung receiver must fail the attempt once
 * WEBHOOK_TIMEOUT_MS elapses, and delivery must still reach the healthy
 * subscriber that comes after it.
 *
 * The #605 guard blocks loopback targets in general; these tests opt in with
 * WEBHOOK_ALLOW_PRIVATE_HOSTS, which is honoured only when NODE_ENV=test.
 */

import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import {
  initSchema,
  setDb,
  addSubscription,
  insertEvent,
  type EventDbRow,
} from "../src/indexer/db.js";
import {
  deliverToUrl,
  deliverWebhooks,
} from "../src/indexer/webhook-delivery.js";

jest.setTimeout(20_000);

const CONTRACT =
  "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";
const TIMEOUT_MS = 250;

const EVENT: EventDbRow = {
  id: 1,
  contract_id: CONTRACT,
  event_type: "funded",
  ledger_sequence: 100,
  timestamp: 1_700_000_000,
  data_json: JSON.stringify({ client: "GCLIENT" }),
  created_at: "2026-01-01T00:00:00Z",
};

const ORIGINAL_ENV = { ...process.env };

let testDb: Database.Database;

interface TrackedServer {
  close: () => Promise<void>;
}

function track(server: http.Server): TrackedServer {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

beforeAll(() => {
  testDb = new Database(":memory:");
  setDb(testDb);
  initSchema();
});

afterAll(() => {
  testDb.close();
});

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.WEBHOOK_TIMEOUT_MS = String(TIMEOUT_MS);
  process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS = "1";
  testDb.exec("DELETE FROM webhook_subscriptions");
  testDb.exec("DELETE FROM events");
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("webhook delivery timeout (#606)", () => {
  it("fails a stuck attempt once WEBHOOK_TIMEOUT_MS elapses", async () => {
    const hanging = http.createServer(() => {
      // Deliberately never responds.
    });
    const tracker = track(hanging);
    const port = await listen(hanging);

    try {
      const startedAt = Date.now();
      const outcome = await deliverToUrl(
        `http://127.0.0.1:${port}/never`,
        EVENT
      );
      const elapsed = Date.now() - startedAt;

      expect(outcome.ok).toBe(false);
      expect(outcome.errorCode).toBe("TimeoutError");
      expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
      expect(elapsed).toBeLessThan(3000);
    } finally {
      await tracker.close();
    }
  });

  it("still delivers to the next subscriber after one times out", async () => {
    const hanging = http.createServer(() => {
      // Deliberately never responds.
    });
    const hangingTracker = track(hanging);
    const hangingPort = await listen(hanging);

    let okHits = 0;
    const healthy = http.createServer((req, res) => {
      okHits += 1;
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const healthyTracker = track(healthy);
    const healthyPort = await listen(healthy);

    try {
      const hangingUrl = `http://127.0.0.1:${hangingPort}/never`;
      const healthyUrl = `http://127.0.0.1:${healthyPort}/hook`;

      addSubscription(CONTRACT, hangingUrl, ["funded"]);
      addSubscription(CONTRACT, healthyUrl, ["funded"]);
      insertEvent(
        CONTRACT,
        "funded",
        100,
        1_700_000_000,
        JSON.stringify({ client: "GCLIENT" })
      );

      const startedAt = Date.now();
      const results = await deliverWebhooks(100, 100);
      const elapsed = Date.now() - startedAt;

      const timedOut = results.find((r) => r.webhookUrl === hangingUrl);
      const delivered = results.find((r) => r.webhookUrl === healthyUrl);

      expect(timedOut).toBeDefined();
      expect(timedOut?.success).toBe(false);
      expect(timedOut?.attempts).toBe(3);
      expect(timedOut?.errorCode).toBe("TimeoutError");

      expect(delivered).toBeDefined();
      expect(delivered?.success).toBe(true);
      expect(okHits).toBe(1);

      // 3 attempts * 250ms + 500ms and 1500ms backoff, plus the healthy POST.
      expect(elapsed).toBeLessThan(4000);
    } finally {
      await hangingTracker.close();
      await healthyTracker.close();
    }
  });
});
