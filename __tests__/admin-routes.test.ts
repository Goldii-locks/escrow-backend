import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";

type RangeValidation = { valid: boolean; error?: string };
type ImportResult = { eventsFound: number; eventsImported: number };
type Progress = Partial<ImportResult>;

let latestLedgerImpl: () => Promise<number> = async () => 1000;
let validateRangeImpl: (start: number, end: number, head: number) => RangeValidation =
  () => ({ valid: true });
let fetchImpl: (
  start: number,
  end: number,
  contractId: string | undefined,
  onProgress: (progress: Progress) => void
) => Promise<ImportResult> = async () => ({ eventsFound: 2, eventsImported: 2 });
let collectMetricsImpl: () => unknown = () => ({
  totalEvents: 0,
  collectedAt: "2026-01-01T00:00:00.000Z",
});

jest.unstable_mockModule("../src/indexer/poller.js", () => ({
  getConsecutiveFailures: () => 0,
  getCurrentPollIntervalMs: () => 15000,
  getLastSuccessfulPollAt: () => Date.now(),
  getLatestLedgerSequence: () => latestLedgerImpl(),
  validateHistoricalRange: (start: number, end: number, head: number) =>
    validateRangeImpl(start, end, head),
  fetchHistoricalEvents: (
    start: number,
    end: number,
    contractId: string | undefined,
    onProgress: (progress: Progress) => void
  ) => fetchImpl(start, end, contractId, onProgress),
  simulatePollFailure: () => {},
}));

jest.unstable_mockModule("../src/indexer/indexer_metrics_collector.js", () => ({
  collectIndexerMetrics: () => collectMetricsImpl(),
}));

