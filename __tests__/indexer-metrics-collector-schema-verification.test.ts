import Database from "better-sqlite3";
import {
  setDb,
  runMigrations,
  closeDb,
} from "../src/indexer/db.js";
import {
  validateIndexerMetricsSchema,
  assertIndexerMetricsSchemaValid,
} from "../src/indexer/indexer_metrics_collector.js";

describe("indexer_metrics_collector – migration verification hooks (#340)", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
    runMigrations();
  });

  afterAll(() => {
    testDb.close();
  });

  beforeEach(() => {
    testDb.exec("DROP TABLE IF EXISTS events");
    testDb.exec("DROP TABLE IF EXISTS indexer_state");
    testDb.exec("DROP TABLE IF EXISTS monitored_contracts");
    testDb.exec("DROP TABLE IF EXISTS schema_migrations");
    testDb.exec("DROP TABLE IF EXISTS webhook_subscriptions");
    runMigrations();
  });

  // -------------------------------------------------------------------------
  // validateIndexerMetricsSchema
  // -------------------------------------------------------------------------

  describe("validateIndexerMetricsSchema", () => {
    it("returns valid when all required tables and columns exist after migrations", () => {
      const result = validateIndexerMetricsSchema(testDb);
      expect(result.valid).toBe(true);
      expect(result.missingTables).toHaveLength(0);
      expect(Object.keys(result.missingColumns)).toHaveLength(0);
      expect(result.missingMigrations).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it("detects a missing events table", () => {
      testDb.exec("DROP TABLE IF EXISTS events");

      const result = validateIndexerMetricsSchema(testDb);
      expect(result.valid).toBe(false);
      expect(result.missingTables).toContain("events");
    });

    it("detects a missing indexer_state table", () => {
      testDb.exec("DROP TABLE IF EXISTS indexer_state");

      const result = validateIndexerMetricsSchema(testDb);
      expect(result.valid).toBe(false);
      expect(result.missingTables).toContain("indexer_state");
    });

    it("detects a missing schema_migrations table", () => {
      testDb.exec("DROP TABLE IF EXISTS schema_migrations");

      const result = validateIndexerMetricsSchema(testDb);
      expect(result.valid).toBe(false);
      expect(result.missingTables).toContain("schema_migrations");
    });

    it("detects missing columns in the events table", () => {
      testDb.exec("DROP TABLE events");
      testDb.exec(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contract_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          ledger_sequence INTEGER NOT NULL,
          timestamp INTEGER NOT NULL,
          data_json TEXT NOT NULL
        );
      `);

      const result = validateIndexerMetricsSchema(testDb);
      expect(result.valid).toBe(false);
      expect(result.missingColumns["events"]).toContain("created_at");
    });

    it("detects missing columns in the indexer_state table", () => {
      testDb.exec("DROP TABLE indexer_state");
      testDb.exec(`
        CREATE TABLE indexer_state (
          key TEXT PRIMARY KEY
        );
      `);

      const result = validateIndexerMetricsSchema(testDb);
      expect(result.valid).toBe(false);
      expect(result.missingColumns["indexer_state"]).toContain("value");
    });

    it("detects missing applied migrations", () => {
      testDb.exec("DELETE FROM schema_migrations");

      const result = validateIndexerMetricsSchema(testDb);
      expect(result.valid).toBe(false);
      expect(result.missingMigrations.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes("Missing applied migrations"))).toBe(true);
    });

    it("reports all problems at once (tables, columns, migrations)", () => {
      testDb.exec("DROP TABLE IF EXISTS events");
      testDb.exec("DROP TABLE IF EXISTS indexer_state");
      testDb.exec("DELETE FROM schema_migrations");

      const result = validateIndexerMetricsSchema(testDb);
      expect(result.valid).toBe(false);
      expect(result.missingTables).toContain("events");
      expect(result.missingTables).toContain("indexer_state");
      expect(result.missingMigrations.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // assertIndexerMetricsSchemaValid
  // -------------------------------------------------------------------------

  describe("assertIndexerMetricsSchemaValid", () => {
    it("does not throw when schema is valid", () => {
      expect(() => assertIndexerMetricsSchemaValid(testDb)).not.toThrow();
    });

    it("throws with a descriptive message when a table is missing", () => {
      testDb.exec("DROP TABLE IF EXISTS events");

      expect(() => assertIndexerMetricsSchemaValid(testDb)).toThrow(
        /database schema is out of sync/i,
      );
      expect(() => assertIndexerMetricsSchemaValid(testDb)).toThrow(
        /missing table: events/i,
      );
    });

    it("throws when columns are missing", () => {
      testDb.exec("DROP TABLE events");
      testDb.exec(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contract_id TEXT NOT NULL
        );
      `);

      expect(() => assertIndexerMetricsSchemaValid(testDb)).toThrow(
        /missing columns in events/i,
      );
      expect(() => assertIndexerMetricsSchemaValid(testDb)).toThrow(
        /event_type/,
      );
    });

    it("throws when migrations are not fully applied", () => {
      testDb.exec("DELETE FROM schema_migrations");

      expect(() => assertIndexerMetricsSchemaValid(testDb)).toThrow(
        /Missing applied migrations/i,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Start-failure validation check
  // -------------------------------------------------------------------------

  describe("start fails if database state is out of sync", () => {
    it("asserts schema valid throws before any collection when tables are missing", () => {
      const brokenDb = new Database(":memory:");
      try {
        const result = validateIndexerMetricsSchema(brokenDb);
        expect(result.valid).toBe(false);
        expect(result.missingTables).toEqual(
          expect.arrayContaining(["events", "indexer_state", "schema_migrations"]),
        );

        expect(() => assertIndexerMetricsSchemaValid(brokenDb)).toThrow();
      } finally {
        brokenDb.close();
      }
    });

    it("a partially migrated database fails the pre-start check", () => {
      // Simulate a partially migrated state: events exists but the migration
      // tracking table is gone, so the collector cannot verify migration
      // completeness.
      testDb.exec("DROP TABLE IF EXISTS schema_migrations");
      testDb.exec("DELETE FROM events");

      const result = validateIndexerMetricsSchema(testDb);
      expect(result.valid).toBe(false);
      expect(result.missingTables).toContain("schema_migrations");
    });

    it("a schema missing optional tables (monitored_contracts) is still considered invalid for required tables", () => {
      testDb.exec("DROP TABLE IF EXISTS monitored_contracts");
      testDb.exec("DROP TABLE IF EXISTS webhook_subscriptions");

      const result = validateIndexerMetricsSchema(testDb);
      // monitored_contracts and webhook_subscriptions are NOT in the required
      // schema for the metrics collector, so their absence should not affect
      // the validation result.
      expect(result.missingTables).not.toContain("monitored_contracts");
      expect(result.missingTables).not.toContain("webhook_subscriptions");
    });
  });
});
