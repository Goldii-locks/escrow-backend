import Database from "better-sqlite3";
import {
  setDb,
  runMigrations,
  verifySchemaIntegrity,
  assertSchemaValid,
} from "../src/indexer/db.js";

describe("Schema Verification Hooks (#264)", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
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

  describe("verifySchemaIntegrity", () => {
    it("returns valid when all expected tables and columns exist", () => {
      const result = verifySchemaIntegrity();
      expect(result.valid).toBe(true);
      expect(result.missingTables).toHaveLength(0);
      expect(result.missingColumns).toEqual({});
      expect(result.migrationVersionGap).toBe(false);
      expect(result.errors).toHaveLength(0);
    });

    it("detects missing table", () => {
      testDb.exec("DROP TABLE IF EXISTS events");
      const result = verifySchemaIntegrity();
      expect(result.valid).toBe(false);
      expect(result.missingTables).toContain("events");
    });

    it("detects missing column in events table", () => {
      testDb.exec("DROP TABLE events");
      testDb.exec(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contract_id TEXT NOT NULL
        )
      `);
      const result = verifySchemaIntegrity();
      expect(result.valid).toBe(false);
      expect(result.missingColumns).toHaveProperty("events");
      expect(result.missingColumns.events).toContain("event_type");
      expect(result.missingColumns.events).toContain("ledger_sequence");
    });

    it("detects missing column in indexer_state table", () => {
      testDb.exec("DROP TABLE indexer_state");
      testDb.exec(`
        CREATE TABLE indexer_state (
          key TEXT PRIMARY KEY
        )
      `);
      const result = verifySchemaIntegrity();
      expect(result.valid).toBe(false);
      expect(result.missingColumns).toHaveProperty("indexer_state");
      expect(result.missingColumns.indexer_state).toContain("value");
    });

    it("detects missing monitored_contracts table", () => {
      testDb.exec("DROP TABLE IF EXISTS monitored_contracts");
      const result = verifySchemaIntegrity();
      expect(result.valid).toBe(false);
      expect(result.missingTables).toContain("monitored_contracts");
    });

    it("detects missing schema_migrations table", () => {
      testDb.exec("DROP TABLE IF EXISTS schema_migrations");
      const result = verifySchemaIntegrity();
      expect(result.valid).toBe(false);
      expect(result.missingTables).toContain("schema_migrations");
    });

    it("reports multiple missing tables", () => {
      testDb.exec("DROP TABLE IF EXISTS events");
      testDb.exec("DROP TABLE IF EXISTS monitored_contracts");
      const result = verifySchemaIntegrity();
      expect(result.valid).toBe(false);
      expect(result.missingTables).toContain("events");
      expect(result.missingTables).toContain("monitored_contracts");
    });
  });

  describe("assertSchemaValid", () => {
    it("does not throw when schema is valid", () => {
      expect(() => assertSchemaValid()).not.toThrow();
    });

    it("throws when a required table is missing", () => {
      testDb.exec("DROP TABLE IF EXISTS events");
      expect(() => assertSchemaValid()).toThrow("Schema verification failed");
      expect(() => assertSchemaValid()).toThrow("missing table: events");
    });

    it("throws when columns are missing", () => {
      testDb.exec("DROP TABLE events");
      testDb.exec(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT
        )
      `);
      expect(() => assertSchemaValid()).toThrow("Schema verification failed");
    });
  });
});
