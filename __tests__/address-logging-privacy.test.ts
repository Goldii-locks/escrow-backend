/**
 * Acceptance test: no full Stellar G-address in info-level logs.
 *
 * With LOG_LEVEL=info (the production default) the by-wallet lookup,
 * create-job-draft, and job-fetch endpoints must not emit a 56-character
 * G-address in any logger.info call.  Full addresses are still present at
 * logger.debug so post-incident debugging is unimpaired.
 *
 * See CONTRIBUTING.md §"Logging Policy – Wallet address privacy" and
 * maskAddress() in src/routes/jobs.ts.
 */

import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import Database from "better-sqlite3";
import { autoAuth } from "./helpers/api-key-helper.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const G_CLIENT    = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";
const G_FREELANCER = "GB5CRPXUGXZCG6BESL4CM4F3VUAGQGFNYNBHPBRJAGLXXSRYJSEGZHUV";
const G_ARBITER   = "GABNCQRZNTG6MMITD33VHFITKJZ5PSYW2XVEXMP52BSMTPLU7WORDQNT";
const C_TOKEN     = "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";

/** Matches any full Stellar G-address: G + 55 uppercase alphanumerics. */
const FULL_G_RE = /G[A-Z0-9]{55}/;

// ---------------------------------------------------------------------------
// Mock: logger – capture every call independently of Winston transports.
// ---------------------------------------------------------------------------

const mockLogger = {
  info:  jest.fn<(...args: unknown[]) => void>(),
  warn:  jest.fn<(...args: unknown[]) => void>(),
  error: jest.fn<(...args: unknown[]) => void>(),
  debug: jest.fn<(...args: unknown[]) => void>(),
};

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: mockLogger,
}));

// ---------------------------------------------------------------------------
// Mock: Stellar RPC – no real network calls.
// simulateTransaction returns a valid job retval so "Job fetched successfully"
// is actually reached.
// ---------------------------------------------------------------------------

const mockSimulate  = jest.fn<() => Promise<unknown>>();
const mockGetAccount = jest.fn<() => Promise<unknown>>();

const stubAccount = {
  accountId: () => G_CLIENT,
  sequenceNumber: () => "0",
  incrementSequenceNumber: () => {},
};

function makeJobRetval() {
  return {
    client:     () => ({ toString: () => G_CLIENT }),
    freelancer: () => ({ toString: () => G_FREELANCER }),
    arbiter:    () => ({ toString: () => G_ARBITER }),
    token:      () => ({ toString: () => C_TOKEN }),
    funded:     () => true,
    milestones: () => [
      { amount: () => ({ toString: () => "1000000" }), status: () => ({ approved: true }) },
    ],
  };
}

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: jest.fn().mockImplementation(() => ({
    getAccount: mockGetAccount,
    simulateTransaction: mockSimulate,
    getNetwork: jest.fn<() => Promise<unknown>>().mockResolvedValue({
      passphrase: "Test SDF Network ; September 2015",
    }),
  })),
}));

jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  Account: class {},
  Contract: jest.fn().mockImplementation(() => ({ call: jest.fn().mockReturnValue({}) })),
  TransactionBuilder: jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout:   jest.fn().mockReturnThis(),
    build:        jest.fn().mockReturnValue({}),
  })),
  Networks:     { TESTNET: "Test SDF Network ; September 2015" },
  BASE_FEE:     "100",
  nativeToScVal: jest.fn(),
  scValToNative: jest.fn(),
  Address:       jest.fn(),
  // StrKey is used by src/schemas/jobs.ts and src/utils/stellar.ts for address
  // validation. Return a minimal stub so module loading doesn't throw.
  StrKey: {
    isValidEd25519PublicKey: jest.fn().mockReturnValue(true),
    isValidContract:         jest.fn().mockReturnValue(true),
    decodeEd25519PublicKey:  jest.fn().mockReturnValue(Buffer.alloc(32)),
    encodeEd25519PublicKey:  jest.fn().mockReturnValue(G_CLIENT),
  },
}));

// ---------------------------------------------------------------------------
// Import modules AFTER mocks (ESM requirement).
// ---------------------------------------------------------------------------

const { default: router }        = await import("../src/routes/jobs.js");
const { maskAddress }            = await import("../src/routes/jobs.js");
const { setDb, initSchema }      = await import("../src/indexer/db.js");

// ---------------------------------------------------------------------------
// In-memory SQLite – seed one event so by-wallet returns a hit.
// ---------------------------------------------------------------------------

let testDb: Database.Database;

