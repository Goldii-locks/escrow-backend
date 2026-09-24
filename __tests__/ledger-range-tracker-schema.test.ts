/**
 * Issue #300 — Migration verification hooks for ledger_range_tracker
 *
 * Verifies that verifyLedgerRangeTrackerSchema() and
 * assertLedgerRangeTrackerSchemaValid() detect missing tables, missing
 * columns, and schema gaps before the tracker is allowed to start.
 */

import Database from "better-sqlite3";
import { setDb, runMigrations } from "../src/indexer/db.js";
import {
  verifyLedgerRangeTrackerSchema,
  assertLedgerRangeTrackerSchemaValid,
} from "../src/indexer/ledger-range-tracker.js";

describe("LedgerRangeTracker — migration verification hooks (#300)", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
  });

  afterAll(() => {
    testDb.close();
  });

  /** Reset and optionally re-run migrations before each test. */
  function freshSchema() {
    testDb.exec("DROP TABLE IF EXISTS events");
    testDb.exec("DROP TABLE IF EXISTS indexer_state");
    testDb.exec("DROP TABLE IF EXISTS monitored_contracts");
    testDb.exec("DROP TABLE IF EXISTS schema_migrations");
    testDb.exec("DROP TABLE IF EXISTS webhook_subscriptions");
    runMigrations();
  }

  // -------------------------------------------------------------------------
  // 1. Correct schema → tracker starts successfully
  // -------------------------------------------------------------------------

  describe("valid schema", () => {
    beforeEach(() => freshSchema());

    it("verifyLedgerRangeTrackerSchema returns valid=true after full migrations", () => {
      const result = verifyLedgerRangeTrackerSchema();
      expect(result.valid).toBe(true);
      expect(result.missingTables).toHaveLength(0);
      expect(result.missingColumns).toEqual({});
      expect(result.errors).toHaveLength(0);
    });

    it("assertLedgerRangeTrackerSchemaValid does not throw with valid schema", () => {
      expect(() => assertLedgerRangeTrackerSchemaValid()).not.toThrow();
    });

    it("re-running migrations does not break the schema check", () => {
      runMigrations(); // idempotent call
      const result = verifyLedgerRangeTrackerSchema();
      expect(result.valid).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Missing required table → startup fails
  // -------------------------------------------------------------------------

  describe("missing required tables", () => {
    it("reports missing 'events' table", () => {
      freshSchema();
      testDb.exec("DROP TABLE IF EXISTS events");

      const result = verifyLedgerRangeTrackerSchema();
      expect(result.valid).toBe(false);
      expect(result.missingTables).toContain("events");
    });

    it("reports missing 'indexer_state' table", () => {
      freshSchema();
      testDb.exec("DROP TABLE IF EXISTS indexer_state");

      const result = verifyLedgerRangeTrackerSchema();
      expect(result.valid).toBe(false);
      expect(result.missingTables).toContain("indexer_state");
    });

    it("assertLedgerRangeTrackerSchemaValid throws when 'events' is missing", () => {
      freshSchema();
      testDb.exec("DROP TABLE IF EXISTS events");

      expect(() => assertLedgerRangeTrackerSchemaValid()).toThrow(
        /missing table: events/
      );
    });

    it("assertLedgerRangeTrackerSchemaValid throws when 'indexer_state' is missing", () => {
      freshSchema();
      testDb.exec("DROP TABLE IF EXISTS indexer_state");

      expect(() => assertLedgerRangeTrackerSchemaValid()).toThrow(
        /missing table: indexer_state/
      );
    });

    it("error message names all missing tables when multiple are absent", () => {
      freshSchema();
      testDb.exec("DROP TABLE IF EXISTS events");
      testDb.exec("DROP TABLE IF EXISTS indexer_state");

      expect(() => assertLedgerRangeTrackerSchemaValid()).toThrow(
        /missing table/
      );

      const result = verifyLedgerRangeTrackerSchema();
      expect(result.missingTables).toContain("events");
      expect(result.missingTables).toContain("indexer_state");
    });
  });

  // -------------------------------------------------------------------------
  // 3. Missing required column → startup fails
  // -------------------------------------------------------------------------

  describe("missing required columns", () => {
    it("detects missing 'ledger_sequence' column in events", () => {
      freshSchema();

      // Recreate events table without the ledger_sequence column
      testDb.exec("DROP TABLE events");
      testDb.exec(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contract_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          data_json TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      const result = verifyLedgerRangeTrackerSchema();
      expect(result.valid).toBe(false);
      expect(result.missingColumns["events"]).toContain("ledger_sequence");
    });

    it("detects missing 'contract_id' column in events", () => {
      freshSchema();

      testDb.exec("DROP TABLE events");
      testDb.exec(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          ledger_sequence INTEGER NOT NULL,
          timestamp INTEGER NOT NULL,
          data_json TEXT NOT NULL
        )
      `);

      const result = verifyLedgerRangeTrackerSchema();
      expect(result.valid).toBe(false);
      expect(result.missingColumns["events"]).toContain("contract_id");
    });

    it("detects missing 'value' column in indexer_state", () => {
      freshSchema();

      testDb.exec("DROP TABLE indexer_state");
      testDb.exec("CREATE TABLE indexer_state (key TEXT PRIMARY KEY)");

      const result = verifyLedgerRangeTrackerSchema();
      expect(result.valid).toBe(false);
      expect(result.missingColumns["indexer_state"]).toContain("value");
    });

    it("assertLedgerRangeTrackerSchemaValid throws with column detail in message", () => {
      freshSchema();

      testDb.exec("DROP TABLE events");
      testDb.exec(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contract_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          data_json TEXT NOT NULL
        )
      `);

      expect(() => assertLedgerRangeTrackerSchemaValid()).toThrow(
        /missing columns in events.*ledger_sequence/
      );
    });

    it("reports multiple missing columns in the same table", () => {
      freshSchema();

      testDb.exec("DROP TABLE events");
      testDb.exec(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL
        )
      `);

      const result = verifyLedgerRangeTrackerSchema();
      expect(result.valid).toBe(false);

      const missing = result.missingColumns["events"];
      expect(missing).toContain("contract_id");
      expect(missing).toContain("event_type");
      expect(missing).toContain("ledger_sequence");
      expect(missing).toContain("data_json");
    });
  });

  // -------------------------------------------------------------------------
  // 4. Incompatible / out-of-sync schema → startup fails
  // -------------------------------------------------------------------------

  describe("incompatible schema", () => {
    it("detects migration version gap and reports it as an error", () => {
      freshSchema();

      // Delete migration version 2 to simulate a gap between 1 and 3
      testDb.exec("DELETE FROM schema_migrations WHERE version = 2");

      const result = verifyLedgerRangeTrackerSchema();
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /gap/i.test(e))).toBe(true);
    });

    it("assertLedgerRangeTrackerSchemaValid throws on migration version gap", () => {
      freshSchema();
      testDb.exec("DELETE FROM schema_migrations WHERE version = 2");

      expect(() => assertLedgerRangeTrackerSchemaValid()).toThrow(
        /gap|migration/i
      );
    });

    it("an entirely empty database fails schema check", () => {
      // Drop everything — fully empty state
      testDb.exec("DROP TABLE IF EXISTS events");
      testDb.exec("DROP TABLE IF EXISTS indexer_state");
      testDb.exec("DROP TABLE IF EXISTS monitored_contracts");
      testDb.exec("DROP TABLE IF EXISTS schema_migrations");
      testDb.exec("DROP TABLE IF EXISTS webhook_subscriptions");

      const result = verifyLedgerRangeTrackerSchema();
      expect(result.valid).toBe(false);
      expect(result.missingTables.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Error messages are understandable
  // -------------------------------------------------------------------------

  describe("error message quality", () => {
    beforeEach(() => freshSchema());

    it("error message from assertLedgerRangeTrackerSchemaValid identifies the failed component", () => {
      testDb.exec("DROP TABLE IF EXISTS events");

      let caught: Error | undefined;
      try {
        assertLedgerRangeTrackerSchemaValid();
      } catch (e) {
        caught = e as Error;
      }

      expect(caught).toBeDefined();
      expect(caught!.message).toMatch(/LedgerRangeTracker schema verification failed/);
      expect(caught!.message).toMatch(/events/);
    });

    it("error message includes 'cannot start' to make the severity clear", () => {
      testDb.exec("DROP TABLE IF EXISTS indexer_state");

      expect(() => assertLedgerRangeTrackerSchemaValid()).toThrow(/cannot start/);
    });

    it("result object from verifyLedgerRangeTrackerSchema contains actionable details", () => {
      testDb.exec("DROP TABLE events");
      testDb.exec(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          data_json TEXT NOT NULL
        )
      `);

      const result = verifyLedgerRangeTrackerSchema();
      expect(result.valid).toBe(false);
      // Should tell caller exactly which columns are missing
      expect(Array.isArray(result.missingColumns["events"])).toBe(true);
      expect(result.missingColumns["events"].length).toBeGreaterThan(0);
    });
  });
});
