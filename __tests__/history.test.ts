import Database from "better-sqlite3";
import request from "supertest";
import express from "express";
import {
  initSchema,
  insertEvent,
  setDb,
  getEventsByContract,
} from "../src/indexer/db.js";

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
// Unit tests: getEventsByContract()
// ---------------------------------------------------------------------------

describe("getEventsByContract() – unit", () => {
  const CONTRACT_A = "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";

  it("returns empty result when no events exist for contract", () => {
    const result = getEventsByContract("CUNKNOWN");
    expect(result.total).toBe(0);
    expect(result.events).toHaveLength(0);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(10);
  });

  it("returns a single event for a contract", () => {
    insertEvent(CONTRACT_A, "initialized", 100, 1000, JSON.stringify({ client: "GCLIENT" }));

    const result = getEventsByContract(CONTRACT_A);
    expect(result.total).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].event_type).toBe("initialized");
    expect(result.events[0].ledger_sequence).toBe(100);
    expect(result.events[0].timestamp).toBe(1000);
  });

  it("returns multiple events in chronological order", () => {
    insertEvent(CONTRACT_A, "initialized", 100, 1000, JSON.stringify({ client: "GCLIENT" }));
    insertEvent(CONTRACT_A, "funded", 200, 2000, JSON.stringify({ client: "GCLIENT" }));
    insertEvent(CONTRACT_A, "approved", 300, 3000, JSON.stringify({ client: "GCLIENT" }));

    const result = getEventsByContract(CONTRACT_A);
    expect(result.total).toBe(3);
    expect(result.events.map((e: any) => e.event_type)).toEqual([
      "initialized",
      "funded",
      "approved",
    ]);
    expect(result.events.map((e: any) => e.ledger_sequence)).toEqual([100, 200, 300]);
  });

  it("does not return events from other contracts", () => {
    const CONTRACT_B = "CB3D5K7UXYZ123456789012345678901234567890123456789012345678902";
    insertEvent(CONTRACT_A, "initialized", 100, 1000, JSON.stringify({ client: "GCLIENT" }));
    insertEvent(CONTRACT_B, "initialized", 200, 2000, JSON.stringify({ client: "GCLIENT2" }));

    const resultA = getEventsByContract(CONTRACT_A);
    expect(resultA.total).toBe(1);

    const resultB = getEventsByContract(CONTRACT_B);
    expect(resultB.total).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------

  function seedFiveEvents() {
    for (let i = 1; i <= 5; i++) {
      insertEvent(CONTRACT_A, `event${i}`, i * 10, i * 100, JSON.stringify({ i }));
    }
  }

  it("pagination: page=1 limit=2 returns first 2 of 5 events", () => {
    seedFiveEvents();

    const p1 = getEventsByContract(CONTRACT_A, 1, 2);
    expect(p1.total).toBe(5);
    expect(p1.events).toHaveLength(2);
    expect(p1.events[0].event_type).toBe("event1");
    expect(p1.events[1].event_type).toBe("event2");
    expect(p1.page).toBe(1);
    expect(p1.limit).toBe(2);
  });

  it("pagination: page=2 limit=2 returns events 3-4 of 5", () => {
    seedFiveEvents();

    const p2 = getEventsByContract(CONTRACT_A, 2, 2);
    expect(p2.total).toBe(5);
    expect(p2.events).toHaveLength(2);
    expect(p2.events[0].event_type).toBe("event3");
    expect(p2.events[1].event_type).toBe("event4");
    expect(p2.page).toBe(2);
  });

  it("pagination: last page returns remaining events", () => {
    seedFiveEvents();

    const p3 = getEventsByContract(CONTRACT_A, 3, 2);
    expect(p3.total).toBe(5);
    expect(p3.events).toHaveLength(1);
    expect(p3.events[0].event_type).toBe("event5");
  });

  it("pagination: page beyond total returns empty events array", () => {
    seedFiveEvents();

    const p = getEventsByContract(CONTRACT_A, 99, 10);
    expect(p.total).toBe(5);
    expect(p.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// HTTP integration tests: GET /api/jobs/:contractId/history
// ---------------------------------------------------------------------------

describe("GET /api/jobs/:contractId/history – HTTP", () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: router } = await import("../src/routes/jobs.js");
    app = express();
    app.use(express.json());
    app.use("/api/jobs", router);
  });

  it("returns success:true with events array and pagination fields", async () => {
    const cid = "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";
    insertEvent(cid, "initialized", 1, 100, JSON.stringify({ client: "GCLIENT" }));

    const res = await request(app)
      .get(`/api/jobs/${cid}/history`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].event_type).toBe("initialized");
    expect(res.body.total).toBeDefined();
    expect(res.body.page).toBeDefined();
    expect(res.body.limit).toBeDefined();
  });

  it("returns empty events array for unknown contract", async () => {
    const res = await request(app)
      .get("/api/jobs/CUNKNOWNXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX/history")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.events).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it("returns events in chronological order", async () => {
    const cid = "CA3D5K7UXYZ123456789012345678901234567890123456789012345678902";
    insertEvent(cid, "initialized", 10, 1000, JSON.stringify({ client: "GCLIENT" }));
    insertEvent(cid, "funded", 20, 2000, JSON.stringify({ client: "GCLIENT" }));
    insertEvent(cid, "approved", 30, 3000, JSON.stringify({ client: "GCLIENT" }));

    const res = await request(app)
      .get(`/api/jobs/${cid}/history`)
      .expect(200);

    expect(res.body.events).toHaveLength(3);
    expect(res.body.events.map((e: any) => e.event_type)).toEqual([
      "initialized",
      "funded",
      "approved",
    ]);
  });

  it("respects ?page=1&limit=2 query params", async () => {
    const cid = "CA3D5K7UXYZ123456789012345678901234567890123456789012345678903";
    for (let i = 1; i <= 4; i++) {
      insertEvent(cid, `event${i}`, i, i * 100, JSON.stringify({ i }));
    }

    const res = await request(app)
      .get(`/api/jobs/${cid}/history?page=1&limit=2`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.total).toBe(4);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(2);
  });

  it("each event entry has the expected shape", async () => {
    const cid = "CA3D5K7UXYZ123456789012345678901234567890123456789012345678904";
    insertEvent(cid, "funded", 50, 5000, JSON.stringify({ client: "GCLIENT" }));

    const res = await request(app)
      .get(`/api/jobs/${cid}/history`)
      .expect(200);

    const event = res.body.events[0];
    expect(event).toMatchObject({
      id: expect.any(Number),
      contract_id: expect.any(String),
      event_type: expect.any(String),
      ledger_sequence: expect.any(Number),
      timestamp: expect.any(Number),
      data_json: expect.any(String),
      created_at: expect.any(String),
    });
  });
});
