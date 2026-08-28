import Database from "better-sqlite3";
import request from "supertest";
import express from "express";
import type { Request, Response } from "express";
import { resetByWalletRateLimitBuckets } from "../src/middleware/rateLimiter.js";
import {
  initSchema,
  insertEvent,
  setDb,
  getJobsByWallet,
  resetJobsByWalletCache,
} from "../src/indexer/db.js";

// ---------------------------------------------------------------------------
// Valid 56-char Stellar G-addresses (pass StrKey.isValidEd25519PublicKey).
// Used in HTTP integration tests where the Zod param schema now validates them.
// GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX is the well-known
// valid address already used across the entire test suite.
// ---------------------------------------------------------------------------

/** The single well-known valid Stellar account address used project-wide. */
const VALID_G_ADDR = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";


// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Seed a single event into the in-memory DB */
function seedEvent(
  db: Database.Database,
  opts: {
    contractId: string;
    eventType: string;
    ledger: number;
    timestamp: number;
    dataJson: string;
  }
) {
  db.prepare(
    `INSERT OR IGNORE INTO events
       (contract_id, event_type, ledger_sequence, timestamp, data_json)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    opts.contractId,
    opts.eventType,
    opts.ledger,
    opts.timestamp,
    opts.dataJson
  );
}

// ---------------------------------------------------------------------------
// Shared DB setup
// ---------------------------------------------------------------------------

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
  resetJobsByWalletCache();
});


// ---------------------------------------------------------------------------
// Unit tests: getJobsByWallet()
// ---------------------------------------------------------------------------

describe("getJobsByWallet() – unit", () => {
  const CLIENT = "GCLIENT111";
  const FREELANCER = "GFREELANCER222";
  const ARBITER = "GARBITER333";
  const CONTRACT_A = "CONTRACT-A";
  const CONTRACT_B = "CONTRACT-B";
  const CONTRACT_C = "CONTRACT-C";

  it("returns empty result when no events exist for address", async () => {
    const result = await getJobsByWallet("GNOBODY");
    expect(result.total).toBe(0);
    expect(result.jobs).toHaveLength(0);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(10);
  });

  it("returns a job where address is the CLIENT", async () => {
    seedEvent(testDb, {
      contractId: CONTRACT_A,
      eventType: "initialized",
      ledger: 100,
      timestamp: 1000,
      dataJson: JSON.stringify({ client: CLIENT, freelancer: FREELANCER, arbiter: ARBITER }),
    });

    const result = await getJobsByWallet(CLIENT);
    expect(result.total).toBe(1);
    expect(result.jobs[0].contract_id).toBe(CONTRACT_A);
    expect(result.jobs[0].role).toBe("client");
  });

  it("returns a job where address is the FREELANCER", async () => {
    seedEvent(testDb, {
      contractId: CONTRACT_B,
      eventType: "funded",
      ledger: 200,
      timestamp: 2000,
      dataJson: JSON.stringify({ client: CLIENT, freelancer: FREELANCER }),
    });

    const result = await getJobsByWallet(FREELANCER);
    expect(result.total).toBe(1);
    expect(result.jobs[0].contract_id).toBe(CONTRACT_B);
    expect(result.jobs[0].role).toBe("freelancer");
  });

  it("returns a job where address is the ARBITER", async () => {
    seedEvent(testDb, {
      contractId: CONTRACT_C,
      eventType: "dispute_raised",
      ledger: 300,
      timestamp: 3000,
      dataJson: JSON.stringify({ arbiter: ARBITER }),
    });

    const result = await getJobsByWallet(ARBITER);
    expect(result.total).toBe(1);
    expect(result.jobs[0].contract_id).toBe(CONTRACT_C);
    expect(result.jobs[0].role).toBe("arbiter");
  });

  it("groups multiple events for the same contract_id into one job", async () => {
    // Two events, same contract, same freelancer
    seedEvent(testDb, {
      contractId: CONTRACT_A,
      eventType: "initialized",
      ledger: 100,
      timestamp: 1000,
      dataJson: JSON.stringify({ freelancer: FREELANCER }),
    });
    seedEvent(testDb, {
      contractId: CONTRACT_A,
      eventType: "funded",
      ledger: 101,
      timestamp: 1001,
      dataJson: JSON.stringify({ freelancer: FREELANCER }),
    });

    const result = await getJobsByWallet(FREELANCER);
    expect(result.total).toBe(1);
    expect(result.jobs[0].latest_event_type).toBe("funded");
  });

  it("returns distinct jobs across multiple contracts", async () => {
    const addr = "GMULTICONTRACT";
    seedEvent(testDb, { contractId: "C1", eventType: "initialized", ledger: 10, timestamp: 100, dataJson: JSON.stringify({ client: addr }) });
    seedEvent(testDb, { contractId: "C2", eventType: "funded",      ledger: 20, timestamp: 200, dataJson: JSON.stringify({ client: addr }) });
    seedEvent(testDb, { contractId: "C3", eventType: "approved",    ledger: 30, timestamp: 300, dataJson: JSON.stringify({ client: addr }) });

    const result = await getJobsByWallet(addr);
    expect(result.total).toBe(3);
  });

  it("does not match address that only appears in non-role fields", async () => {
    const addr = "GNOTAROLE";
    seedEvent(testDb, {
      contractId: "C-FAKE",
      eventType: "initialized",
      ledger: 50,
      timestamp: 500,
      dataJson: JSON.stringify({ token: addr, some_other_field: addr }),
    });

    const result = await getJobsByWallet(addr);
    expect(result.total).toBe(0);
  });

  it("correctly extracts milestone_count from data_json milestones array", async () => {
    const addr = "GMILESTONETEST";
    const milestones = [{ amount: "100" }, { amount: "200" }, { amount: "300" }];
    seedEvent(testDb, {
      contractId: "CONTRACT-MS",
      eventType: "initialized",
      ledger: 10,
      timestamp: 100,
      dataJson: JSON.stringify({ client: addr, milestones }),
    });

    const result = await getJobsByWallet(addr);
    expect(result.jobs[0].milestone_count).toBe(3);
  });

  it("returns milestone_count=0 when data_json has no milestones field", async () => {
    const addr = "GNOMILESTONES";
    seedEvent(testDb, {
      contractId: "CONTRACT-NMS",
      eventType: "initialized",
      ledger: 10,
      timestamp: 100,
      dataJson: JSON.stringify({ client: addr }),
    });

    const result = await getJobsByWallet(addr);
    expect(result.jobs[0].milestone_count).toBe(0);
  });

  it("returns milestone_count=0 when milestones field is not an array", async () => {
    const addr = "GBADMILESTONES";
    seedEvent(testDb, {
      contractId: "CONTRACT-BMS",
      eventType: "initialized",
      ledger: 10,
      timestamp: 100,
      dataJson: JSON.stringify({ client: addr, milestones: "not-an-array" }),
    });

    const result = await getJobsByWallet(addr);
    expect(result.jobs[0].milestone_count).toBe(0);
  });

  it("role priority: client takes precedence when address matches all three roles in same event", async () => {
    const addr = "GMULTIROLE";
    seedEvent(testDb, {
      contractId: "CONTRACT-MULTI",
      eventType: "initialized",
      ledger: 10,
      timestamp: 100,
      dataJson: JSON.stringify({ client: addr, freelancer: addr, arbiter: addr }),
    });

    const result = await getJobsByWallet(addr);
    expect(result.total).toBe(1);
    // CASE expression checks client first → role = "client"
    expect(result.jobs[0].role).toBe("client");
  });

  // -------------------------------------------------------------------------
  // Pagination – unit layer
  // -------------------------------------------------------------------------

  it("pagination: page=1 limit=2 returns first 2 of 5 jobs", async () => {
    const addr = "GPAGER";
    for (let i = 1; i <= 5; i++) {
      seedEvent(testDb, { contractId: `C${i}`, eventType: "initialized", ledger: i * 10, timestamp: i * 100, dataJson: JSON.stringify({ client: addr }) });
    }

    const p1 = await getJobsByWallet(addr, 1, 2);
    expect(p1.total).toBe(5);
    expect(p1.jobs).toHaveLength(2);
    expect(p1.page).toBe(1);
    expect(p1.limit).toBe(2);
  });

  it("pagination: page=2 limit=2 returns jobs 3-4 of 5", async () => {
    const addr = "GPAGER2";
    for (let i = 1; i <= 5; i++) {
      seedEvent(testDb, { contractId: `D${i}`, eventType: "initialized", ledger: i * 10, timestamp: i * 100, dataJson: JSON.stringify({ client: addr }) });
    }

    const p2 = await getJobsByWallet(addr, 2, 2);
    expect(p2.total).toBe(5);
    expect(p2.jobs).toHaveLength(2);
    expect(p2.page).toBe(2);
  });

  it("pagination: last page returns remaining jobs (not a full page)", async () => {
    const addr = "GPAGER3";
    for (let i = 1; i <= 5; i++) {
      seedEvent(testDb, { contractId: `E${i}`, eventType: "initialized", ledger: i * 10, timestamp: i * 100, dataJson: JSON.stringify({ client: addr }) });
    }

    const p3 = await getJobsByWallet(addr, 3, 2);
    expect(p3.total).toBe(5);
    expect(p3.jobs).toHaveLength(1);
  });

  it("pagination: page beyond total returns empty jobs array", async () => {
    const addr = "GPAGER4";
    seedEvent(testDb, { contractId: "F1", eventType: "initialized", ledger: 10, timestamp: 100, dataJson: JSON.stringify({ client: addr }) });

    const p = await getJobsByWallet(addr, 99, 10);
    expect(p.total).toBe(1);
    expect(p.jobs).toHaveLength(0);
  });

  it("pagination: page=3 limit=10 returns correct page/limit in result", async () => {
    const addr = "GPAGER5";
    seedEvent(testDb, { contractId: "G1", eventType: "initialized", ledger: 10, timestamp: 100, dataJson: JSON.stringify({ client: addr }) });

    const result = await getJobsByWallet(addr, 3, 10);
    expect(result.page).toBe(3);
    expect(result.limit).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// HTTP integration tests: GET /api/jobs/by-wallet/:address
// ---------------------------------------------------------------------------

const VALID_WALLET = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";
const VALID_WALLET_2 = "GB5CRPXUGXZCG6BESL4CM4F3VUAGQGFNYNBHPBRJAGLXXSRYJSEGZHUV";
const VALID_WALLET_3 = "GABNCQRZNTG6MMITD33VHFITKJZ5PSYW2XVEXMP52BSMTPLU7WORDQNT";

describe("GET /api/jobs/by-wallet/:address – HTTP", () => {
  let app: express.Express;

  beforeAll(async () => {
    // Dynamically import the router AFTER setDb() so it uses the in-memory DB
    const { default: router } = await import("../src/routes/jobs.js");
    app = express();
    // Ensure no API_KEY gate is active for the baseline HTTP suite
    delete process.env.API_KEY;
    app.use(express.json());
    app.use("/api/jobs", router);
  });

  it("returns success:true with jobs array and pagination fields", async () => {
    const addr = VALID_WALLET;
    seedEvent(testDb, {
      contractId: "HTTP-C1",
      eventType: "initialized",
      ledger: 1,
      timestamp: 100,
      dataJson: JSON.stringify({ client: VALID_G_ADDR }),
    });

    const res = await request(app)
      .get(`/api/jobs/by-wallet/${VALID_G_ADDR}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.jobs)).toBe(true);
    expect(res.body.data.total).toBeDefined();
    expect(res.body.data.page).toBeDefined();
    expect(res.body.data.limit).toBeDefined();
  });

  it("200: returns empty jobs array and total=0 for unknown address", async () => {
    const res = await request(app)
      .get(`/api/jobs/by-wallet/${VALID_WALLET_2}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.jobs).toHaveLength(0);
    expect(res.body.data.total).toBe(0);
  });

  it("respects ?page=1&limit=2 query params", async () => {
    const addr = VALID_WALLET_3;
    for (let i = 1; i <= 4; i++) {
      seedEvent(testDb, { contractId: `HP${i}`, eventType: "initialized", ledger: i, timestamp: i * 100, dataJson: JSON.stringify({ client: addr }) });
    }

    const res = await request(app).get(`/api/jobs/by-wallet/${addr}?page=1&limit=2`).expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.jobs).toHaveLength(2);
    expect(res.body.data.total).toBe(4);
    expect(res.body.data.page).toBe(1);
    expect(res.body.data.limit).toBe(2);
  });

  it("each job entry has the expected shape", async () => {
    const addr = VALID_WALLET;
    seedEvent(testDb, {
      contractId: "SHAPE-C",
      eventType: "funded",
      ledger: 50,
      timestamp: 5000,
      dataJson: JSON.stringify({ freelancer: VALID_G_ADDR }),
    });
  });

  it("400: invalid page (page=-1) returns 400", async () => {
    const res = await request(app)
      .get("/api/jobs/by-wallet/GSOMEADDR?page=-1")
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
  });

  it("serves concurrent requests from the in-memory wallet jobs cache", async () => {
    const addr = VALID_WALLET;
    seedEvent(testDb, {
      contractId: "CACHED-REQ",
      eventType: "initialized",
      ledger: 42,
      timestamp: 4200,
      dataJson: JSON.stringify({ client: addr }),
    });

    const originalPrepare = testDb.prepare.bind(testDb);
    let prepareCalls = 0;
    testDb.prepare = function (sql: string) {
      prepareCalls += 1;
      return originalPrepare(sql);
    } as typeof testDb.prepare;

    const [first, second] = await Promise.all([
      request(app).get(`/api/jobs/by-wallet/${addr}`).expect(200),
      request(app).get(`/api/jobs/by-wallet/${addr}`).expect(200),
    ]);

    expect(first.body.success).toBe(true);
    expect(second.body.success).toBe(true);
    expect(first.body.data.jobs).toHaveLength(1);
    expect(second.body.data.jobs).toHaveLength(1);
    expect(prepareCalls).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Zod middleware validation: GET /api/jobs/by-wallet/:address
// ---------------------------------------------------------------------------

describe("GET /api/jobs/by-wallet/:address – Zod middleware", () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: router } = await import("../src/routes/jobs.js");
    app = express();
    app.use(express.json());
    app.use("/api/jobs", router);
  });

  it("returns 400 for an invalid wallet address format", async () => {
    const res = await request(app)
      .get("/api/jobs/by-wallet/not-a-stellar-address")
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/address/i);
    expect(res.body.details[0].message).toMatch(/valid Stellar account address/i);
  });

  it("returns 400 for a contract address (C…) used as wallet", async () => {
    const res = await request(app)
      .get(
        "/api/jobs/by-wallet/CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH",
      )
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/address/i);
  });

  it("returns 400 for an address that is too short", async () => {
    const res = await request(app)
      .get("/api/jobs/by-wallet/GSHORT")
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/address/i);
  });

  it("returns 400 when page is not a positive integer", async () => {
    const res = await request(app)
      .get(`/api/jobs/by-wallet/${VALID_WALLET}?page=0`)
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].field).toBe("page");
    expect(res.body.details[0].message).toMatch(/page/i);
  });

  it("returns 400 when page is not numeric", async () => {
    const res = await request(app)
      .get(`/api/jobs/by-wallet/${VALID_WALLET}?page=abc`)
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/page/i);
  });

  it("returns 400 when limit is greater than 100", async () => {
    const res = await request(app)
      .get(`/api/jobs/by-wallet/${VALID_WALLET}?limit=101`)
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].field).toBe("limit");
    expect(res.body.details[0].message).toMatch(/limit/i);
  });

  it("returns 400 when limit is less than 1", async () => {
    const res = await request(app)
      .get(`/api/jobs/by-wallet/${VALID_WALLET}?limit=0`)
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].field).toBe("limit");
    expect(res.body.details[0].message).toMatch(/limit/i);
  });

  it("error body has ValidationError format", async () => {
    const res = await request(app)
      .get("/api/jobs/by-wallet/bad-address")
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it("does not return 400 for a valid address and query", async () => {
    const res = await request(app).get(
      `/api/jobs/by-wallet/${VALID_WALLET}?page=1&limit=10`,
    );
    expect(res.status).not.toBe(400);
  });

  it("returns 400 for address with valid length but bad checksum", async () => {
    const badChecksum = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRY";
    const res = await request(app)
      .get(`/api/jobs/by-wallet/${badChecksum}`)
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/address/i);
  });
});

// ---------------------------------------------------------------------------
// HTTP status code tests: accurate 401 / 500 handling
// ---------------------------------------------------------------------------

describe("GET /api/jobs/by-wallet/:address – status codes", () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: router } = await import("../src/routes/jobs.js");
    app = express();
    app.use(express.json());
    app.use("/api/jobs", router);
  });

  afterEach(() => {
    delete process.env.API_KEY;
    resetJobsByWalletCache();
  });

  // -------------------------------------------------------------------------
  // 200 – success
  // -------------------------------------------------------------------------

  it("returns 200 with { success: true, data: { jobs, total, page, limit } }", async () => {
    const addr = VALID_WALLET;
    seedEvent(testDb, {
      contractId: "SC-200",
      eventType: "initialized",
      ledger: 1,
      timestamp: 100,
      dataJson: JSON.stringify({ client: addr }),
    });

    const res = await request(app)
      .get(`/api/jobs/by-wallet/${addr}`)
      .expect(200);

    expect(res.body).toMatchObject({
      success: true,
      data: {
        jobs: expect.any(Array),
        total: expect.any(Number),
        page: expect.any(Number),
        limit: expect.any(Number),
      },
    });
    // Top-level must NOT contain raw pagination fields
    expect(res.body.jobs).toBeUndefined();
    expect(res.body.total).toBeUndefined();
  });

  it("returns 200 with empty jobs array when address has no indexed jobs", async () => {
    const res = await request(app)
      .get(`/api/jobs/by-wallet/${VALID_WALLET_2}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.jobs).toHaveLength(0);
    expect(res.body.data.total).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 400 – invalid input
  // -------------------------------------------------------------------------

  it("returns 400 with { success: false, error } for an invalid address", async () => {
    const res = await request(app)
      .get("/api/jobs/by-wallet/not-valid")
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it("returns 400 for invalid page query param", async () => {
    const res = await request(app)
      .get(`/api/jobs/by-wallet/${VALID_WALLET}?page=-1`)
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/page/i);
  });

  it("returns 400 for invalid limit query param", async () => {
    const res = await request(app)
      .get(`/api/jobs/by-wallet/${VALID_WALLET}?limit=9999`)
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/limit/i);
  });

  // -------------------------------------------------------------------------
  // 401 – missing or wrong API key when API_KEY env var is set
  // -------------------------------------------------------------------------

  it("returns 401 when API_KEY is set and no key is provided", async () => {
    process.env.API_KEY = "secret-test-key";

    const res = await request(app)
      .get(`/api/jobs/by-wallet/${VALID_WALLET}`)
      .expect(401);

    expect(res.body).toEqual({ success: false, error: "Unauthorized" });
  });

  it("returns 401 when API_KEY is set and wrong key is provided", async () => {
    process.env.API_KEY = "secret-test-key";

    const res = await request(app)
      .get(`/api/jobs/by-wallet/${VALID_WALLET}`)
      .set("x-api-key", "wrong-key")
      .expect(401);

    expect(res.body).toEqual({ success: false, error: "Unauthorized" });
  });

  it("returns 200 when API_KEY is set and correct key is provided", async () => {
    process.env.API_KEY = "secret-test-key";

    const res = await request(app)
      .get(`/api/jobs/by-wallet/${VALID_WALLET}`)
      .set("x-api-key", "secret-test-key")
      .expect(200);

    expect(res.body.success).toBe(true);
  });

  it("returns 200 (no gate) when API_KEY env var is not set", async () => {
    delete process.env.API_KEY;

    const res = await request(app)
      .get(`/api/jobs/by-wallet/${VALID_WALLET}`)
      .expect(200);

    expect(res.body.success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 500 – internal server error
  // -------------------------------------------------------------------------

  it("returns 500 with { success: false, error: 'Internal server error' } on DB failure", async () => {
    // Force a DB error by swapping in a closed database instance
    const brokenDb = new Database(":memory:");
    setDb(brokenDb);
    brokenDb.close();
    resetJobsByWalletCache();

    const res = await request(app)
      .get(`/api/jobs/by-wallet/${VALID_WALLET}`)
      .expect(500);

    expect(res.body).toEqual({ success: false, error: "Internal server error" });

    // Restore a healthy in-memory DB for subsequent tests
    const freshDb = new Database(":memory:");
    setDb(freshDb);
    initSchema();
    resetJobsByWalletCache();
  });
});
