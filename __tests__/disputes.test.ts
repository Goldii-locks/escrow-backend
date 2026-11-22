import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import Database from "better-sqlite3";
import { server } from "../src/utils/soroban-call.js";

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.unstable_mockModule("../src/utils/logger.js", () => ({ default: mockLogger }));

const { setDb, initSchema, insertEvent, closeDb } = await import("../src/indexer/db.js");
const {
  default: disputeRoutes,
  resetDisputeStateCache,
} = await import("../src/routes/disputes.js");
const { resetJobContractRateLimitBuckets } = await import(
  "../src/middleware/job-contract-rate-limit.js"
);

const CONTRACT_ID = "CARZQMYKDGA4TTIE2XBDJ42EX27VYLLJGGG4WGUIXXWIVHPDTX3UCLJA";
const DISPUTE_ID = `${CONTRACT_ID}:0`;
const CLIENT = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";
const FREELANCER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const ARBITER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

let testDb: Database.Database;

function buildApp() {
  const app = express();
  app.use("/api/disputes", disputeRoutes);
  return app;
}

describe("Disputes API (#919)", () => {
  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
    initSchema();
  });

  afterAll(() => {
    closeDb();
  });

  beforeEach(() => {
    testDb.exec("DELETE FROM events");
    jest.clearAllMocks();
    resetDisputeStateCache();
    resetJobContractRateLimitBuckets();
  });

  describe("Validation & 404 checks", () => {
    it("returns HTTP 400 for invalid dispute ID format", async () => {
      const app = buildApp();
      const res = await request(app).get("/api/disputes/invalid_id").expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/Invalid dispute ID format/);
    });

    it("returns HTTP 400 for non-numeric milestone index", async () => {
      const app = buildApp();
      const res = await request(app).get(`/api/disputes/${CONTRACT_ID}:abc`).expect(400);
      expect(res.body.success).toBe(false);
    });

    it("returns HTTP 404 when milestone has never been disputed (history endpoint)", async () => {
      const app = buildApp();
      const res = await request(app).get(`/api/disputes/${DISPUTE_ID}/history`).expect(404);
      expect(res.body.success).toBe(false);
    });

    it("returns HTTP 404 when milestone has never been disputed (evidence endpoint)", async () => {
      const app = buildApp();
      const res = await request(app).get(`/api/disputes/${DISPUTE_ID}/evidence`).expect(404);
      expect(res.body.success).toBe(false);
    });

    it("returns HTTP 404 when get_dispute_info simulation fails and no DB events exist", async () => {
      const app = buildApp();
      jest.spyOn(server, "simulateTransaction").mockResolvedValueOnce({
        error: "Contract not found (status 404)",
      } as never);

      const res = await request(app).get(`/api/disputes/${DISPUTE_ID}`).expect(404);
      expect(res.body.success).toBe(false);
    });
  });

  describe("GET /api/disputes/:disputeId", () => {
    it("retrieves dispute state and includes milestone and party addresses", async () => {
      const app = buildApp();

      // Seed an init event in DB to supply party addresses
      insertEvent(
        CONTRACT_ID,
        "init",
        100,
        1700000000,
        JSON.stringify({ client: CLIENT, freelancer: FREELANCER, arbiter: ARBITER }),
      );

      // Seed dispute event in DB
      insertEvent(
        CONTRACT_ID,
        "dispute",
        110,
        1700000100,
        JSON.stringify({ milestone_index: 0, caller: CLIENT }),
      );

      // Mock simulateTransaction for get_dispute_info
      jest.spyOn(server, "simulateTransaction").mockResolvedValueOnce({
        result: {
          retval: {
            // Simulated ScVal decoded by scValToNative
            status: "Open",
            initiator: CLIENT,
          },
        },
      } as never);

      const res = await request(app).get(`/api/disputes/${DISPUTE_ID}`).expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.disputeId).toBe(DISPUTE_ID);
      expect(res.body.data.contractId).toBe(CONTRACT_ID);
      expect(res.body.data.milestoneIndex).toBe(0);
      expect(res.body.data.client).toBe(CLIENT);
      expect(res.body.data.freelancer).toBe(FREELANCER);
      expect(res.body.data.arbiter).toBe(ARBITER);
      expect(res.body.data.parties).toEqual({
        client: CLIENT,
        freelancer: FREELANCER,
        arbiter: ARBITER,
      });

      // Verify address masking in info log
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Dispute fetched successfully",
        expect.objectContaining({
          disputeId: DISPUTE_ID,
          client: expect.stringMatching(/GAOD…VZRX/),
          freelancer: expect.stringMatching(/GBRP…OX2H/),
          arbiter: expect.stringMatching(/GAAZ…CWN7/),
        }),
      );
    });
  });

  describe("GET /api/disputes/:disputeId/history", () => {
    it("retrieves chronological timeline filtered by milestone_index", async () => {
      const app = buildApp();

      // Insert events in non-sorted order or chronological
      insertEvent(
        CONTRACT_ID,
        "dispute",
        100,
        1700000000,
        JSON.stringify({ milestone_index: 0, caller: CLIENT }),
        "ev-1",
        "tx-hash-1",
      );

      insertEvent(
        CONTRACT_ID,
        "evidence",
        105,
        1700000050,
        JSON.stringify({ milestone_index: 0, submitter: FREELANCER, evidence_hash: "hash123" }),
        "ev-2",
        "tx-hash-2",
      );

      // Event for a DIFFERENT milestone – must be excluded
      insertEvent(
        CONTRACT_ID,
        "dispute",
        107,
        1700000070,
        JSON.stringify({ milestone_index: 1, caller: CLIENT }),
        "ev-3",
        "tx-hash-3",
      );

      insertEvent(
        CONTRACT_ID,
        "dispescal",
        110,
        1700000100,
        JSON.stringify({ milestone_index: 0, caller: FREELANCER }),
        "ev-4",
        "tx-hash-4",
      );

      insertEvent(
        CONTRACT_ID,
        "resolve",
        120,
        1700000200,
        JSON.stringify({ milestone_index: 0, arbiter: ARBITER }),
        "ev-5",
        "tx-hash-5",
      );

      const res = await request(app).get(`/api/disputes/${DISPUTE_ID}/history`).expect(200);

      expect(res.body.success).toBe(true);
      const timeline = res.body.data;
      expect(timeline).toHaveLength(4);

      expect(timeline[0]).toEqual({
        type: "raised",
        actor: CLIENT,
        timestamp: 1700000000,
        ledger: 100,
        txHash: "tx-hash-1",
      });

      expect(timeline[1]).toEqual({
        type: "evidence_submitted",
        actor: FREELANCER,
        timestamp: 1700000050,
        ledger: 105,
        txHash: "tx-hash-2",
      });

      expect(timeline[2]).toEqual({
        type: "escalated",
        actor: FREELANCER,
        timestamp: 1700000100,
        ledger: 110,
        txHash: "tx-hash-4",
      });

      expect(timeline[3]).toEqual({
        type: "resolved",
        actor: ARBITER,
        timestamp: 1700000200,
        ledger: 120,
        txHash: "tx-hash-5",
      });
    });
  });

  describe("GET /api/disputes/:disputeId/evidence", () => {
    it("returns evidence events only with evidenceHash and submitter", async () => {
      const app = buildApp();

      insertEvent(
        CONTRACT_ID,
        "dispute",
        100,
        1700000000,
        JSON.stringify({ milestone_index: 0, caller: CLIENT }),
      );

      insertEvent(
        CONTRACT_ID,
        "evidence",
        105,
        1700000050,
        JSON.stringify({
          milestone_index: 0,
          submitter: CLIENT,
          evidence_hash: "hash-client-doc",
        }),
        "ev-1",
        "tx-1",
      );

      insertEvent(
        CONTRACT_ID,
        "evidence",
        110,
        1700000100,
        JSON.stringify({
          milestone_index: 0,
          submitter: FREELANCER,
          evidence_hash: "hash-freelancer-work",
        }),
        "ev-2",
        "tx-2",
      );

      const res = await request(app).get(`/api/disputes/${DISPUTE_ID}/evidence`).expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);

      expect(res.body.data[0]).toEqual(
        expect.objectContaining({
          evidenceHash: "hash-client-doc",
          submitter: CLIENT,
          timestamp: 1700000050,
          ledger: 105,
          txHash: "tx-1",
        }),
      );

      expect(res.body.data[1]).toEqual(
        expect.objectContaining({
          evidenceHash: "hash-freelancer-work",
          submitter: FREELANCER,
          timestamp: 1700000100,
          ledger: 110,
          txHash: "tx-2",
        }),
      );
    });

    it("returns empty array if milestone was disputed but no evidence submitted yet", async () => {
      const app = buildApp();

      insertEvent(
        CONTRACT_ID,
        "dispute",
        100,
        1700000000,
        JSON.stringify({ milestone_index: 0, caller: CLIENT }),
      );

      const res = await request(app).get(`/api/disputes/${DISPUTE_ID}/evidence`).expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });
  });

  describe("Security headers and CORS", () => {
    it("sets security headers on dispute responses", async () => {
      const app = buildApp();
      insertEvent(
        CONTRACT_ID,
        "dispute",
        100,
        1700000000,
        JSON.stringify({ milestone_index: 0 }),
      );

      const res = await request(app).get(`/api/disputes/${DISPUTE_ID}/history`).expect(200);

      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
    });

    it("handles CORS preflight OPTIONS", async () => {
      const app = buildApp();
      const res = await request(app)
        .options(`/api/disputes/${DISPUTE_ID}`)
        .set("Origin", "http://localhost:3000")
        .expect(200);

      expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    });
  });
});
