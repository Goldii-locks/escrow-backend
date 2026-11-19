import Database from "better-sqlite3";
import request from "supertest";
import express from "express";
import { initSchema, setDb, insertEvent, closeDb } from "../src/indexer/db.js";
import jobRoutes from "../src/routes/jobs.js";
import { parseCsvLine } from "../src/utils/csv-serializer.js";

let testDb: Database.Database;

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
  closeDb();
});

beforeEach(() => {
  testDb.exec("DELETE FROM events");
  testDb.exec("DELETE FROM job_participants");
});

describe("GET /api/jobs/:contractId/history.csv (#959)", () => {
  it("streams CSV with expected columns and neutralises formula injection", async () => {
    const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    insertEvent(contractId, "init", 10, 1000, JSON.stringify({ client: "=EVIL", freelancer: "GFREELANCER" }), "tx1");
    insertEvent(contractId, "fund", 11, 1001, JSON.stringify({ from: "+FROM", to: "TO", amount: "123", milestone_index: 0 }), "tx2");

    const res = await request(buildApp())
      .get(`/api/jobs/${contractId}/history.csv`)
      .expect(200);

    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain(`${contractId}-history.csv`);

    const lines = res.text.trim().split(/\r?\n/);
    expect(parseCsvLine(lines[0])).toEqual([
      "ledger",
      "timestamp_utc",
      "event_type",
      "milestone_index",
      "amount",
      "amount_display",
      "from",
      "to",
      "tx_hash",
    ]);
    expect(lines.length).toBe(3);
    const row1 = parseCsvLine(lines[1]);
    const row2 = parseCsvLine(lines[2]);
    // from column (index 6) on init came from client =EVIL and must be neutralised
    expect(row1[6].startsWith("'=")).toBe(true);
    expect(row2[6].startsWith("'+")).toBe(true);
    expect(row2[4]).toBe("123");
    expect(row2[8]).toBe("tx2");
  });
});
