import Database from "better-sqlite3";
import { runMigrations, setDb } from "../src/indexer/db.js";
import {
  VACUUM_CLEANER_INDEXES,
  getVacuumIndexNames,
  ensureVacuumIndexes,
  vacuumExplainQueryPlan,
  vacuumQueryPlanUsesIndex,
} from "../src/indexer/sqlite_vacuum_cleaner.js";

describe("sqlite_vacuum_cleaner – SQLite index structures (#344)", () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(":memory:");
    setDb(db);
    runMigrations();
  });

  afterAll(() => {
    db.close();
  });

  beforeEach(() => {
    db.exec("DELETE FROM events");
    seedEvents();
  });

  /** Seed enough rows that the planner prefers an index scan over a full scan. */
  function seedEvents(): void {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO events
         (contract_id, event_type, ledger_sequence, timestamp, data_json, created_at)
       VALUES (?, 'funded', ?, ?, '{}', ?)`,
    );
    const now = Date.now();
    for (let i = 0; i < 300; i++) {
      const createdDaysAgo = (i % 300);
      insert.run(
        `C${i % 10}`,
        1000 + i,
        1_700_000_000 + i,
        new Date(now - createdDaysAgo * 86_400_000).toISOString(),
      );
    }
  }

  it("migration 6 creates all vacuum cleaner lookup indexes", () => {
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name IN (${getVacuumIndexNames()
           .map(() => "?")
           .join(", ")})`,
      )
      .all(...getVacuumIndexNames()) as Array<{ name: string }>;
    const names = rows.map((r) => r.name);

    for (const indexName of getVacuumIndexNames()) {
      expect(names).toContain(indexName);
    }
  });

  it("ensureVacuumIndexes is idempotent and returns every managed index", () => {
    const first = ensureVacuumIndexes(db);
    expect(first).toEqual(getVacuumIndexNames());

    const second = ensureVacuumIndexes(db);
    expect(second).toEqual(getVacuumIndexNames());
    expect(second).toEqual(expect.arrayContaining(first));
  });

  it("retention-time lookups (created_at) use the vacuum cleaner index", () => {
    // Mirror pruneOldEvents' predicate (DELETE ... WHERE created_at < now-N).
    const deletePlan = vacuumExplainQueryPlan(
      db,
      `DELETE FROM events WHERE created_at < datetime('now', ?)`,
      "-90 days",
    );
    expect(
      vacuumQueryPlanUsesIndex(deletePlan, VACUUM_CLEANER_INDEXES.eventsCreatedAt),
    ).toBe(true);

    // SELECT-form of the same lookup also resolves through a managed index.
    const selectPlan = vacuumExplainQueryPlan(
      db,
      `SELECT * FROM events WHERE created_at < datetime('now', ?)`,
      "-90 days",
    );
    const used = getVacuumIndexNames().some((name) =>
      vacuumQueryPlanUsesIndex(selectPlan, name),
    );
    expect(used).toBe(true);
  });

  it("ledger-range lookups use the vacuum cleaner index", () => {
    // Mirror pruneEventsInLedgerRange's predicate (ledger_sequence BETWEEN).
    const deletePlan = vacuumExplainQueryPlan(
      db,
      `DELETE FROM events WHERE ledger_sequence >= ? AND ledger_sequence <= ?`,
      1005,
      1020,
    );
    expect(
      vacuumQueryPlanUsesIndex(
        deletePlan,
        VACUUM_CLEANER_INDEXES.eventsLedgerSequence,
      ),
    ).toBe(true);

    const selectPlan = vacuumExplainQueryPlan(
      db,
      `SELECT * FROM events WHERE ledger_sequence >= ? AND ledger_sequence <= ?`,
      1005,
      1020,
    );
    const used = getVacuumIndexNames().some((name) =>
      vacuumQueryPlanUsesIndex(selectPlan, name),
    );
    expect(used).toBe(true);
  });

  it("asserts the combined retention + range pruning lookup uses a managed index", () => {
    const plan = vacuumExplainQueryPlan(
      db,
      `SELECT ledger_sequence FROM events
       WHERE created_at < datetime('now', ?) AND ledger_sequence >= ?`,
      "-30 days",
      1000,
    );
    const used = getVacuumIndexNames().some((name) =>
      vacuumQueryPlanUsesIndex(plan, name),
    );
    expect(used).toBe(true);
  });

  it("vacuumQueryPlanUsesIndex is false when no managed index is referenced", () => {
    const plan = [{ detail: "SCAN events" }];
    expect(vacuumQueryPlanUsesIndex(plan, VACUUM_CLEANER_INDEXES.eventsCreatedAt)).toBe(
      false,
    );
    expect(vacuumQueryPlanUsesIndex(plan, "idx_events_created_at_write_test")).toBe(
      false,
    );
  });
});