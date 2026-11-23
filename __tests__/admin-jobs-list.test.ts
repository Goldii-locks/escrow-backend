import Database from "better-sqlite3";
import request from "supertest";
import express from "express";
import { initSchema, setDb, insertEvent, registerContract, closeDb } from "../src/indexer/db.js";
import adminRoutes from "../src/routes/admin.js";

let testDb: Database.Database;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRoutes);
  return app;
}

const C1 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const C2 = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const C3 = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

beforeAll(() => {
  process.env.ADMIN_API_KEY = "test-admin-key";
  testDb = new Database(":memory:");
  setDb(testDb);
  initSchema();
});

afterAll(() => {
  closeDb();
  delete process.env.ADMIN_API_KEY;
});

beforeEach(() => {
  testDb.exec("DELETE FROM events");
  testDb.exec("DELETE FROM job_participants");
  testDb.exec("DELETE FROM monitored_contracts");
  registerContract(C1, "one");
  registerContract(C2, "two");
  registerContract(C3, "three");
});

describe("GET /api/admin/jobs (#961)", () => {
  it("requires admin auth", async () => {
    await request(buildApp()).get("/api/admin/jobs").expect(401);
  });

  it("filters by status and paginates stably with cursor", async () => {
    // C1 active (latest non-terminal, no open dispute)
    insertEvent(C1, "init", 10, 10, JSON.stringify({ client: "GC", freelancer: "GF", arbiter: "GA" }));
    insertEvent(C1, "fund", 20, 20, JSON.stringify({}));

    // C2 disputed (latest dispute open)
    insertEvent(C2, "init", 30, 30, JSON.stringify({ client: "GC", freelancer: "GF", arbiter: "GA" }));
    insertEvent(C2, "dispute", 40, 40, JSON.stringify({ milestone_index: 0 }));

    // C3 completed (latest terminal)
    insertEvent(C3, "init", 50, 50, JSON.stringify({ client: "GC", freelancer: "GF", arbiter: "GA" }));
    insertEvent(C3, "resolve", 60, 60, JSON.stringify({ milestone_index: 0 }));

    const app = buildApp();
    const auth = { "x-api-key": "test-admin-key" };

    const disputed = await request(app).get("/api/admin/jobs").set(auth).query({ status: "disputed" }).expect(200);
    expect(disputed.body.success).toBe(true);
    expect(disputed.body.data.jobs.map((j: any) => j.contractId)).toEqual([C2]);
    expect(disputed.body.data.jobs[0].hasOpenDispute).toBe(true);

    const completed = await request(app).get("/api/admin/jobs").set(auth).query({ status: "completed" }).expect(200);
    expect(completed.body.data.jobs.map((j: any) => j.contractId)).toEqual([C3]);

    const active = await request(app).get("/api/admin/jobs").set(auth).query({ status: "active" }).expect(200);
    expect(active.body.data.jobs.map((j: any) => j.contractId)).toEqual([C1]);

    const page1 = await request(app).get("/api/admin/jobs").set(auth).query({ limit: 2 }).expect(200);
    expect(page1.body.data.jobs).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();
    const firstIds = page1.body.data.jobs.map((j: any) => j.contractId);

    const page2 = await request(app).get("/api/admin/jobs").set(auth).query({ limit: 2, cursor: page1.body.nextCursor }).expect(200);
    expect(page2.body.data.jobs).toHaveLength(1);
    expect(firstIds).not.toContain(page2.body.data.jobs[0].contractId);
  });
});
