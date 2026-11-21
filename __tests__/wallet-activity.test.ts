import Database from "better-sqlite3";
import request from "supertest";
import express from "express";
import {
  initSchema,
  insertEvent,
  setDb,
  buildWalletActivityQuery,
  formatActivitySummary,
} from "../src/indexer/db.js";
import { EVENT_TYPES } from "../src/indexer/event_type_filter.js";
import walletRoutes from "../src/routes/wallets.js";
import { legacyApiDeprecation } from "../src/middleware/api-version.js";
import { resetByWalletRateLimitBuckets } from "../src/middleware/rateLimiter.js";
import logger from "../src/utils/logger.js";
import { jest } from "@jest/globals";

// Valid 56-char Stellar G-addresses for testing
const CLIENT_ADDR = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";
const FREELANCER_ADDR = "GB5CRPXUGXZCG6BESL4CM4F3VUAGQGFNYNBHPBRJAGLXXSRYJSEGZHUV";
const ARBITER_ADDR = "GABNCQRZNTG6MMITD33VHFITKJZ5PSYW2XVEXMP52BSMTPLU7WORDQNT";
const STRANGER_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CONTRACT_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

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
  resetByWalletRateLimitBuckets();
  testDb.exec("DELETE FROM events");
  testDb.exec("DELETE FROM job_participants");
});

