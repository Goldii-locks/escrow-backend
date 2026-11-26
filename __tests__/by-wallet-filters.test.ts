import Database from "better-sqlite3";
import request from "supertest";
import express from "express";
import {
  initSchema,
  insertEvent,
  setDb,
  getJobsByWallet,
  resetJobsByWalletCache,
  buildWalletJobsQuery,
  TERMINAL_JOB_EVENT_TYPES,
} from "../src/indexer/db.js";
import jobRoutes from "../src/routes/jobs.js";
import { resetByWalletRateLimitBuckets } from "../src/middleware/rateLimiter.js";

const WALLET = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";
const OTHER = "GBODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";
const ARBITER = "GCODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";
const TERMINAL = "resolve";

let testDb: Database.Database;

function seed(contractId: string, eventType: string, ledger: number, data: object) {
  insertEvent(contractId, eventType, ledger, ledger, JSON.stringify(data));
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", jobRoutes);
  return app;
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
  resetByWalletRateLimitBuckets();
  testDb.exec("DELETE FROM events");
  testDb.exec("DELETE FROM job_participants");
  testDb.exec("DELETE FROM job_summary");
  resetJobsByWalletCache();
});

describe("by-wallet role/state filters (#958)", () => {
  beforeEach(() => {
    // A: WALLET is client, open (latest init)
    seed("CA", "init", 100, { client: WALLET, freelancer: OTHER, arbiter: ARBITER });
    // B: WALLET is freelancer, closed (latest terminal)
    seed("CB", "init", 200, { client: OTHER, freelancer: WALLET, arbiter: ARBITER });
    seed("CB", TERMINAL, 300, { result: "ok" });
    // C: WALLET is arbiter, open (latest non-terminal)
    seed("CC", "init", 400, { client: OTHER, freelancer: OTHER, arbiter: WALLET });
    seed("CC", "fund", 500, { amount: "1" });
  });

  it("filters by each role", async () => {
    expect((await getJobsByWallet(WALLET, 1, 10, { role: "client" })).jobs.map((j) => j.contract_id)).toEqual(["CA"]);
    expect((await getJobsByWallet(WALLET, 1, 10, { role: "freelancer" })).jobs.map((j) => j.contract_id)).toEqual(["CB"]);
    expect((await getJobsByWallet(WALLET, 1, 10, { role: "arbiter" })).jobs.map((j) => j.contract_id)).toEqual(["CC"]);
  });

  it("filters by each state", async () => {
    const open = await getJobsByWallet(WALLET, 1, 10, { state: "open" });
    const closed = await getJobsByWallet(WALLET, 1, 10, { state: "closed" });
    expect(open.total).toBe(2);
    expect(open.jobs.map((j) => j.contract_id).sort()).toEqual(["CA", "CC"]);
    expect(closed.total).toBe(1);
    expect(closed.jobs[0].contract_id).toBe("CB");
  });

  it("applies combinations with paging and reports the filtered total", async () => {
    // extra open client job to exercise paging
    seed("CD", "init", 600, { client: WALLET, freelancer: OTHER, arbiter: ARBITER });
    resetJobsByWalletCache();

    const page1 = await getJobsByWallet(WALLET, 1, 1, { role: "client", state: "open" });
    const page2 = await getJobsByWallet(WALLET, 2, 1, { role: "client", state: "open" });
    expect(page1.total).toBe(2);
    expect(page1.jobs).toHaveLength(1);
    expect(page2.total).toBe(2);
    expect(page2.jobs).toHaveLength(1);
    expect(page1.jobs[0].contract_id).not.toBe(page2.jobs[0].contract_id);

    const none = await getJobsByWallet(WALLET, 1, 10, { role: "client", state: "closed" });
    expect(none.total).toBe(0);
  });

  it("keeps results distinct per filter in the cache", async () => {
    const all = await getJobsByWallet(WALLET, 1, 10);
    const onlyClient = await getJobsByWallet(WALLET, 1, 10, { role: "client" });
    expect(all.total).toBe(3);
    expect(onlyClient.total).toBe(1);
  });

  it("keeps idx_job_participants_address in the query plan", () => {
    const { ctes, params } = buildWalletJobsQuery(WALLET, { role: "client", state: "open" });
    const plan = testDb
      .prepare(`EXPLAIN QUERY PLAN ${ctes} SELECT COUNT(*) AS cnt FROM filtered_contracts`)
      .all(...params) as Array<{ detail: string }>;
    const details = plan.map((r) => r.detail).join("\n");
    expect(details).toContain("idx_job_participants_address");
  });

  it("treats the documented terminal set as closed", () => {
    expect(TERMINAL_JOB_EVENT_TYPES).toContain("resolve");
    expect(TERMINAL_JOB_EVENT_TYPES).toContain("withdraw");
  });
});

describe("GET /api/jobs/by-wallet/:address filters (#958)", () => {
  beforeEach(() => {
    seed("CA", "init", 100, { client: WALLET, freelancer: OTHER, arbiter: ARBITER });
    seed("CB", "init", 200, { client: OTHER, freelancer: WALLET, arbiter: ARBITER });
    seed("CB", TERMINAL, 300, { result: "ok" });
  });

  it("honors role and state query params", async () => {
    const app = buildApp();
    const res = await request(app)
      .get(`/api/jobs/by-wallet/${WALLET}`)
      .query({ role: "freelancer", state: "closed" })
      .expect(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.jobs[0].contract_id).toBe("CB");
  });

  it("rejects an invalid role/state", async () => {
    const app = buildApp();
    await request(app).get(`/api/jobs/by-wallet/${WALLET}`).query({ role: "nope" }).expect(400);
    await request(app).get(`/api/jobs/by-wallet/${WALLET}`).query({ state: "nope" }).expect(400);
  });
});
