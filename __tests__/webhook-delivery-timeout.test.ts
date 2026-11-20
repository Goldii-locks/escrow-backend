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
      // One inline attempt; later attempts belong to the retry sweep (#851).
      expect(timedOut?.attempts).toBe(1);
      expect(timedOut?.errorCode).toBe("TimeoutError");

      expect(delivered).toBeDefined();
      expect(delivered?.success).toBe(true);
      expect(okHits).toBe(1);

      // One 250ms attempt, run in parallel with the healthy POST.
      expect(elapsed).toBeLessThan(2000);
    } finally {
      await hangingTracker.close();
      await healthyTracker.close();
    }
  });
});

describe("independent per-subscriber delivery (#851)", () => {
  it("a healthy subscriber receives every event without waiting for a hanging one's timeouts", async () => {
    // A long timeout makes any wait on the hanging receiver obvious.
    const HANG_TIMEOUT_MS = 2000;
    process.env.WEBHOOK_TIMEOUT_MS = String(HANG_TIMEOUT_MS);

    let hangingHits = 0;
    const hanging = http.createServer(() => {
      hangingHits += 1;
      // Deliberately never responds.
    });
    const hangingTracker = track(hanging);
    const hangingPort = await listen(hanging);

    const healthyLedgers: number[] = [];
    let healthyDoneAt = 0;
    const healthy = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        healthyLedgers.push((JSON.parse(raw) as { ledger_sequence: number }).ledger_sequence);
        healthyDoneAt = Date.now();
        res.writeHead(200);
        res.end();
      });
    });
    const healthyTracker = track(healthy);
    const healthyPort = await listen(healthy);

    try {
      // The hanging subscriber is registered first, so a sequential loop
      // would reach it before the healthy one for every event.
      addSubscription(CONTRACT, `http://127.0.0.1:${hangingPort}/never`, ["funded"]);
      addSubscription(CONTRACT, `http://127.0.0.1:${healthyPort}/hook`, ["funded"]);
      const ledgers = [100, 101, 102, 103, 104];
      for (const ledger of ledgers) {
        insertEvent(CONTRACT, "funded", ledger, 1_700_000_000 + ledger, JSON.stringify({ ledger }));
      }

      const startedAt = Date.now();
      await deliverWebhooks(100, 104);

      // Every event reached the healthy subscriber, in order, well before
      // the hanging receiver's first attempt timed out.
      expect(healthyLedgers).toEqual(ledgers);
      expect(healthyDoneAt - startedAt).toBeLessThan(HANG_TIMEOUT_MS / 2);

      // The hanging receiver cost one attempt for the whole run; its queue
      // waits for the retry sweep instead of timing out once per event.
      expect(hangingHits).toBe(1);
    } finally {
      await hangingTracker.close();
      await healthyTracker.close();
    }
  });

  it("preserves per-subscriber order across the retry sweep", async () => {
    let failNext = true;
    const ledgersSeen: number[] = [];
    const flaky = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const ledger = (JSON.parse(raw) as { ledger_sequence: number }).ledger_sequence;
        if (failNext) {
          failNext = false;
          res.writeHead(500);
        } else {
          ledgersSeen.push(ledger);
          res.writeHead(200);
        }
        res.end();
      });
    });
    const tracker = track(flaky);
    const port = await listen(flaky);

    try {
      addSubscription(CONTRACT, `http://127.0.0.1:${port}/hook`, ["funded"]);
      for (const ledger of [100, 101, 102]) {
        insertEvent(CONTRACT, "funded", ledger, 1_700_000_000 + ledger, "{}");
      }

      // Ledger 100 fails: nothing later is sent while it waits for retry.
      await deliverWebhooks(100, 102);
      expect(ledgersSeen).toEqual([]);
      await deliverWebhooks(100, 102);
      expect(ledgersSeen).toEqual([]);

      // Once its backoff expires the sweep delivers it, then the queue resumes.
      testDb.exec("UPDATE webhook_deliveries SET next_attempt_at = 0 WHERE status = 'failed'");
      await deliverWebhooks(100, 102);
      expect(ledgersSeen).toEqual([100, 101, 102]);
    } finally {
      await tracker.close();
    }
  });
});