const KEY = "admin-routes-test-key";
const CONTRACT = "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("admin routes – backfill lifecycle, contracts and failure paths (#948)", () => {
  let app: express.Express;
  let testDb: Database.Database;
  const originalKey = process.env.ADMIN_API_KEY;

  beforeAll(async () => {
    process.env.ADMIN_API_KEY = KEY;
    testDb = new Database(":memory:");
    const { setDb, runMigrations } = await import("../src/indexer/db.js");
    setDb(testDb);
    runMigrations();
    const { default: adminRoutes } = await import("../src/routes/admin.js");
    app = express();
    app.use(express.json());
    app.use("/api/admin", adminRoutes);
  });

  afterAll(() => {
    testDb.close();
    if (originalKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalKey;
  });

  beforeEach(() => {
    latestLedgerImpl = async () => 1000;
    validateRangeImpl = () => ({ valid: true });
    fetchImpl = async () => ({ eventsFound: 2, eventsImported: 2 });
    collectMetricsImpl = () => ({ totalEvents: 0, collectedAt: "now" });
    testDb.exec("DELETE FROM events");
    testDb.exec("DELETE FROM monitored_contracts");
    testDb.exec("DELETE FROM indexer_state");
  });

  describe("POST /api/admin/backfill", () => {
    it("returns 409 while a backfill is already running", async () => {
      let release!: () => void;
      fetchImpl = async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { eventsFound: 1, eventsImported: 1 };
      };

      await request(app)
        .post("/api/admin/backfill")
        .set("x-api-key", KEY)
        .send({ startLedger: 100, endLedger: 200 })
        .expect(202);

      const conflict = await request(app)
        .post("/api/admin/backfill")
        .set("x-api-key", KEY)
        .send({ startLedger: 100, endLedger: 200 })
        .expect(409);
      expect(conflict.body.success).toBe(false);
      expect(conflict.body.error).toMatch(/already running/i);

      release();
      await tick();
      await tick();
      const done = await request(app)
        .get("/api/admin/backfill")
        .set("x-api-key", KEY)
        .expect(200);
      expect(done.body.data.status).toBe("done");
    });

    it("returns 503 when the chain-head RPC call fails", async () => {
      latestLedgerImpl = async () => {
        throw new Error("rpc unavailable");
      };
      const res = await request(app)
        .post("/api/admin/backfill")
        .set("x-api-key", KEY)
        .send({ startLedger: 100, endLedger: 200 })
        .expect(503);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/Unable to validate backfill range/i);
    });

    it("returns 400 for an invalid ledger range", async () => {
      validateRangeImpl = () => ({ valid: false, error: "bad range" });
      const res = await request(app)
        .post("/api/admin/backfill")
        .set("x-api-key", KEY)
        .send({ startLedger: 900, endLedger: 100 })
        .expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("bad range");
    });

    it("reports progress updates and a final done status", async () => {
      fetchImpl = async (_start, _end, _contractId, onProgress) => {
        onProgress({ eventsFound: 2, eventsImported: 1 });
        return { eventsFound: 5, eventsImported: 5 };
      };

      await request(app)
        .post("/api/admin/backfill")
        .set("x-api-key", KEY)
        .send({ startLedger: 100, endLedger: 200, contractId: CONTRACT })
        .expect(202);

      const res = await request(app)
        .get("/api/admin/backfill")
        .set("x-api-key", KEY)
        .expect(200);
      expect(res.body.data.status).toBe("done");
      expect(res.body.data.eventsFound).toBe(5);
      expect(res.body.data.eventsImported).toBe(5);
    });

    it("reports a failed status when the import rejects", async () => {
      fetchImpl = async () => {
        throw new Error("import exploded");
      };

      await request(app)
        .post("/api/admin/backfill")
        .set("x-api-key", KEY)
        .send({ startLedger: 100, endLedger: 200 })
        .expect(202);
      await tick();

      const res = await request(app)
        .get("/api/admin/backfill")
        .set("x-api-key", KEY)
        .expect(200);
      expect(res.body.data.status).toBe("failed");
    });

    it("rejects non-integer ledger bounds", async () => {
      const res = await request(app)
        .post("/api/admin/backfill")
        .set("x-api-key", KEY)
        .send({ startLedger: "100", endLedger: 200 })
        .expect(400);
      expect(res.body.success).toBe(false);
    });

    it("rejects a contractId that is not a valid C... address", async () => {
      const res = await request(app)
        .post("/api/admin/backfill")
        .set("x-api-key", KEY)
        .send({ startLedger: 100, endLedger: 200, contractId: "abc" })
        .expect(400);
      expect(res.body.success).toBe(false);
    });

    it("rejects a negative startLedger", async () => {
      const res = await request(app)
        .post("/api/admin/backfill")
        .set("x-api-key", KEY)
        .send({ startLedger: -1, endLedger: 200 })
        .expect(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe("POST/DELETE /api/admin/contracts", () => {
    it("registers a contract with a startLedger and deregisters it", async () => {
      const created = await request(app)
        .post("/api/admin/contracts")
        .set("x-api-key", KEY)
        .send({ contractId: CONTRACT, label: "with start", startLedger: 12345 })
        .expect(201);
      expect(created.body.contract.startLedger).toBe(12345);
      expect(created.body.contract.active).toBe(true);

      const listed = await request(app)
        .get("/api/admin/contracts")
        .set("x-api-key", KEY)
        .expect(200);
      const found = listed.body.contracts.find(
        (c: { contractId: string }) => c.contractId === CONTRACT
      );
      expect(found.startLedger).toBe(12345);

      const removed = await request(app)
        .delete(`/api/admin/contracts/${CONTRACT}`)
        .set("x-api-key", KEY)
        .expect(200);
      expect(removed.body.contractId).toBe(CONTRACT);
    });
  });

  describe("GET /api/admin/indexer-status", () => {
    it("reports ledgerLag as null when the chain-head RPC fails", async () => {
      latestLedgerImpl = async () => {
        throw new Error("rpc unavailable");
      };
      const res = await request(app)
        .get("/api/admin/indexer-status")
        .set("x-api-key", KEY)
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.ledgerLag).toBeNull();
    });
  });

  describe("GET /api/admin/metrics", () => {
    it("returns 500 when metric collection throws", async () => {
      collectMetricsImpl = () => {
        throw new Error("collector exploded");
      };
      const res = await request(app)
        .get("/api/admin/metrics")
        .set("x-api-key", KEY)
        .expect(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/Failed to collect indexer metrics/i);
    });
  });
});
