/**
 * Task 3 — Schema Migration Pre-checks for duplicate_prevention
 *
 * Verifies that:
 * - `verifyDuplicatePreventionSchema` returns valid=true on a fully migrated DB.
 * - It detects missing required tables and missing required columns.
 * - It detects migration version gaps.
 * - `assertDuplicatePreventionSchemaValid` does not throw on a healthy schema.
 * - It throws with a descriptive message when any pre-check fails, preventing
 *   component startup against an out-of-sync database.
 */

import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import { setDb, runMigrations } from "../src/indexer/db.js";

const mockLogger = {
  info: jest.fn<(...args: unknown[]) => void>(),
  warn: jest.fn<(...args: unknown[]) => void>(),
  error: jest.fn<(...args: unknown[]) => void>(),
  debug: jest.fn<(...args: unknown[]) => void>(),
};

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: mockLogger,
}));

const {
  verifyDuplicatePreventionSchema,
  assertDuplicatePreventionSchemaValid,
} = await import("../src/indexer/duplicate-prevention.js");

describe("DuplicatePrevention — schema migration pre-checks (#Task3)", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
  });

  afterAll(() => {
    testDb.close();
  });

  function freshSchema() {
    testDb.exec("DROP TABLE IF EXISTS events");
    testDb.exec("DROP TABLE IF EXISTS indexer_state");
    testDb.exec("DROP TABLE IF EXISTS monitored_contracts");
    testDb.exec("DROP TABLE IF EXISTS schema_migrations");
    testDb.exec("DROP TABLE IF EXISTS webhook_subscriptions");
    testDb.exec("DROP TABLE IF EXISTS sync_ranges");
    runMigrations();
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── 1. Valid schema ───────────────────────────────────────────────────────

  describe("valid fully-migrated schema", () => {
    beforeEach(() => freshSchema());

    it("verifyDuplicatePreventionSchema returns valid=true after full migrations", () => {
      const report = verifyDuplicatePreventionSchema();
      expect(report.valid).toBe(true);
      expect(report.missingTables).toHaveLength(0);
      expect(report.missingColumns).toEqual({});
      expect(report.errors).toHaveLength(0);
    });

    it("assertDuplicatePreventionSchemaValid does not throw on a healthy schema", () => {
      expect(() => assertDuplicatePreventionSchemaValid()).not.toThrow();
    });

    it("re-running migrations does not invalidate the schema check (idempotent)", () => {
      runMigrations();
      const report = verifyDuplicatePreventionSchema();
      expect(report.valid).toBe(true);
    });
  });

  // ─── 2. Missing required table ────────────────────────────────────────────

  describe("missing required tables", () => {
    it("reports events table as missing", () => {
      freshSchema();
      testDb.exec("DROP TABLE IF EXISTS events");

      const report = verifyDuplicatePreventionSchema();
      expect(report.valid).toBe(false);
      expect(report.missingTables).toContain("events");
    });

    it("assertDuplicatePreventionSchemaValid throws when events table is missing", () => {
      freshSchema();
      testDb.exec("DROP TABLE IF EXISTS events");

      expect(() => assertDuplicatePreventionSchemaValid()).toThrow(
        /missing table: events/,
      );
    });

    it("error message identifies the component that cannot start", () => {
      freshSchema();
      testDb.exec("DROP TABLE IF EXISTS events");

      let caught: Error | undefined;
      try {
        assertDuplicatePreventionSchemaValid();
      } catch (e) {
        caught = e as Error;
      }

      expect(caught).toBeDefined();
      expect(caught!.message).toMatch(
        /DuplicatePrevention schema verification failed/,
      );
      expect(caught!.message).toMatch(/cannot start/);
    });
  });

  // ─── 3. Missing required columns ──────────────────────────────────────────

  describe("missing required columns in events table", () => {
    it("detects missing ledger_sequence column", () => {
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

      const report = verifyDuplicatePreventionSchema();
      expect(report.valid).toBe(false);
      expect(report.missingColumns["events"]).toContain("ledger_sequence");
    });

    it("detects missing contract_id column", () => {
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

      const report = verifyDuplicatePreventionSchema();
      expect(report.valid).toBe(false);
      expect(report.missingColumns["events"]).toContain("contract_id");
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

      const report = verifyDuplicatePreventionSchema();
      expect(report.valid).toBe(false);
      const missing = report.missingColumns["events"];
      expect(missing).toContain("contract_id");
      expect(missing).toContain("event_type");
      expect(missing).toContain("ledger_sequence");
      expect(missing).toContain("data_json");
    });

    it("assertDuplicatePreventionSchemaValid throws with column details in message", () => {
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

      expect(() => assertDuplicatePreventionSchemaValid()).toThrow(
        /missing columns in events.*ledger_sequence/,
      );
    });
  });

  // ─── 4. Migration version gaps ────────────────────────────────────────────

  describe("migration version gaps", () => {
    it("detects a gap and marks the report as invalid", () => {
      freshSchema();
      // Delete version 2 to create a gap between 1 and 3
      testDb.exec("DELETE FROM schema_migrations WHERE version = 2");

      const report = verifyDuplicatePreventionSchema();
      expect(report.valid).toBe(false);
      expect(report.errors.some((e) => /gap/i.test(e))).toBe(true);
    });

    it("assertDuplicatePreventionSchemaValid throws on a migration version gap", () => {
      freshSchema();
      testDb.exec("DELETE FROM schema_migrations WHERE version = 2");

      expect(() => assertDuplicatePreventionSchemaValid()).toThrow(
        /gap|migration/i,
      );
    });
  });

  // ─── 5. Missing schema_migrations table ───────────────────────────────────

  describe("missing schema_migrations table", () => {
    it("flags the absence of schema_migrations as an error", () => {
      freshSchema();
      testDb.exec("DROP TABLE IF EXISTS schema_migrations");

      const report = verifyDuplicatePreventionSchema();
      expect(report.valid).toBe(false);
      expect(
        report.errors.some((e) =>
          e.toLowerCase().includes("schema_migrations"),
        ),
      ).toBe(true);
    });

    it("assertDuplicatePreventionSchemaValid throws when schema_migrations is missing", () => {
      freshSchema();
      testDb.exec("DROP TABLE IF EXISTS schema_migrations");

      expect(() => assertDuplicatePreventionSchemaValid()).toThrow(
        /schema_migrations/i,
      );
    });
  });

  // ─── 6. Completely empty database ────────────────────────────────────────

  describe("completely empty database", () => {
    it("fails schema check when the database has no tables at all", () => {
      testDb.exec("DROP TABLE IF EXISTS events");
      testDb.exec("DROP TABLE IF EXISTS indexer_state");
      testDb.exec("DROP TABLE IF EXISTS monitored_contracts");
      testDb.exec("DROP TABLE IF EXISTS schema_migrations");
      testDb.exec("DROP TABLE IF EXISTS webhook_subscriptions");
      testDb.exec("DROP TABLE IF EXISTS sync_ranges");

      const report = verifyDuplicatePreventionSchema();
      expect(report.valid).toBe(false);
      expect(report.errors.length).toBeGreaterThan(0);
    });

    it("assertDuplicatePreventionSchemaValid throws on an empty database", () => {
      expect(() => assertDuplicatePreventionSchemaValid()).toThrow();
    });
  });

  // ─── 7. Error log on failure ──────────────────────────────────────────────

  describe("error logging on failure", () => {
    it("logs an error when assertDuplicatePreventionSchemaValid fails", () => {
      freshSchema();
      testDb.exec("DROP TABLE IF EXISTS events");

      try {
        assertDuplicatePreventionSchemaValid();
      } catch {
        // expected
      }

      expect(mockLogger.error).toHaveBeenCalledWith(
        "DuplicatePrevention schema verification failed",
        expect.objectContaining({
          missingTables: expect.arrayContaining(["events"]),
        }),
      );
    });

    it("does not log an error when schema is valid", () => {
      freshSchema();
      assertDuplicatePreventionSchemaValid();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });
});
