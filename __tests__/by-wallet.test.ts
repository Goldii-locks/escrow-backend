import Database from "better-sqlite3";
import request from "supertest";
import express from "express";
import { jest } from "@jest/globals";
import {
  initSchema,
  insertEvent,
  setDb,
  getJobsByWallet,
} from "../src/indexer/db.js";
import { resetByWalletRateLimitBuckets } from "../src/middleware/job-contract-rate-limit.js";

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
  testDb.exec("DELETE FROM events");
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

  it("returns empty result when no events exist for address", () => {
    const result = getJobsByWallet("GNOBODY");
    expect(result.total).toBe(0);
    expect(result.jobs).toHaveLength(0);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(10);
  });

  it("returns a job where address is the CLIENT", () => {
    seedEvent(testDb, {
      contractId: CONTRACT_A,
      eventType: "initialized",
      ledger: 100,
      timestamp: 1000,
      dataJson: JSON.stringify({ client: CLIENT, freelancer: FREELANCER, arbiter: ARBITER }),
    });

    const result = getJobsByWallet(CLIENT);
    expect(result.total).toBe(1);
    expect(result.jobs[0].contract_id).toBe(CONTRACT_A);
    expect(result.jobs[0].role).toBe("client");
  });

  it("returns a job where address is the FREELANCER", () => {
    seedEvent(testDb, {
      contractId: CONTRACT_B,
      eventType: "funded",
      ledger: 200,
      timestamp: 2000,
      dataJson: JSON.stringify({ client: CLIENT, freelancer: FREELANCER }),
    });

    const result = getJobsByWallet(FREELANCER);
    expect(result.total).toBe(1);
    expect(result.jobs[0].contract_id).toBe(CONTRACT_B);
    expect(result.jobs[0].role).toBe("freelancer");
  });

  it("returns a job where address is the ARBITER", () => {
    seedEvent(testDb, {
      contractId: CONTRACT_C,
      eventType: "dispute_raised",
      ledger: 300,
      timestamp: 3000,
      dataJson: JSON.stringify({ arbiter: ARBITER }),
    });

    const result = getJobsByWallet(ARBITER);
    expect(result.total).toBe(1);
    expect(result.jobs[0].contract_id).toBe(CONTRACT_C);
    expect(result.jobs[0].role).toBe("arbiter");
  });

  it("groups multiple events for the same contract_id into one job", () => {
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

    const result = getJobsByWallet(FREELANCER);
    expect(result.total).toBe(1);
    // Should capture the most-recent event type (highest ledger comes first)
    expect(result.jobs[0].latest_event_type).toBe("funded");
  });

  it("returns distinct jobs across multiple contracts", () => {
    const addr = "GMULTICONTRACT";
    seedEvent(testDb, {
      contractId: "C1",
      eventType: "initialized",
      ledger: 10,
      timestamp: 100,
      dataJson: JSON.stringify({ client: addr }),
    });
    seedEvent(testDb, {
      contractId: "C2",
      eventType: "funded",
      ledger: 20,
      timestamp: 200,
      dataJson: JSON.stringify({ client: addr }),
    });
    seedEvent(testDb, {
      contractId: "C3",
      eventType: "approved",
      ledger: 30,
      timestamp: 300,
      dataJson: JSON.stringify({ client: addr }),
    });

    const result = getJobsByWallet(addr);
    expect(result.total).toBe(3);
  });

  it("does not match address that only appears in non-role fields", () => {
    const addr = "GNOTAROLE";
    seedEvent(testDb, {
      contractId: "C-FAKE",
      eventType: "initialized",
      ledger: 50,
      timestamp: 500,
      dataJson: JSON.stringify({ token: addr, some_other_field: addr }),
    });

    const result = getJobsByWallet(addr);
    expect(result.total).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------

  it("pagination: page=1 limit=2 returns first 2 of 5 jobs", () => {
    const addr = "GPAGER";
    for (let i = 1; i <= 5; i++) {
      seedEvent(testDb, {
        contractId: `C${i}`,
        eventType: "initialized",
        ledger: i * 10,
        timestamp: i * 100,
        dataJson: JSON.stringify({ client: addr }),
      });
    }

    const p1 = getJobsByWallet(addr, 1, 2);
    expect(p1.total).toBe(5);
    expect(p1.jobs).toHaveLength(2);
    expect(p1.page).toBe(1);
    expect(p1.limit).toBe(2);
  });

  it("pagination: page=2 limit=2 returns jobs 3-4 of 5", () => {
    const addr = "GPAGER2";
    for (let i = 1; i <= 5; i++) {
      seedEvent(testDb, {
        contractId: `D${i}`,
        eventType: "initialized",
        ledger: i * 10,
        timestamp: i * 100,
        dataJson: JSON.stringify({ client: addr }),
      });
    }

    const p2 = getJobsByWallet(addr, 2, 2);
    expect(p2.total).toBe(5);
    expect(p2.jobs).toHaveLength(2);
    expect(p2.page).toBe(2);
  });

  it("pagination: last page returns remaining jobs (not a full page)", () => {
    const addr = "GPAGER3";
    for (let i = 1; i <= 5; i++) {
      seedEvent(testDb, {
        contractId: `E${i}`,
        eventType: "initialized",
        ledger: i * 10,
        timestamp: i * 100,
        dataJson: JSON.stringify({ client: addr }),
      });
    }

    const p3 = getJobsByWallet(addr, 3, 2);
    expect(p3.total).toBe(5);
    expect(p3.jobs).toHaveLength(1); // page 3 of 2-per-page = only 1 left
  });

  it("pagination: page beyond total returns empty jobs array", () => {
    const addr = "GPAGER4";
    seedEvent(testDb, {
      contractId: "F1",
      eventType: "initialized",
      ledger: 10,
      timestamp: 100,
      dataJson: JSON.stringify({ client: addr }),
    });

    const p = getJobsByWallet(addr, 99, 10);
    expect(p.total).toBe(1);
    expect(p.jobs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// HTTP integration tests: GET /api/jobs/by-wallet/:address
// ---------------------------------------------------------------------------

describe("GET /api/jobs/by-wallet/:address – HTTP", () => {
  let app: express.Express;
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  beforeAll(async () => {
    jest.unstable_mockModule("../src/middleware/rateLimiter.js", () => ({
      strictLimiter: (_req: any, _res: any, next: any) => next(),
      generalLimiter: (_req: any, _res: any, next: any) => next(),
    }));

    jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
      Server: class MockServer {},
    }));

    jest.unstable_mockModule("../src/utils/logger.js", () => ({
      default: mockLogger,
    }));

    // Dynamically import the router AFTER setDb() so it uses the in-memory DB
    const { default: router } = await import("../src/routes/jobs.js");
    app = express();
    app.use(express.json());
    app.use("/api/jobs", router);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    resetByWalletRateLimitBuckets();
  });

  it("returns success:true with jobs array and pagination fields", async () => {
    const addr = "GHTTPTEST1";
    seedEvent(testDb, {
      contractId: "HTTP-C1",
      eventType: "initialized",
      ledger: 1,
      timestamp: 100,
      dataJson: JSON.stringify({ client: addr }),
    });

    const res = await request(app)
      .get(`/api/jobs/by-wallet/${addr}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.jobs)).toBe(true);
    expect(res.body.total).toBeDefined();
    expect(res.body.page).toBeDefined();
    expect(res.body.limit).toBeDefined();
  });

  it("returns empty jobs array for unknown address", async () => {
    const res = await request(app)
      .get("/api/jobs/by-wallet/GNOBODYKNOWSME")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.jobs).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it("respects ?page=1&limit=2 query params", async () => {
    const addr = "GHTTPPAGE";
    for (let i = 1; i <= 4; i++) {
      seedEvent(testDb, {
        contractId: `HP${i}`,
        eventType: "initialized",
        ledger: i,
        timestamp: i * 100,
        dataJson: JSON.stringify({ client: addr }),
      });
    }

    const res = await request(app)
      .get(`/api/jobs/by-wallet/${addr}?page=1&limit=2`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.jobs).toHaveLength(2);
    expect(res.body.total).toBe(4);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(2);
  });

  it("each job entry has the expected shape", async () => {
    const addr = "GSHAPETEST";
    seedEvent(testDb, {
      contractId: "SHAPE-C",
      eventType: "funded",
      ledger: 50,
      timestamp: 5000,
      dataJson: JSON.stringify({ freelancer: addr }),
    });

    const res = await request(app)
      .get(`/api/jobs/by-wallet/${addr}`)
      .expect(200);

    const job = res.body.jobs[0];
    expect(job).toMatchObject({
      contract_id: expect.any(String),
      role: expect.stringMatching(/^(client|freelancer|arbiter)$/),
      milestone_count: expect.any(Number),
      latest_event_type: expect.any(String),
      latest_ledger: expect.any(Number),
      latest_timestamp: expect.any(Number),
    });
  });

  it("returns 429 Too Many Requests after exceeding rate limit", async () => {
    const addr = "GRATELIMITTEST";
    const lowLimit = 3;
    process.env.BY_WALLET_RATE_MAX = String(lowLimit);

    try {
      // Reset buckets and re-import so the rate limiter picks up new env var
      resetByWalletRateLimitBuckets();
      jest.resetModules();

      // Re-setup after resetModules
      jest.unstable_mockModule("../src/middleware/rateLimiter.js", () => ({
        strictLimiter: (_req: any, _res: any, next: any) => next(),
        generalLimiter: (_req: any, _res: any, next: any) => next(),
      }));
      jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
        Server: class MockServer {},
      }));
      jest.unstable_mockModule("../src/utils/logger.js", () => ({
        default: mockLogger,
      }));
      const { default: freshRouter } = await import("../src/routes/jobs.js");
      const freshApp = express();
      freshApp.use(express.json());
      freshApp.use("/api/jobs", freshRouter);

      // Send requests up to the limit - should succeed
      for (let i = 0; i < lowLimit; i++) {
        const res = await request(freshApp)
          .get(`/api/jobs/by-wallet/${addr}`)
          .expect(200);
        expect(res.body.success).toBe(true);
      }

      // Next request should be 429
      const res = await request(freshApp)
        .get(`/api/jobs/by-wallet/${addr}`)
        .expect(429);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("Too many requests");
    } finally {
      delete process.env.BY_WALLET_RATE_MAX;
    }
  });

  it("emits structured trace logs on successful request with address and result count", async () => {
    const addr = "GLOGGINGTEST";
    seedEvent(testDb, {
      contractId: "LOG-C1",
      eventType: "initialized",
      ledger: 1,
      timestamp: 100,
      dataJson: JSON.stringify({ client: addr }),
    });

    await request(app)
      .get(`/api/jobs/by-wallet/${addr}?page=1&limit=10`)
      .expect(200);

    expect(mockLogger.info).toHaveBeenCalledWith(
      "Handling by-wallet request",
      expect.objectContaining({
        address: addr,
        queryParams: expect.objectContaining({
          page: "1",
          limit: "10",
        }),
        method: "GET",
        path: expect.stringContaining("/by-wallet/" + addr),
      })
    );

    expect(mockLogger.info).toHaveBeenCalledWith(
      "by-wallet request completed successfully",
      expect.objectContaining({
        address: addr,
        status: 200,
        resultCount: expect.any(Number),
        totalCount: expect.any(Number),
        durationMs: expect.any(Number),
      })
    );
  });

  it("emits warn log with address and status for invalid request", async () => {
    await request(app)
      .get("/api/jobs/by-wallet/GINVALID?page=-1")
      .expect(400);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Bad request"),
      expect.objectContaining({
        address: "GINVALID",
        status: 400,
        durationMs: expect.any(Number),
      })
    );
  });

  it("emits error log with address and error stack on 500 failure", async () => {
    // Make getJobsByWallet throw an error
    const originalGetJobsByWallet = getJobsByWallet;
    try {
      // We'll test by mocking the module - but since we can't easily mock without reset,
      // let's check that the error handler path exists by verifying the logger.error call
      // when an exception is thrown. For simplicity, let's use jest to spy.
      jest.mock("../src/indexer/db.js", () => {
        const actual = jest.requireActual("../src/indexer/db.js");
        return {
          ...actual,
          getJobsByWallet: jest.fn(() => {
            throw new Error("DB failure");
          }),
        };
      });

      // Reset and reimport
      jest.resetModules();
      jest.unstable_mockModule("../src/middleware/rateLimiter.js", () => ({
        strictLimiter: (_req: any, _res: any, next: any) => next(),
        generalLimiter: (_req: any, _res: any, next: any) => next(),
      }));
      jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
        Server: class MockServer {},
      }));
      jest.unstable_mockModule("../src/utils/logger.js", () => ({
        default: mockLogger,
      }));
      jest.unstable_mockModule("../src/indexer/db.js", () => {
        const actual = jest.requireActual("../src/indexer/db.js");
        return {
          ...actual,
          getJobsByWallet: jest.fn(() => {
            throw new Error("DB failure test");
          }),
        };
      });

      const { default: freshRouter } = await import("../src/routes/jobs.js");
      const freshApp = express();
      freshApp.use(express.json());
      freshApp.use("/api/jobs", freshRouter);

      await request(freshApp)
        .get("/api/jobs/by-wallet/GERRORTEST")
        .expect(500);

      expect(mockLogger.error).toHaveBeenCalledWith(
        "Failed to handle by-wallet request",
        expect.objectContaining({
          address: "GERRORTEST",
          status: 500,
          durationMs: expect.any(Number),
          errorMessage: "DB failure test",
          errorStack: expect.any(String),
        })
      );
    } finally {
      jest.unmock("../src/indexer/db.js");
      originalGetJobsByWallet;
    }
  });
});
