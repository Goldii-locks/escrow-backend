import Database from "better-sqlite3";
import {
  initSchema,
  insertEvent,
  setDb,
  getDb,
  getJobsByWallet,
  resetJobsByWalletCache,
  backfillJobSummary,
  getJobSummary,
} from "../src/indexer/db.js";
import { jobStateCache, resetJobStateCache } from "../src/indexer/job-state-cache.js";
import { resetByWalletRateLimitBuckets } from "../src/middleware/rateLimiter.js";

describe("milestone_count amendments and missing init handling (#889)", () => {
  let testDb: Database.Database;

  const CLIENT = "GCLIENT1111111111111111111111111111111111111111111111111111";
  const FREELANCER = "GFREELANCER22222222222222222222222222222222222222222222222222";
  const ARBITER = "GARBITER3333333333333333333333333333333333333333333333333333";

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
    resetJobStateCache();
    testDb.exec("DELETE FROM events");
    testDb.exec("DELETE FROM job_participants");
    testDb.exec("DELETE FROM job_summary");
    resetJobsByWalletCache();
  });

  it("core acceptance criterion: init with 2 milestones, then add_milestone reports milestone_count = 3", async () => {
    const contractId = "C-AMEND-1";

    // 1. Initialize job with 2 milestones
    insertEvent(
      contractId,
      "init",
      100,
      1000,
      JSON.stringify({
        client: CLIENT,
        freelancer: FREELANCER,
        arbiter: ARBITER,
        milestone_count: 2,
      }),
    );

    const initial = await getJobsByWallet(CLIENT);
    expect(initial.total).toBe(1);
    expect(initial.jobs[0].contract_id).toBe(contractId);
    expect(initial.jobs[0].milestone_count).toBe(2);

    // 2. Ingest add_milestone event
    insertEvent(
      contractId,
      "add_milestone",
      101,
      1010,
      JSON.stringify({
        amount: "1000",
      }),
    );

    // 3. Verify getJobsByWallet reports milestone_count = 3
    const amended = await getJobsByWallet(CLIENT);
    expect(amended.total).toBe(1);
    expect(amended.jobs[0].contract_id).toBe(contractId);
    expect(amended.jobs[0].milestone_count).toBe(3);
  });

  it("supports ms_add topic and explicit milestone_count in payload", async () => {
    const contractId = "C-MS-ADD-1";

    insertEvent(
      contractId,
      "init",
      100,
      1000,
      JSON.stringify({
        client: CLIENT,
        freelancer: FREELANCER,
        milestones: [{ amount: "500" }, { amount: "500" }],
      }),
    );

    insertEvent(
      contractId,
      "ms_add",
      105,
      1050,
      JSON.stringify({
        client: CLIENT,
        freelancer: FREELANCER,
        milestone_index: 2,
        amount: "500",
        milestone_count: 3,
      }),
    );

    const result = await getJobsByWallet(CLIENT);
    expect(result.total).toBe(1);
    expect(result.jobs[0].milestone_count).toBe(3);
  });

  it("reduce_milestone decrements the count accurately", async () => {
    const contractId = "C-REDUCE-1";

    // Initialize with 3 milestones
    insertEvent(
      contractId,
      "init",
      100,
      1000,
      JSON.stringify({
        client: CLIENT,
        freelancer: FREELANCER,
        arbiter: ARBITER,
        milestone_count: 3,
      }),
    );

    expect((await getJobsByWallet(CLIENT)).jobs[0].milestone_count).toBe(3);

    // Reduce milestone (single milestone reduction)
    insertEvent(
      contractId,
      "reduce_milestone",
      102,
      1020,
      JSON.stringify({
        milestone_index: 2,
      }),
    );

    expect((await getJobsByWallet(CLIENT)).jobs[0].milestone_count).toBe(2);

    // Reduce again via ms_reduce
    insertEvent(
      contractId,
      "ms_reduce",
      103,
      1030,
      JSON.stringify({
        client: CLIENT,
        freelancer: FREELANCER,
        milestone_count: 1,
      }),
    );

    expect((await getJobsByWallet(CLIENT)).jobs[0].milestone_count).toBe(1);
  });

  it("bounds safety: guard against negative counts on multiple reduce_milestone events", async () => {
    const contractId = "C-BOUNDS-1";

    insertEvent(
      contractId,
      "init",
      100,
      1000,
      JSON.stringify({
        client: CLIENT,
        freelancer: FREELANCER,
        milestone_count: 1,
      }),
    );

    // First reduction -> 0
    insertEvent(contractId, "reduce_milestone", 101, 1010, JSON.stringify({}));
    expect((await getJobsByWallet(CLIENT)).jobs[0].milestone_count).toBe(0);

    // Subsequent reduction -> still 0, never negative
    insertEvent(contractId, "reduce_milestone", 102, 1020, JSON.stringify({}));
    expect((await getJobsByWallet(CLIENT)).jobs[0].milestone_count).toBe(0);
  });

  it("idempotency: re-ingesting the exact same event does not alter the count twice", async () => {
    const contractId = "C-IDEMPOTENT-1";

    insertEvent(
      contractId,
      "init",
      100,
      1000,
      JSON.stringify({
        client: CLIENT,
        freelancer: FREELANCER,
        milestone_count: 2,
      }),
    );

    // Ingest add_milestone
    const firstInsert = insertEvent(
      contractId,
      "add_milestone",
      101,
      1010,
      JSON.stringify({ amount: "100" }),
      "evt-add-1",
    );
    expect(firstInsert).toBe(true);

    const afterFirst = await getJobsByWallet(CLIENT);
    expect(afterFirst.jobs[0].milestone_count).toBe(3);

    // Re-ingest duplicate event (same event identity)
    const duplicateInsert = insertEvent(
      contractId,
      "add_milestone",
      101,
      1010,
      JSON.stringify({ amount: "100" }),
      "evt-add-1",
    );
    expect(duplicateInsert).toBe(false);

    // Verify milestone_count remains 3 (not 4)
    resetJobsByWalletCache();
    const afterDuplicate = await getJobsByWallet(CLIENT);
    expect(afterDuplicate.jobs[0].milestone_count).toBe(3);
  });

  it("handles missing init event when get_job snapshot exists in jobStateCache", async () => {
    const contractId = "C-NO-INIT-1";

    // Contract was registered with a later startLedger or earliest events fell out of retention.
    // Earliest indexed event is "funded" (not "init").
    insertEvent(
      contractId,
      "funded",
      200,
      2000,
      JSON.stringify({
        client: CLIENT,
        freelancer: FREELANCER,
        amount: "5000",
      }),
    );

    // Seed snapshot into jobStateCache as if GET /api/jobs/:contractId had queried RPC
    jobStateCache.set(contractId, {
      milestones: [{ amount: "2500" }, { amount: "2500" }],
    });

    const result = await getJobsByWallet(CLIENT);
    expect(result.total).toBe(1);
    expect(result.jobs[0].contract_id).toBe(contractId);
    // Accurately reports milestone_count = 2 rather than defaulting to 0
    expect(result.jobs[0].milestone_count).toBe(2);

    // Verify it also seeded job_summary table
    const summary = getJobSummary(contractId);
    expect(summary).not.toBeNull();
    expect(summary?.milestone_count).toBe(2);

    // Clear cache to ensure job_summary persists the correct count
    resetJobStateCache();
    resetJobsByWalletCache();

    const resultFromSummary = await getJobsByWallet(CLIENT);
    expect(resultFromSummary.jobs[0].milestone_count).toBe(2);
  });

  it("handles missing init event when job has subsequent add_milestone after snapshot", async () => {
    const contractId = "C-NO-INIT-2";

    insertEvent(
      contractId,
      "funded",
      200,
      2000,
      JSON.stringify({
        client: CLIENT,
        freelancer: FREELANCER,
        amount: "5000",
      }),
    );

    jobStateCache.set(contractId, {
      milestones: [{ amount: "2500" }, { amount: "2500" }],
    });

    // Ingest add_milestone event
    insertEvent(
      contractId,
      "add_milestone",
      201,
      2010,
      JSON.stringify({
        amount: "1000",
      }),
    );

    const result = await getJobsByWallet(CLIENT);
    expect(result.total).toBe(1);
    expect(result.jobs[0].milestone_count).toBe(3);
  });

  it("backfills existing contracts deterministically via backfillJobSummary", () => {
    const db = getDb();
    const contractId = "C-BACKFILL-1";

    // Manually insert events without triggering triggers or summary updates
    db.prepare(`
      INSERT INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json, event_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      contractId,
      "init",
      50,
      500,
      JSON.stringify({ client: CLIENT, freelancer: FREELANCER, milestone_count: 2 }),
      "evt-bf-1",
    );
    db.prepare(`
      INSERT INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json, event_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      contractId,
      "add_milestone",
      55,
      550,
      JSON.stringify({ amount: "200" }),
      "evt-bf-2",
    );
    db.prepare(`
      INSERT INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json, event_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      contractId,
      "reduce_milestone",
      60,
      600,
      JSON.stringify({}),
      "evt-bf-3",
    );
    db.prepare(`
      INSERT INTO job_participants (contract_id, address, role)
      VALUES (?, ?, 'client')
    `).run(contractId, CLIENT);

    // Clear job_summary to simulate pre-migration state
    db.exec("DELETE FROM job_summary");
    expect(getJobSummary(contractId)).toBeNull();

    // Run backfill
    backfillJobSummary(db);

    const summary = getJobSummary(contractId);
    expect(summary).not.toBeNull();
    // 2 (init) + 1 (add) - 1 (reduce) = 2
    expect(summary?.milestone_count).toBe(2);
  });
});
