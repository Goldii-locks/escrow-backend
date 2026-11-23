import Database from "better-sqlite3";
import request from "supertest";
import express from "express";
import { autoAuth } from "./helpers/api-key-helper.js";
import { resetByWalletRateLimitBuckets } from "../src/middleware/rateLimiter.js";
import {
  initSchema,
  insertEvent,
  insertEventBatch,
  setDb,
  getJobsByWallet,
  resetJobsByWalletCache,
} from "../src/indexer/db.js";

/**
 * by-wallet follows freelancer rotation (`freerot`) and arbiter replacement
 * (`arbchg`): the new party gains the job, the previous one loses it (#884).
 */

const CONTRACT = "CONTRACT-ROLES";
const CLIENT = "GCLIENT111";
const OLD_FREELANCER = "GOLDFREELANCER";
const NEW_FREELANCER = "GNEWFREELANCER";
const OLD_ARBITER = "GOLDARBITER";
const NEW_ARBITER = "GNEWARBITER";

let testDb: Database.Database;

beforeAll(() => {
  testDb = new Database(":memory:");
  setDb(testDb);
  initSchema();
});

afterAll(() => testDb.close());

beforeEach(() => {
  testDb.exec("DELETE FROM events");
  testDb.exec("DELETE FROM job_participants");
  resetByWalletRateLimitBuckets();
  resetJobsByWalletCache();
});

function init(contractId = CONTRACT) {
  insertEvent(
    contractId,
    "init",
    100,
    1000,
    JSON.stringify({ client: CLIENT, freelancer: OLD_FREELANCER, arbiter: OLD_ARBITER }),
    `${contractId}:init`,
  );
}

const jobsFor = async (address: string) => (await getJobsByWallet(address)).jobs.map((j) => j.contract_id);

describe("freelancer rotation (freerot)", () => {
  it("moves the job from the previous freelancer to the new one", async () => {
    init();
    insertEvent(
      CONTRACT,
      "freerot",
      200,
      2000,
      JSON.stringify({ client: CLIENT, previous_freelancer: OLD_FREELANCER, new_freelancer: NEW_FREELANCER }),
      `${CONTRACT}:freerot`,
    );

    expect(await jobsFor(NEW_FREELANCER)).toEqual([CONTRACT]);
    expect(await jobsFor(OLD_FREELANCER)).toEqual([]);
    expect((await getJobsByWallet(NEW_FREELANCER)).jobs[0].role).toBe("freelancer");
    // The client and arbiter are unaffected.
    expect(await jobsFor(CLIENT)).toEqual([CONTRACT]);
    expect(await jobsFor(OLD_ARBITER)).toEqual([CONTRACT]);
  });

  it("refreshes cached by-wallet answers for both addresses", async () => {
    init();
    // Populate the per-address cache before the rotation.
    expect(await jobsFor(OLD_FREELANCER)).toEqual([CONTRACT]);
    expect(await jobsFor(NEW_FREELANCER)).toEqual([]);

    insertEvent(
      CONTRACT,
      "freerot",
      200,
      2000,
      JSON.stringify({ client: CLIENT, previous_freelancer: OLD_FREELANCER, new_freelancer: NEW_FREELANCER }),
      `${CONTRACT}:freerot`,
    );

    expect(await jobsFor(OLD_FREELANCER)).toEqual([]);
    expect(await jobsFor(NEW_FREELANCER)).toEqual([CONTRACT]);
  });

  it("applies through the batch insert path too", async () => {
    init();
    insertEventBatch(
      [
        {
          contractId: CONTRACT,
          eventType: "freerot",
          ledgerSequence: 200,
          timestamp: 2000,
          dataJson: JSON.stringify({ client: CLIENT, previous_freelancer: OLD_FREELANCER, new_freelancer: NEW_FREELANCER }),
          eventId: `${CONTRACT}:freerot`,
        },
      ],
      200,
    );

    expect(await jobsFor(NEW_FREELANCER)).toEqual([CONTRACT]);
    expect(await jobsFor(OLD_FREELANCER)).toEqual([]);
  });

  it("is idempotent when the same event is delivered twice", async () => {
    init();
    const data = JSON.stringify({ client: CLIENT, previous_freelancer: OLD_FREELANCER, new_freelancer: NEW_FREELANCER });
    insertEvent(CONTRACT, "freerot", 200, 2000, data, `${CONTRACT}:freerot`);
    insertEvent(CONTRACT, "freerot", 200, 2000, data, `${CONTRACT}:freerot`);

    expect(await jobsFor(NEW_FREELANCER)).toEqual([CONTRACT]);
    expect(await jobsFor(OLD_FREELANCER)).toEqual([]);
  });

  it("follows successive rotations", async () => {
    init();
    insertEvent(CONTRACT, "freerot", 200, 2000, JSON.stringify({ client: CLIENT, previous_freelancer: OLD_FREELANCER, new_freelancer: NEW_FREELANCER }), "e2");
    insertEvent(CONTRACT, "freerot", 300, 3000, JSON.stringify({ client: CLIENT, previous_freelancer: NEW_FREELANCER, new_freelancer: "GTHIRD" }), "e3");

    expect(await jobsFor("GTHIRD")).toEqual([CONTRACT]);
    expect(await jobsFor(NEW_FREELANCER)).toEqual([]);
    expect(await jobsFor(OLD_FREELANCER)).toEqual([]);
  });
});

