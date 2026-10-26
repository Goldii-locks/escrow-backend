import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import adminRoutes from "../src/routes/admin.js";
import {
  setDb,
  runMigrations,
  insertEvent,
  setLastIndexedLedger,
} from "../src/indexer/db.js";
import {
  INDEXER_METRICS_QUERIES,
  INDEXER_METRICS_INDEXES,
  explainIndexerMetricsQueryPlan,
  metricsQueryPlanUsesIndex,
  resetIndexerMetricsCollectorState,
} from "../src/indexer/indexer_metrics_collector.js";

const KEY = "test-admin-key";

function buildApp() {
  const app = express();
  app.use("/api/admin", adminRoutes);
  return app;
}

describe("GET /api/admin/metrics", () => {
  let testDb: Database.Database;
  const originalKey = process.env.ADMIN_API_KEY;
  const originalKeys = process.env.ADMIN_API_KEYS;

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
  });

  afterAll(() => {
    testDb.close();
    if (originalKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalKey;
    if (originalKeys === undefined) delete process.env.ADMIN_API_KEYS;
    else process.env.ADMIN_API_KEYS = originalKeys;
  });

  beforeEach(() => {
    process.env.ADMIN_API_KEY = KEY;
    delete process.env.ADMIN_API_KEYS;
    testDb.exec("DROP TABLE IF EXISTS events");
    testDb.exec("DROP TABLE IF EXISTS indexer_state");
    testDb.exec("DROP TABLE IF EXISTS monitored_contracts");
    testDb.exec("DROP TABLE IF EXISTS schema_migrations");
    testDb.exec("DROP TABLE IF EXISTS webhook_subscriptions");
    runMigrations();
    resetIndexerMetricsCollectorState();
  });

  describe("authorization", () => {
    it("returns 401 when no credentials are sent", async () => {
      const res = await request(buildApp()).get("/api/admin/metrics");
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ success: false, error: "Unauthorized" });
    });

    it("returns 401 for a wrong key", async () => {
      const res = await request(buildApp())
        .get("/api/admin/metrics")
        .set("x-api-key", "wrong-key");
      expect(res.status).toBe(401);
    });

    it("returns 401 when no admin key is configured", async () => {
      delete process.env.ADMIN_API_KEY;
      const res = await request(buildApp())
        .get("/api/admin/metrics")
        .set("x-api-key", KEY);
      expect(res.status).toBe(401);
    });
  });

  describe("with valid admin credentials", () => {
    it("returns the collector snapshot using x-api-key", async () => {
      setLastIndexedLedger(500);
      insertEvent("contract-1", "job_created", 100, 1600000000, JSON.stringify({ fee: 10 }));
      insertEvent("contract-1", "job_completed", 105, 1600000100, JSON.stringify({ fee: 10 }));

      const res = await request(buildApp())
        .get("/api/admin/metrics")
        .set("x-api-key", KEY);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.metrics.lastIndexedLedger).toBe(500);
      expect(res.body.metrics.totalEvents).toBe(2);
      expect(res.body.metrics.eventsByType).toEqual({
        job_created: 1,
        job_completed: 1,
      });
      expect(res.body.metrics).toHaveProperty("activeContractsCount");
      expect(res.body.metrics).toHaveProperty("totalSubscriptions");
      expect(res.body.metrics).toHaveProperty("collectedAt");
    });

    it("accepts a Bearer token", async () => {
      const res = await request(buildApp())
        .get("/api/admin/metrics")
        .set("Authorization", `Bearer ${KEY}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe("collector query plans", () => {
    it("events-by-type query uses idx_events_event_type", () => {
      const plan = explainIndexerMetricsQueryPlan(
        INDEXER_METRICS_QUERIES.eventsByType,
        testDb,
      );
      expect(
        metricsQueryPlanUsesIndex(plan, INDEXER_METRICS_INDEXES.eventsByType),
      ).toBe(true);
    });

    it("last-event query uses idx_events_created_at", () => {
      const plan = explainIndexerMetricsQueryPlan(
        INDEXER_METRICS_QUERIES.lastEventAt,
        testDb,
      );
      expect(
        metricsQueryPlanUsesIndex(plan, INDEXER_METRICS_INDEXES.lastEventAt),
      ).toBe(true);
    });

    it("active-contracts query uses idx_monitored_contracts_active", () => {
      const plan = explainIndexerMetricsQueryPlan(
        INDEXER_METRICS_QUERIES.activeContracts,
        testDb,
      );
      expect(
        metricsQueryPlanUsesIndex(plan, INDEXER_METRICS_INDEXES.activeContracts),
      ).toBe(true);
    });
  });
});