describe("Wallet Activity Feed (GET /api/wallets/:address/activity)", () => {
  const app = express();
  app.use(express.json());
  app.use("/api", legacyApiDeprecation);
  app.use("/api/v1/wallets", walletRoutes);
  app.use("/api/wallets", walletRoutes);

  describe("1. Keyset pagination with since and limit", () => {
    beforeEach(() => {
      // Seed an init event to register participants
      insertEvent(
        CONTRACT_A,
        "init",
        100,
        1000,
        JSON.stringify({ client: CLIENT_ADDR, freelancer: FREELANCER_ADDR, arbiter: ARBITER_ADDR }),
        "evt-init",
        "tx-init",
      );

      // Seed 5 events from freelancer
      for (let i = 1; i <= 5; i++) {
        insertEvent(
          CONTRACT_A,
          "deliver",
          100 + i,
          1000 + i,
          JSON.stringify({ freelancer: FREELANCER_ADDR, milestone_index: i }),
          `evt-${i}`,
          `tx-${i}`,
        );
      }
    });

    it("orders results newest first (ORDER BY events.id DESC)", async () => {
      const res = await request(app)
        .get(`/api/wallets/${CLIENT_ADDR}/activity`)
        .expect(200);

      expect(res.body.success).toBe(true);
      const items = res.body.data.activity;
      expect(items.length).toBeGreaterThan(1);

      for (let i = 0; i < items.length - 1; i++) {
        expect(items[i].id).toBeGreaterThan(items[i + 1].id);
      }
    });

    it("returns events since a watermark (id > since) ordered newest first", async () => {
      // Fetch all to get known IDs
      const allRes = await request(app)
        .get(`/api/wallets/${CLIENT_ADDR}/activity`)
        .expect(200);
      const allItems = allRes.body.data.activity;
      const watermark = allItems[2].id; // 3rd newest

      const sinceRes = await request(app)
        .get(`/api/wallets/${CLIENT_ADDR}/activity`)
        .query({ since: watermark })
        .expect(200);

      const sinceItems = sinceRes.body.data.activity;
      expect(sinceItems.length).toBe(2);
      expect(sinceItems[0].id).toBe(allItems[0].id);
      expect(sinceItems[1].id).toBe(allItems[1].id);
      for (const item of sinceItems) {
        expect(item.id).toBeGreaterThan(watermark);
      }
    });

    it("returns an empty array when since is at or beyond latest event id", async () => {
      const allRes = await request(app)
        .get(`/api/wallets/${CLIENT_ADDR}/activity`)
        .expect(200);
      const latestId = allRes.body.data.activity[0].id;

      const res = await request(app)
        .get(`/api/wallets/${CLIENT_ADDR}/activity`)
        .query({ since: latestId })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.activity).toEqual([]);
    });

    it("respects limit parameter and defaults to 50", async () => {
      const resLimit = await request(app)
        .get(`/api/wallets/${CLIENT_ADDR}/activity`)
        .query({ limit: 2 })
        .expect(200);

      expect(resLimit.body.data.activity).toHaveLength(2);

      const resDefault = await request(app)
        .get(`/api/wallets/${CLIENT_ADDR}/activity`)
        .expect(200);

      expect(resDefault.body.data.activity.length).toBeLessThanOrEqual(50);
    });

    it("handles boundary between multiple contracts correctly", async () => {
      // Contract B with client
      insertEvent(
        CONTRACT_B,
        "init",
        200,
        2000,
        JSON.stringify({ client: CLIENT_ADDR, freelancer: STRANGER_ADDR }),
        "evt-b-init",
        "tx-b-init",
      );
      insertEvent(
        CONTRACT_B,
        "deliver",
        201,
        2001,
        JSON.stringify({ freelancer: STRANGER_ADDR, milestone_index: 0 }),
        "evt-b-1",
        "tx-b-1",
      );

      const res = await request(app)
        .get(`/api/wallets/${CLIENT_ADDR}/activity`)
        .expect(200);

      const contractIds = new Set(res.body.data.activity.map((item: any) => item.contractId));
      expect(contractIds.has(CONTRACT_A)).toBe(true);
      expect(contractIds.has(CONTRACT_B)).toBe(true);
    });
  });

  describe("2. Event summary and role mapping", () => {
    beforeEach(() => {
      insertEvent(
        CONTRACT_A,
        "init",
        10,
        1000,
        JSON.stringify({ client: CLIENT_ADDR, freelancer: FREELANCER_ADDR, arbiter: ARBITER_ADDR }),
        "evt-init",
        "tx-init",
      );
    });

    it("generates user-facing summaries with milestoneIndex", async () => {
      insertEvent(
        CONTRACT_A,
        "deliver",
        20,
        1020,
        JSON.stringify({ freelancer: FREELANCER_ADDR, milestone_index: 2 }),
        "evt-deliv",
        "tx-deliv",
      );
      insertEvent(
        CONTRACT_A,
        "approve",
        30,
        1030,
        JSON.stringify({ client: CLIENT_ADDR, milestone_index: 1 }),
        "evt-appr",
        "tx-appr",
      );
      insertEvent(
        CONTRACT_A,
        "dispute",
        40,
        1040,
        JSON.stringify({ caller: CLIENT_ADDR, milestone_index: 0 }),
        "evt-disp",
        "tx-disp",
      );
      insertEvent(
        CONTRACT_A,
        "claim",
        50,
        1050,
        JSON.stringify({ freelancer: FREELANCER_ADDR, milestone_index: 0 }),
        "evt-claim",
        "tx-claim",
      );

      // Query from freelancer perspective (so approve & dispute are not filtered as self-events)
      const resFreelancer = await request(app)
        .get(`/api/wallets/${FREELANCER_ADDR}/activity`)
        .expect(200);

      const activity = resFreelancer.body.data.activity;
      const apprItem = activity.find((a: any) => a.type === "approve");
      expect(apprItem).toBeDefined();
      expect(apprItem.summary).toBe("Milestone 1 approved");
      expect(apprItem.milestoneIndex).toBe(1);

      const dispItem = activity.find((a: any) => a.type === "dispute");
      expect(dispItem).toBeDefined();
      expect(dispItem.summary).toBe("Milestone 0 disputed");
      expect(dispItem.milestoneIndex).toBe(0);

      // Query from client perspective (so deliver & claim are not filtered as self-events)
      const resClient = await request(app)
        .get(`/api/wallets/${CLIENT_ADDR}/activity`)
        .expect(200);

      const clientActivity = resClient.body.data.activity;
      const delivItem = clientActivity.find((a: any) => a.type === "deliver");
      expect(delivItem).toBeDefined();
      expect(delivItem.summary).toBe("Milestone 2 marked delivered");
      expect(delivItem.milestoneIndex).toBe(2);

      const claimItem = clientActivity.find((a: any) => a.type === "claim");
      expect(claimItem).toBeDefined();
      expect(claimItem.summary).toBe("Milestone 0 claimed");
      expect(claimItem.milestoneIndex).toBe(0);
    });

    it("generates clean fallback summaries when milestoneIndex is omitted", async () => {
      insertEvent(
        CONTRACT_A,
        "deliver",
        21,
        1021,
        JSON.stringify({ freelancer: FREELANCER_ADDR }),
        "evt-deliv-fallback",
        "tx-deliv-fallback",
      );
      insertEvent(
        CONTRACT_A,
        "cancel",
        22,
        1022,
        JSON.stringify({ caller: ARBITER_ADDR }),
        "evt-cancel-fallback",
        "tx-cancel-fallback",
      );
      insertEvent(
        CONTRACT_A,
        "pause",
        23,
        1023,
        JSON.stringify({}),
        "evt-pause-fallback",
        "tx-pause-fallback",
      );

      const res = await request(app)
        .get(`/api/wallets/${CLIENT_ADDR}/activity`)
        .expect(200);

      const activity = res.body.data.activity;
      const delivItem = activity.find((a: any) => a.type === "deliver");
      expect(delivItem.summary).toBe("Milestone marked delivered");
      expect(delivItem.milestoneIndex).toBeUndefined();

      const cancelItem = activity.find((a: any) => a.type === "cancel");
      expect(cancelItem.summary).toBe("Contract cancelled");

      const pauseItem = activity.find((a: any) => a.type === "pause");
      expect(pauseItem.summary).toBe("Contract paused");
    });

    it("covers every contract event type in formatActivitySummary with and without milestoneIndex", () => {
      for (const eventType of EVENT_TYPES) {
        const withMilestone = formatActivitySummary(eventType, 2);
        const withoutMilestone = formatActivitySummary(eventType);

        expect(typeof withMilestone).toBe("string");
        expect(withMilestone.length).toBeGreaterThan(0);
        expect(typeof withoutMilestone).toBe("string");
        expect(withoutMilestone.length).toBeGreaterThan(0);
      }
    });

    it("maps actorRole accurately from job_participants relative to the contract", async () => {
      // Freelancer event
      insertEvent(
        CONTRACT_A,
        "deliver",
        20,
        1020,
        JSON.stringify({ freelancer: FREELANCER_ADDR, milestone_index: 0 }),
        "evt-deliv-role",
        "tx-deliv-role",
      );
      // Arbiter event
      insertEvent(
        CONTRACT_A,
        "resolve",
        25,
        1025,
        JSON.stringify({ arbiter: ARBITER_ADDR, milestone_index: 0 }),
        "evt-resolve-role",
        "tx-resolve-role",
      );
      // Non-participant actor event
      insertEvent(
        CONTRACT_A,
        "admin",
        26,
        1026,
        JSON.stringify({ actor: STRANGER_ADDR }),
        "evt-admin-role",
        "tx-admin-role",
      );
      // Event with no identifiable actor
      insertEvent(
        CONTRACT_A,
        "sweep",
        27,
        1027,
        JSON.stringify({ amount: "500" }),
        "evt-sweep-role",
        "tx-sweep-role",
      );

      const res = await request(app)
        .get(`/api/wallets/${CLIENT_ADDR}/activity`)
        .expect(200);

      const activity = res.body.data.activity;

      const deliv = activity.find((a: any) => a.type === "deliver");
      expect(deliv.actorRole).toBe("freelancer");

      const resolve = activity.find((a: any) => a.type === "resolve");
      expect(resolve.actorRole).toBe("arbiter");

      const admin = activity.find((a: any) => a.type === "admin");
      expect(admin.actorRole).toBeNull();

      const sweep = activity.find((a: any) => a.type === "sweep");
      expect(sweep.actorRole).toBeNull();
    });

    it("includes required response item fields (id, type, summary, contractId, ledger, timestamp, txHash)", async () => {
      insertEvent(
        CONTRACT_A,
        "deliver",
        20,
        1234567,
        JSON.stringify({ freelancer: FREELANCER_ADDR, milestone_index: 3 }),
        "evt-full-check",
        "tx-hash-12345",
      );

      const res = await request(app)
        .get(`/api/wallets/${CLIENT_ADDR}/activity`)
        .expect(200);

      const item = res.body.data.activity.find((a: any) => a.type === "deliver");
      expect(item).toMatchObject({
        type: "deliver",
        summary: "Milestone 3 marked delivered",
        contractId: CONTRACT_A,
        milestoneIndex: 3,
        ledger: 20,
        timestamp: 1234567,
        txHash: "tx-hash-12345",
        actorRole: "freelancer",
      });
      expect(typeof item.id).toBe("number");
    });
  });

  describe("3. Self-event exclusion", () => {
    beforeEach(() => {
      insertEvent(
        CONTRACT_A,
        "init",
        10,
        1000,
        JSON.stringify({ client: CLIENT_ADDR, freelancer: FREELANCER_ADDR, arbiter: ARBITER_ADDR }),
        "evt-init",
        "tx-init",
      );
    });

    it("omits events triggered by :address itself", async () => {
      // Client approves milestone
      insertEvent(
        CONTRACT_A,
        "approve",
        20,
        1020,
        JSON.stringify({ client: CLIENT_ADDR, approved_by: CLIENT_ADDR, milestone_index: 0 }),
        "evt-appr-self",
        "tx-appr-self",
      );
      // Freelancer delivers milestone
      insertEvent(
        CONTRACT_A,
        "deliver",
        21,
        1021,
        JSON.stringify({ freelancer: FREELANCER_ADDR, milestone_index: 0 }),
        "evt-deliv-counterparty",
        "tx-deliv-counterparty",
      );

      // Client queries: should NOT see approve (self-action), should see deliver
      const clientRes = await request(app)
        .get(`/api/wallets/${CLIENT_ADDR}/activity`)
        .expect(200);

      const clientTypes = clientRes.body.data.activity.map((a: any) => a.type);
      expect(clientTypes).not.toContain("approve");
      expect(clientTypes).toContain("deliver");

      // Freelancer queries: should NOT see deliver (self-action), should see approve
      const freelancerRes = await request(app)
        .get(`/api/wallets/${FREELANCER_ADDR}/activity`)
        .expect(200);

      const freelancerTypes = freelancerRes.body.data.activity.map((a: any) => a.type);
      expect(freelancerTypes).not.toContain("deliver");
      expect(freelancerTypes).toContain("approve");
    });

    it("includes events when event data does not identify an actor", async () => {
      // System event without actor field
      insertEvent(
        CONTRACT_A,
        "sweep",
        30,
        1030,
        JSON.stringify({ amount: "1000000" }),
        "evt-sweep",
        "tx-sweep",
      );

      const res = await request(app)
        .get(`/api/wallets/${CLIENT_ADDR}/activity`)
        .expect(200);

      const sweepItem = res.body.data.activity.find((a: any) => a.type === "sweep");
      expect(sweepItem).toBeDefined();
      expect(sweepItem.actorRole).toBeNull();
    });
  });

  describe("4. Query plan verification", () => {
    it("uses idx_job_participants_address and idx_events_contract_id with no full table scans", () => {
      const { query, params } = buildWalletActivityQuery(CLIENT_ADDR, { since: 5 });

      const plan = testDb
        .prepare(`EXPLAIN QUERY PLAN ${query}`)
        .all(...params) as Array<{ detail: string }>;

      const details = plan.map((p) => p.detail).join("\n");

      // Both indexes must be used
      expect(details).toContain("idx_job_participants_address");
      expect(details).toContain("idx_events_contract_id");

      // Must not perform full table scans
      expect(details).not.toContain("SCAN TABLE events");
      expect(details).not.toContain("SCAN events");
      expect(details).not.toContain("SCAN TABLE job_participants");
      expect(details).not.toContain("SCAN job_participants");
    });

    it("maintains indexed query plan when since is omitted", () => {
      const { query, params } = buildWalletActivityQuery(CLIENT_ADDR);

      const plan = testDb
        .prepare(`EXPLAIN QUERY PLAN ${query}`)
        .all(...params) as Array<{ detail: string }>;

      const details = plan.map((p) => p.detail).join("\n");

      expect(details).toContain("idx_job_participants_address");
      expect(details).toContain("idx_events_contract_id");
    });
  });

  describe("5. Rate limiting, validation & security", () => {
    it("returns 400 for invalid wallet address", async () => {
      const invalidAddresses = [
        "not-a-stellar-address",
        "G123",
        "CAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX", // Contract C-address, not G-address
        "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZR", // 55 chars
        "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRXX", // 57 chars
      ];

      for (const addr of invalidAddresses) {
        const res = await request(app)
          .get(`/api/wallets/${addr}/activity`)
          .expect(400);

        expect(res.body.success).toBe(false);
      }
    });

    it("returns 400 for invalid query parameters (since and limit)", async () => {
      // Invalid since
      for (const badSince of ["abc", "-5", "1.5"]) {
        const res = await request(app)
          .get(`/api/wallets/${CLIENT_ADDR}/activity`)
          .query({ since: badSince })
          .expect(400);

        expect(res.body.success).toBe(false);
      }

      // Invalid limit
      for (const badLimit of ["0", "-1", "101", "abc", "2.5"]) {
        const res = await request(app)
          .get(`/api/wallets/${CLIENT_ADDR}/activity`)
          .query({ limit: badLimit })
          .expect(400);

        expect(res.body.success).toBe(false);
      }
    });

    it("is publicly accessible without API keys or authentication", async () => {
      const res = await request(app)
        .get(`/api/wallets/${CLIENT_ADDR}/activity`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.activity)).toBe(true);
    });

    it("exposes rate-limit headers matching by-wallet config", async () => {
      const res = await request(app)
        .get(`/api/wallets/${CLIENT_ADDR}/activity`)
        .expect(200);

      expect(res.headers["x-ratelimit-limit"]).toBeDefined();
      expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
      expect(res.headers["x-ratelimit-reset"]).toBeDefined();
    });

    it("returns 429 when exceeding rate limit", async () => {
      // Max is 30 by default in test/config
      for (let i = 0; i < 30; i++) {
        await request(app).get(`/api/wallets/${CLIENT_ADDR}/activity`).expect(200);
      }

      const res429 = await request(app)
        .get(`/api/wallets/${CLIENT_ADDR}/activity`)
        .expect(429);

      expect(res429.body).toEqual({
        success: false,
        error: "Too many requests, please try again later",
      });
    });

    it("supports CORS and OPTIONS preflight requests", async () => {
      const resOptions = await request(app)
        .options(`/api/wallets/${CLIENT_ADDR}/activity`)
        .set("Origin", "http://localhost:3000")
        .expect(204);

      expect(resOptions.headers["access-control-allow-methods"]).toBeDefined();

      const resGet = await request(app)
        .get(`/api/wallets/${CLIENT_ADDR}/activity`)
        .set("Origin", "http://localhost:3000")
        .expect(200);

      expect(resGet.headers["x-content-type-options"]).toBe("nosniff");
      expect(resGet.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    });

    it("is accessible via both /api/wallets and /api/v1/wallets", async () => {
      const resV1 = await request(app)
        .get(`/api/v1/wallets/${CLIENT_ADDR}/activity`)
        .expect(200);

      const resLegacy = await request(app)
        .get(`/api/wallets/${CLIENT_ADDR}/activity`)
        .expect(200);

      expect(resV1.body.success).toBe(true);
      expect(resLegacy.body.success).toBe(true);
      expect(resLegacy.headers["deprecation"]).toBe("true");
    });

    it("never logs full wallet addresses in logger calls", async () => {
      const infoSpy = jest.spyOn(logger, "info");
      const warnSpy = jest.spyOn(logger, "warn");
      const debugSpy = jest.spyOn(logger, "debug");

      await request(app)
        .get(`/api/wallets/${CLIENT_ADDR}/activity`)
        .expect(200);

      const calls = [...infoSpy.mock.calls, ...warnSpy.mock.calls, ...debugSpy.mock.calls];
      const serialized = JSON.stringify(calls);

      expect(serialized).not.toContain(CLIENT_ADDR);

      infoSpy.mockRestore();
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    });
  });
});