describe("arbiter replacement (arbchg)", () => {
  it("moves the job from the old arbiter to the new one", async () => {
    init();
    insertEvent(
      CONTRACT,
      "arbchg",
      200,
      2000,
      JSON.stringify({ client: CLIENT, freelancer: OLD_FREELANCER, old: OLD_ARBITER, new: NEW_ARBITER }),
      `${CONTRACT}:arbchg`,
    );

    expect(await jobsFor(NEW_ARBITER)).toEqual([CONTRACT]);
    expect(await jobsFor(OLD_ARBITER)).toEqual([]);
    expect((await getJobsByWallet(NEW_ARBITER)).jobs[0].role).toBe("arbiter");
    expect(await jobsFor(OLD_FREELANCER)).toEqual([CONTRACT]);
  });

  it("does not drop an address that also holds another role on the job", async () => {
    // The client is also the arbiter; replacing the arbiter must keep the client row.
    insertEvent(CONTRACT, "init", 100, 1000, JSON.stringify({ client: CLIENT, freelancer: OLD_FREELANCER, arbiter: CLIENT }), "i");
    insertEvent(CONTRACT, "arbchg", 200, 2000, JSON.stringify({ client: CLIENT, freelancer: OLD_FREELANCER, old: CLIENT, new: NEW_ARBITER }), "a");

    expect(await jobsFor(CLIENT)).toEqual([CONTRACT]);
    expect((await getJobsByWallet(CLIENT)).jobs[0].role).toBe("client");
    expect(await jobsFor(NEW_ARBITER)).toEqual([CONTRACT]);
  });
});

describe("migration 20 replays existing role-change events (#884)", () => {
  it("fixes participants for events indexed before the fix", async () => {
    // Simulate the pre-fix state: events present, participants never updated.
    const insert = testDb.prepare(
      "INSERT INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json, event_id) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run(CONTRACT, "init", 100, 1000, JSON.stringify({ client: CLIENT, freelancer: OLD_FREELANCER, arbiter: OLD_ARBITER }), "m1");
    insert.run(CONTRACT, "freerot", 200, 2000, JSON.stringify({ client: CLIENT, previous_freelancer: OLD_FREELANCER, new_freelancer: NEW_FREELANCER }), "m2");
    insert.run(CONTRACT, "arbchg", 300, 3000, JSON.stringify({ client: CLIENT, freelancer: NEW_FREELANCER, old: OLD_ARBITER, new: NEW_ARBITER }), "m3");
    const add = testDb.prepare("INSERT OR IGNORE INTO job_participants (contract_id, address, role) VALUES (?, ?, ?)");
    add.run(CONTRACT, CLIENT, "client");
    add.run(CONTRACT, OLD_FREELANCER, "freelancer");
    add.run(CONTRACT, OLD_ARBITER, "arbiter");

    testDb.prepare("DELETE FROM schema_migrations WHERE version = 20").run();
    initSchema();

    expect(await jobsFor(NEW_FREELANCER)).toEqual([CONTRACT]);
    expect(await jobsFor(NEW_ARBITER)).toEqual([CONTRACT]);
    expect(await jobsFor(OLD_FREELANCER)).toEqual([]);
    expect(await jobsFor(OLD_ARBITER)).toEqual([]);
    expect(await jobsFor(CLIENT)).toEqual([CONTRACT]);
  });
});

describe("GET /by-wallet/:address after a rotation", () => {
  it("lists the job for the new freelancer only", async () => {
    // Use the shared valid test addresses so the route's address validation passes.
    const OLD = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";
    const NEW = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
    insertEvent(CONTRACT, "init", 100, 1000, JSON.stringify({ client: CLIENT, freelancer: OLD }), "h1");
    insertEvent(CONTRACT, "freerot", 200, 2000, JSON.stringify({ client: CLIENT, previous_freelancer: OLD, new_freelancer: NEW }), "h2");

    const { default: router } = await import("../src/routes/jobs.js");
    const app = express();
    app.use(express.json());
    app.use(autoAuth);
    app.use("/api/jobs", router);

    const forNew = await request(app).get(`/api/jobs/by-wallet/${NEW}`).expect(200);
    const forOld = await request(app).get(`/api/jobs/by-wallet/${OLD}`).expect(200);

    expect(JSON.stringify(forNew.body)).toContain(CONTRACT);
    expect(JSON.stringify(forOld.body)).not.toContain(CONTRACT);
  });
});
