import Database from "better-sqlite3";
import request from "supertest";
import express from "express";
import { initSchema, setDb, insertEvent, closeDb, resetPlatformStatsCache } from "../src/indexer/db.js";
import statsRoutes from "../src/routes/stats.js";

let testDb: Database.Database;

function buildApp() {
  const app = express();
  app.use("/api/stats", statsRoutes);
  return app;
}

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
  testDb.exec("DELETE FROM job_participants");
  testDb.exec("DELETE FROM monitored_contracts");
  resetPlatformStatsCache();
});

describe("GET /api/stats (#960)", () => {
  it("returns aggregate stats across multiple tokens and dispute states", async () => {
    const c1 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
    const c2 = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const t1 = "CTOKEN11111111111111111111111111111111111111111111111111";
    const t2 = "CTOKEN22222222222222222222222222222222222222222222222222";

    insertEvent(c1, "created", 1, 1, JSON.stringify({}));
    insertEvent(c2, "created", 2, 2, JSON.stringify({}));
    insertEvent(c1, "init", 3, 3, JSON.stringify({ token: t1 }));
    insertEvent(c2, "init", 4, 4, JSON.stringify({ token: t2 }));
    insertEvent(c1, "fund", 5, 5, JSON.stringify({ token: t1, amount: "100" }));
    insertEvent(c1, "msfund", 6, 6, JSON.stringify({ token: t1, amount: "50" }));
    insertEvent(c2, "fund", 7, 7, JSON.stringify({ token: t2, amount: "200" }));
    insertEvent(c1, "approve", 8, 8, JSON.stringify({ token: t1, amount: "30" }));
    insertEvent(c2, "claim", 9, 9, JSON.stringify({ token: t2, amount: "70" }));

    // open dispute on c1 milestone 0
    insertEvent(c1, "dispute", 10, 10, JSON.stringify({ milestone_index: 0 }));
    // resolved dispute on c2 milestone 0
    insertEvent(c2, "dispute", 11, 11, JSON.stringify({ milestone_index: 0 }));
    insertEvent(c2, "resolve", 12, 12, JSON.stringify({ milestone_index: 0 }));

    const res = await request(buildApp()).get("/api/stats").expect(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    expect(res.body.success).toBe(true);
    expect(res.body.data.escrows).toBe(2);
    expect(res.body.data.funded[t1]).toBe("150");
    expect(res.body.data.funded[t2]).toBe("200");
    expect(res.body.data.released[t1]).toBe("30");
    expect(res.body.data.released[t2]).toBe("70");
    expect(res.body.data.openDisputes).toBe(1);
    expect(typeof res.body.data.updatedAt).toBe("string");
  });
});
