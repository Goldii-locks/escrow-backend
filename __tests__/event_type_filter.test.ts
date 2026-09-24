import { jest, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import request from "supertest";
import express from "express";
import {
  initSchema,
  setDb,
  getDb,
  addSubscription,
  removeSubscription,
  getSubscriptions,
  getSubscriptionsForContract,
  type WebhookSubscription,
} from "../src/indexer/db.js";
import logger from "../src/utils/logger.js";

const CONTRACT_A = "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";
const CONTRACT_B = "CB3D5K7UXYZ123456789012345678901234567890123456789012345678902";
const WEBHOOK_URL_A = "https://example.com/webhook-a";
const WEBHOOK_URL_B = "https://example.com/webhook-b";

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
  testDb.exec("DELETE FROM indexer_state WHERE key != 'last_ledger_sequence'");
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

function countSubscriptions(): number {
  const row = testDb
    .prepare("SELECT COUNT(*) as cnt FROM webhook_subscriptions")
    .get() as { cnt: number };
  return row.cnt;
}

function getRawSubscription(
  contractId: string,
  webhookUrl: string
): WebhookSubscription | undefined {
  return testDb
    .prepare(
      "SELECT * FROM webhook_subscriptions WHERE contract_id = ? AND webhook_url = ?"
    )
    .get(contractId, webhookUrl) as WebhookSubscription | undefined;
}

describe("event_type_filter – Transaction Isolation", () => {
  describe("addSubscription – commit on success", () => {
    it("commits subscription row when transaction succeeds", () => {
      const countBefore = countSubscriptions();
      expect(countBefore).toBe(0);

      const eventTypes = ["funded", "approved", "delivered"];
      const sub = addSubscription(CONTRACT_A, WEBHOOK_URL_A, eventTypes);

      expect(sub).toBeTruthy();
      expect(sub.contract_id).toBe(CONTRACT_A);
      expect(sub.webhook_url).toBe(WEBHOOK_URL_A);
      expect(sub.event_types).toBe(JSON.stringify(eventTypes));
      expect(sub.id).toBeGreaterThan(0);

      const countAfter = countSubscriptions();
      expect(countAfter).toBe(1);

      const raw = getRawSubscription(CONTRACT_A, WEBHOOK_URL_A);
      expect(raw).toBeTruthy();
      expect(raw!.event_types).toBe(JSON.stringify(eventTypes));
    });

    it("commits wildcard event type subscription", () => {
      const sub = addSubscription(CONTRACT_A, WEBHOOK_URL_A, ["*"]);
      expect(sub.event_types).toBe(JSON.stringify(["*"]));

      const all = getSubscriptions();
      expect(all).toHaveLength(1);
      expect(all[0].event_types).toBe(JSON.stringify(["*"]));
    });

    it("idempotent INSERT OR IGNORE still commits within transaction", () => {
      const first = addSubscription(CONTRACT_A, WEBHOOK_URL_A, ["funded"]);
      const firstTypes = first.event_types;

      const second = addSubscription(CONTRACT_A, WEBHOOK_URL_A, [
        "approved",
        "delivered",
      ]);

      expect(countSubscriptions()).toBe(1);
      expect(second.event_types).toBe(firstTypes);
      expect(second.id).toBe(first.id);
    });

    it("commits multiple subscriptions atomically", () => {
      addSubscription(CONTRACT_A, WEBHOOK_URL_A, ["funded"]);
      addSubscription(CONTRACT_A, WEBHOOK_URL_B, ["approved"]);
      addSubscription(CONTRACT_B, WEBHOOK_URL_A, ["delivered"]);

      expect(countSubscriptions()).toBe(3);

      const forA = getSubscriptionsForContract(CONTRACT_A);
      expect(forA).toHaveLength(2);

      const forB = getSubscriptionsForContract(CONTRACT_B);
      expect(forB).toHaveLength(1);
      expect(forB[0].event_types).toBe(JSON.stringify(["delivered"]));
    });
  });

  describe("addSubscription – rollback on failure", () => {
    it("rolls back when an error is thrown inside transaction scope", () => {
      const db = getDb();
      const countBefore = countSubscriptions();

      const typesToInsert = ["funded", "approved"];
      const brokenTx = db.transaction(() => {
        db.prepare(
          `INSERT OR IGNORE INTO webhook_subscriptions
           (contract_id, webhook_url, event_types)
           VALUES (?, ?, ?)`
        ).run(
          CONTRACT_A,
          WEBHOOK_URL_A,
          JSON.stringify(typesToInsert)
        );

        const partial = testDb
          .prepare(
            "SELECT COUNT(*) as cnt FROM webhook_subscriptions WHERE contract_id = ?"
          )
          .get(CONTRACT_A) as { cnt: number };
        expect(partial.cnt).toBe(1);

        throw new Error("Simulated mid-transaction failure");
      });

      expect(() => brokenTx()).toThrow("Simulated mid-transaction failure");

      const countAfter = countSubscriptions();
      expect(countAfter).toBe(countBefore);

      const raw = getRawSubscription(CONTRACT_A, WEBHOOK_URL_A);
      expect(raw).toBeUndefined();
    });

    it("logs error and re-throws when addSubscription transaction fails", () => {
      const db = getDb();
      const countBefore = countSubscriptions();
      const errorSpy = jest
        .spyOn(logger, "error")
        .mockImplementation(() => logger);

      const originalPrepare = db.prepare.bind(db);
      let callCount = 0;
      const mockPrepare = jest.fn((sql: string) => {
        callCount += 1;
        if (
          callCount === 2 &&
          sql.includes("SELECT * FROM webhook_subscriptions")
        ) {
          throw new Error("Simulated SELECT failure after INSERT");
        }
        return originalPrepare(sql);
      });
      (db as any).prepare = mockPrepare;

      expect(() =>
        addSubscription(CONTRACT_A, WEBHOOK_URL_A, ["funded"])
      ).toThrow("Simulated SELECT failure after INSERT");

      (db as any).prepare = originalPrepare;

      expect(errorSpy).toHaveBeenCalledWith(
        "addSubscription failed – transaction rolled back",
        expect.objectContaining({
          contractId: CONTRACT_A,
          webhookUrl: WEBHOOK_URL_A,
          error: "Simulated SELECT failure after INSERT",
        })
      );

      const countAfter = countSubscriptions();
      expect(countAfter).toBe(countBefore);

      const raw = getRawSubscription(CONTRACT_A, WEBHOOK_URL_A);
      expect(raw).toBeUndefined();
    });
  });

  describe("removeSubscription – commit on success", () => {
    it("commits deletion when subscription exists", () => {
      addSubscription(CONTRACT_A, WEBHOOK_URL_A, ["funded"]);
      expect(countSubscriptions()).toBe(1);

      const removed = removeSubscription(CONTRACT_A, WEBHOOK_URL_A);
      expect(removed).toBe(true);
      expect(countSubscriptions()).toBe(0);

      const raw = getRawSubscription(CONTRACT_A, WEBHOOK_URL_A);
      expect(raw).toBeUndefined();
    });

    it("returns false and commits no-op when subscription does not exist", () => {
      const countBefore = countSubscriptions();
      expect(countBefore).toBe(0);

      const removed = removeSubscription(CONTRACT_A, WEBHOOK_URL_A);
      expect(removed).toBe(false);

      const countAfter = countSubscriptions();
      expect(countAfter).toBe(0);
    });

    it("commits selective deletion, leaving unrelated subscriptions intact", () => {
      addSubscription(CONTRACT_A, WEBHOOK_URL_A, ["funded"]);
      addSubscription(CONTRACT_A, WEBHOOK_URL_B, ["approved"]);
      addSubscription(CONTRACT_B, WEBHOOK_URL_A, ["delivered"]);
      expect(countSubscriptions()).toBe(3);

      const removed = removeSubscription(CONTRACT_A, WEBHOOK_URL_A);
      expect(removed).toBe(true);

      expect(countSubscriptions()).toBe(2);

      expect(getRawSubscription(CONTRACT_A, WEBHOOK_URL_A)).toBeUndefined();
      expect(getRawSubscription(CONTRACT_A, WEBHOOK_URL_B)).toBeTruthy();
      expect(getRawSubscription(CONTRACT_B, WEBHOOK_URL_A)).toBeTruthy();
    });
  });

  describe("removeSubscription – rollback on failure", () => {
    it("rolls back deletion when transaction fails mid-operation", () => {
      const db = getDb();
      addSubscription(CONTRACT_A, WEBHOOK_URL_A, ["funded"]);
      const countBefore = countSubscriptions();
      expect(countBefore).toBe(1);

      const brokenTx = db.transaction(() => {
        db.prepare(
          "DELETE FROM webhook_subscriptions WHERE contract_id = ? AND webhook_url = ?"
        ).run(CONTRACT_A, WEBHOOK_URL_A);

        const partial = testDb
          .prepare("SELECT COUNT(*) as cnt FROM webhook_subscriptions")
          .get() as { cnt: number };
        expect(partial.cnt).toBe(0);

        throw new Error("Simulated delete rollback");
      });

      expect(() => brokenTx()).toThrow("Simulated delete rollback");

      const countAfter = countSubscriptions();
      expect(countAfter).toBe(countBefore);

      const raw = getRawSubscription(CONTRACT_A, WEBHOOK_URL_A);
      expect(raw).toBeTruthy();
    });

    it("logs error and re-throws when removeSubscription transaction fails", () => {
      const db = getDb();
      addSubscription(CONTRACT_A, WEBHOOK_URL_A, ["funded"]);
      const countBefore = countSubscriptions();

      const errorSpy = jest
        .spyOn(logger, "error")
        .mockImplementation(() => logger);

      const originalPrepare = db.prepare.bind(db);
      (db as any).prepare = jest.fn(() => {
        throw new Error("Simulated DB prepare failure");
      });

      expect(() =>
        removeSubscription(CONTRACT_A, WEBHOOK_URL_A)
      ).toThrow("Simulated DB prepare failure");

      (db as any).prepare = originalPrepare;

      expect(errorSpy).toHaveBeenCalledWith(
        "removeSubscription failed – transaction rolled back",
        expect.objectContaining({
          contractId: CONTRACT_A,
          webhookUrl: WEBHOOK_URL_A,
          error: "Simulated DB prepare failure",
        })
      );

      const countAfter = countSubscriptions();
      expect(countAfter).toBe(countBefore);
    });
  });

  describe("Concurrent call isolation", () => {
    it("handles sequential addSubscription calls without data corruption", () => {
      const urls = Array.from(
        { length: 20 },
        (_, i) => `https://concurrent-${i}.example.com/hook`
      );

      for (let i = 0; i < urls.length; i++) {
        const types =
          i % 2 === 0 ? ["funded", "approved"] : ["delivered", "dispute_raised"];
        const sub = addSubscription(
          i < urls.length / 2 ? CONTRACT_A : CONTRACT_B,
          urls[i],
          types
        );
        expect(sub.id).toBeGreaterThan(i);
      }

      expect(countSubscriptions()).toBe(urls.length);

      const forA = getSubscriptionsForContract(CONTRACT_A);
      const forB = getSubscriptionsForContract(CONTRACT_B);
      expect(forA.length + forB.length).toBe(urls.length);

      const ids = [...forA, ...forB].map((s) => s.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(urls.length);
    });

    it("interleaved add and remove operations maintain consistent state", () => {
      const ops: Array<() => void> = [];

      for (let i = 0; i < 10; i++) {
        const url = `https://interleaved-${i}.example.com/hook`;
        ops.push(() => addSubscription(CONTRACT_A, url, ["funded"]));
      }

      for (let i = 0; i < 10; i += 2) {
        const url = `https://interleaved-${i}.example.com/hook`;
        ops.push(() => removeSubscription(CONTRACT_A, url));
      }

      for (const op of ops) {
        op();
      }

      const remaining = getSubscriptionsForContract(CONTRACT_A);
      expect(remaining).toHaveLength(5);

      for (const sub of remaining) {
        const index = parseInt(
          sub.webhook_url.match(/interleaved-(\d+)\.example/)![1],
          10
        );
        expect(index % 2).toBe(1);
      }
    });

    it("transaction rollback does not affect concurrent committed data", () => {
      const db = getDb();

      addSubscription(CONTRACT_B, WEBHOOK_URL_B, ["approved"]);
      expect(countSubscriptions()).toBe(1);

      const brokenTx = db.transaction(() => {
        db.prepare(
          `INSERT OR IGNORE INTO webhook_subscriptions
           (contract_id, webhook_url, event_types)
           VALUES (?, ?, ?)`
        ).run(CONTRACT_A, WEBHOOK_URL_A, JSON.stringify(["funded"]));
        throw new Error("Rollback this tx");
      });

      expect(() => brokenTx()).toThrow("Rollback this tx");

      expect(countSubscriptions()).toBe(1);

      const b = getRawSubscription(CONTRACT_B, WEBHOOK_URL_B);
      expect(b).toBeTruthy();
      expect(b!.event_types).toBe(JSON.stringify(["approved"]));

      const a = getRawSubscription(CONTRACT_A, WEBHOOK_URL_A);
      expect(a).toBeUndefined();
    });
  });

  describe("HTTP route handlers – transaction error propagation", () => {
    let app: express.Express;

    beforeAll(async () => {
      const { default: router } = await import("../src/routes/webhooks.js");
      app = express();
      app.use(express.json());
      app.use("/api/webhooks", router);
    });

    it("subscribe route returns 500 when addSubscription throws", async () => {
      const db = getDb();
      const errorSpy = jest
        .spyOn(logger, "error")
        .mockImplementation(() => logger);

      const countBefore = countSubscriptions();

      const originalPrepare = db.prepare.bind(db);
      (db as any).prepare = jest.fn(() => {
        throw new Error("Simulated route-level DB failure");
      });

      const res = await request(app)
        .post("/api/webhooks/subscribe")
        .send({
          contract_id: CONTRACT_A,
          webhook_url: WEBHOOK_URL_A,
          event_types: ["funded"],
        })
        .expect(500);

      (db as any).prepare = originalPrepare;

      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("Internal server error");

      const countAfter = countSubscriptions();
      expect(countAfter).toBe(countBefore);

      expect(errorSpy).toHaveBeenCalled();
    });

    it("unsubscribe route returns 500 when removeSubscription throws", async () => {
      const db = getDb();
      addSubscription(CONTRACT_A, WEBHOOK_URL_A, ["funded"]);
      const countBefore = countSubscriptions();

      const errorSpy = jest
        .spyOn(logger, "error")
        .mockImplementation(() => logger);

      const originalPrepare = db.prepare.bind(db);
      (db as any).prepare = jest.fn(() => {
        throw new Error("Simulated unsubscribe DB failure");
      });

      const res = await request(app)
        .post("/api/webhooks/unsubscribe")
        .send({
          contract_id: CONTRACT_A,
          webhook_url: WEBHOOK_URL_A,
        })
        .expect(500);

      (db as any).prepare = originalPrepare;

      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("Internal server error");

      const countAfter = countSubscriptions();
      expect(countAfter).toBe(countBefore);

      expect(errorSpy).toHaveBeenCalled();
    });
  });
});