beforeAll(() => {
  testDb = new Database(":memory:");
  setDb(testDb);
  initSchema();
  testDb
    .prepare(
      `INSERT OR IGNORE INTO events
         (contract_id, event_type, ledger_sequence, timestamp, data_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(C_TOKEN, "initialized", 100, 1000, JSON.stringify({ client: G_CLIENT }));
});

afterAll(() => { testDb.close(); });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAccount.mockResolvedValue(stubAccount);
  mockSimulate.mockResolvedValue({ result: { retval: makeJobRetval() } });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(autoAuth);
  app.use("/api/jobs", router);
  return app;
}

/** Stringify every argument passed to logger.info across all calls. */
function infoOutput(): string {
  return mockLogger.info.mock.calls
    .flatMap((call) =>
      call.map((a) => (typeof a === "string" ? a : JSON.stringify(a))),
    )
    .join("\n");
}

/** Stringify every argument passed to logger.debug across all calls. */
function debugOutput(): string {
  return mockLogger.debug.mock.calls
    .flatMap((call) =>
      call.map((a) => (typeof a === "string" ? a : JSON.stringify(a))),
    )
    .join("\n");
}

const maskOf = (addr: string) => `${addr.slice(0, 4)}\u2026${addr.slice(-4)}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("maskAddress() unit", () => {
  it("truncates a G-address to GABC…WXYZ", () => {
    expect(maskAddress(G_CLIENT)).toBe(maskOf(G_CLIENT));
    expect(maskAddress(G_CLIENT)).not.toMatch(FULL_G_RE);
  });

  it("truncates a C-address the same way", () => {
    expect(maskAddress(C_TOKEN)).toBe(maskOf(C_TOKEN));
  });

  it("returns '' for null / undefined", () => {
    expect(maskAddress(null)).toBe("");
    expect(maskAddress(undefined)).toBe("");
  });

  it("returns value unchanged when shorter than 10 chars", () => {
    expect(maskAddress("GABC")).toBe("GABC");
  });
});

describe("GET /api/jobs/by-wallet/:address – info-level address privacy", () => {
  it("emits no full G-address at info level", async () => {
    await request(buildApp()).get(`/api/jobs/by-wallet/${G_CLIENT}`).expect(200);

    const out = infoOutput();
    expect(out.length).toBeGreaterThan(0); // sanity: at least one info line fired
    expect(out).not.toMatch(FULL_G_RE);
  });

  it("emits the masked form at info level", async () => {
    await request(buildApp()).get(`/api/jobs/by-wallet/${G_CLIENT}`).expect(200);
    expect(infoOutput()).toContain(maskOf(G_CLIENT));
  });

  it("still emits the full address at debug level", async () => {
    await request(buildApp()).get(`/api/jobs/by-wallet/${G_CLIENT}`).expect(200);
    expect(debugOutput()).toContain(G_CLIENT);
  });
});

describe("POST /api/jobs/create-job-draft – info-level address privacy", () => {
  const body = {
    client:     G_CLIENT,
    freelancer: G_FREELANCER,
    arbiter:    G_ARBITER,
    token:      C_TOKEN,
    autoReleaseDays: 7,
    milestones: [{ amount: "10000000" }],
  };

  it("emits no full G-address at info level", async () => {
    await request(buildApp()).post("/api/jobs/create-job-draft").send(body).expect(200);

    const out = infoOutput();
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toMatch(FULL_G_RE);
  });

  it("emits masked forms for all three participant addresses at info level", async () => {
    await request(buildApp()).post("/api/jobs/create-job-draft").send(body).expect(200);

    const out = infoOutput();
    expect(out).toContain(maskOf(G_CLIENT));
    expect(out).toContain(maskOf(G_FREELANCER));
    expect(out).toContain(maskOf(G_ARBITER));
  });

  it("still emits full addresses at debug level", async () => {
    await request(buildApp()).post("/api/jobs/create-job-draft").send(body).expect(200);

    const dbg = debugOutput();
    expect(dbg).toContain(G_CLIENT);
    expect(dbg).toContain(G_FREELANCER);
    expect(dbg).toContain(G_ARBITER);
  });
});

describe("GET /api/jobs/:contractId – info-level address privacy", () => {
  it("emits no full G-address at info level", async () => {
    await request(buildApp()).get(`/api/jobs/${C_TOKEN}`).expect(200);

    const out = infoOutput();
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toMatch(FULL_G_RE);
  });

  it("emits masked forms for client, freelancer, and arbiter at info level", async () => {
    await request(buildApp()).get(`/api/jobs/${C_TOKEN}`).expect(200);

    const out = infoOutput();
    expect(out).toContain(maskOf(G_CLIENT));
    expect(out).toContain(maskOf(G_FREELANCER));
    expect(out).toContain(maskOf(G_ARBITER));
  });

  it("still emits full addresses at debug level", async () => {
    await request(buildApp()).get(`/api/jobs/${C_TOKEN}`).expect(200);

    const dbg = debugOutput();
    expect(dbg).toContain(G_CLIENT);
    expect(dbg).toContain(G_FREELANCER);
    expect(dbg).toContain(G_ARBITER);
  });
});
