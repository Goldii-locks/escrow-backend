import Database from "better-sqlite3";
import {
  setDb,
  runMigrations,
  closeDb,
  getShippedMigrationVersions,
} from "../src/indexer/db.js";
import {
  WriterPoolSchemaError,
  assertWriterPoolSchemaReady,
  clearMigrationVerificationHooks,
  createSqlOperation,
  flushWriteQueue,
  getMigrationVerificationHookNames,
  getWriterPoolSchemaReport,
  isWriterPoolStarted,
  queueWrite,
  registerMigrationVerificationHook,
  resetWriterPoolStartState,
  startWriterPool,
  stopWriterPool,
  unregisterMigrationVerificationHook,
  verifyWriterPoolSchema,
} from "../src/indexer/database-writer-pool.js";

describe("database_writer_pool – migration verification hooks (#331)", () => {
  let testDb: Database.Database;

  beforeEach(async () => {
    testDb = new Database(":memory:");
    setDb(testDb);
    runMigrations();
    resetWriterPoolStartState();
    await flushWriteQueue();
  });

  afterEach(async () => {
    await flushWriteQueue();
    resetWriterPoolStartState();
    closeDb();
  });

  describe("verifyWriterPoolSchema", () => {
    it("reports a fully migrated database as valid", () => {
      const report = verifyWriterPoolSchema();

      expect(report.valid).toBe(true);
      expect(report.issues).toEqual([]);
      expect(report.missingVersions).toEqual([]);
      expect(report.appliedVersions).toEqual(
        expect.arrayContaining([1, 2, 3, 4, 5, 6, 7]),
      );
    });

    it("reports a missing migrations table", () => {
      testDb.exec("DROP TABLE schema_migrations");

      const report = verifyWriterPoolSchema();

      expect(report.valid).toBe(false);
      expect(report.issues.join(" ")).toContain("schema_migrations");
      expect(report.missingVersions.length).toBeGreaterThan(0);
    });

    it("reports migrations the database has not applied", () => {
      testDb.prepare("DELETE FROM schema_migrations WHERE version >= 5").run();

      const report = verifyWriterPoolSchema();

      expect(report.valid).toBe(false);
      // Derived from the shipped list rather than hardcoded, so adding a
      // migration does not require editing this expectation.
      const expectedMissing = getShippedMigrationVersions().filter((v) => v >= 5);
      expect(report.missingVersions).toEqual(expectedMissing);
      expect(report.issues.join(" ")).toContain("out of sync");
    });

    it("reports a missing table", () => {
      testDb.exec("DROP TABLE monitored_contracts");

      const report = verifyWriterPoolSchema();

      expect(report.valid).toBe(false);
      expect(report.issues.join(" ")).toContain("missing table: monitored_contracts");
    });

    it("reports missing columns on an altered table", () => {
      testDb.exec("DROP TABLE events");
      testDb.exec(
        "CREATE TABLE events (id INTEGER PRIMARY KEY, contract_id TEXT NOT NULL)",
      );

      const report = verifyWriterPoolSchema();

      expect(report.valid).toBe(false);
      expect(report.issues.join(" ")).toContain("missing columns in events");
    });
  });

  describe("assertWriterPoolSchemaReady", () => {
    it("returns the report when the schema is in sync", () => {
      expect(assertWriterPoolSchemaReady().valid).toBe(true);
    });

    it("throws WriterPoolSchemaError carrying the issues", () => {
      testDb.exec("DROP TABLE indexer_state");

      let thrown: unknown;
      try {
        assertWriterPoolSchemaReady();
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(WriterPoolSchemaError);
      expect((thrown as WriterPoolSchemaError).issues.length).toBeGreaterThan(0);
      expect((thrown as Error).message).toContain("out of sync");
    });
  });

  describe("startWriterPool", () => {
    it("starts against a fully migrated database", () => {
      const report = startWriterPool();

      expect(report.valid).toBe(true);
      expect(isWriterPoolStarted()).toBe(true);
      expect(getWriterPoolSchemaReport()?.valid).toBe(true);
    });

    it("fails to start when the database state is out of sync", () => {
      testDb.prepare("DELETE FROM schema_migrations WHERE version = 6").run();

      expect(() => startWriterPool()).toThrow(WriterPoolSchemaError);
      expect(isWriterPoolStarted()).toBe(false);
    });

    it("fails to start when the migrations table is missing entirely", () => {
      testDb.exec("DROP TABLE schema_migrations");

      expect(() => startWriterPool()).toThrow(/out of sync/);
      expect(isWriterPoolStarted()).toBe(false);
    });

    it("fails to start when a required table was dropped", () => {
      testDb.exec("DROP TABLE events");

      expect(() => startWriterPool()).toThrow(WriterPoolSchemaError);
      expect(isWriterPoolStarted()).toBe(false);
    });

    it("records the failing issues on the last report", () => {
      testDb.exec("DROP TABLE indexer_state");

      expect(() => startWriterPool()).toThrow();

      const report = getWriterPoolSchemaReport();
      expect(report?.valid).toBe(false);
      expect(report?.issues.join(" ")).toContain("indexer_state");
    });

    it("starts successfully once the missing migration is applied", () => {
      testDb.prepare("DELETE FROM schema_migrations WHERE version = 6").run();
      expect(() => startWriterPool()).toThrow();

      runMigrations();

      expect(startWriterPool().valid).toBe(true);
      expect(isWriterPoolStarted()).toBe(true);
    });

    it("stopWriterPool clears the started flag", () => {
      startWriterPool();
      stopWriterPool();

      expect(isWriterPoolStarted()).toBe(false);
    });
  });

  describe("custom verification hooks", () => {
    afterEach(() => {
      clearMigrationVerificationHooks();
    });

    it("runs registered hooks and passes when they report nothing", () => {
      const seen: string[] = [];
      registerMigrationVerificationHook("noop", () => {
        seen.push("ran");
      });

      expect(verifyWriterPoolSchema().valid).toBe(true);
      expect(seen).toEqual(["ran"]);
    });

    it("fails the start when a hook reports an issue", () => {
      registerMigrationVerificationHook("app-table", () => "missing app table");

      expect(() => startWriterPool()).toThrow(WriterPoolSchemaError);
      expect(verifyWriterPoolSchema().issues).toContain(
        "app-table: missing app table",
      );
    });

    it("accepts an array of issues from a hook", () => {
      registerMigrationVerificationHook("multi", () => ["one", "two"]);

      const report = verifyWriterPoolSchema();

      expect(report.valid).toBe(false);
      expect(report.issues).toEqual(
        expect.arrayContaining(["multi: one", "multi: two"]),
      );
    });

    it("reports a hook that throws instead of letting it escape", () => {
      registerMigrationVerificationHook("boom", () => {
        throw new Error("hook exploded");
      });

      const report = verifyWriterPoolSchema();

      expect(report.valid).toBe(false);
      expect(report.issues.join(" ")).toContain("boom: hook threw hook exploded");
    });

    it("gives a hook access to the live database", () => {
      registerMigrationVerificationHook("row-check", (db) => {
        const row = db
          .prepare("SELECT COUNT(*) as count FROM schema_migrations")
          .get() as { count: number };
        return row.count > 0 ? [] : "no migrations recorded";
      });

      expect(verifyWriterPoolSchema().valid).toBe(true);
    });

    it("replaces a hook registered under the same name", () => {
      registerMigrationVerificationHook("dup", () => "first");
      registerMigrationVerificationHook("dup", () => "second");

      const report = verifyWriterPoolSchema();

      expect(report.issues).toContain("dup: second");
      expect(report.issues).not.toContain("dup: first");
    });

    it("unregisters and lists hooks", () => {
      registerMigrationVerificationHook("a", () => undefined);
      registerMigrationVerificationHook("b", () => undefined);

      expect(getMigrationVerificationHookNames().sort()).toEqual(["a", "b"]);
      expect(unregisterMigrationVerificationHook("a")).toBe(true);
      expect(unregisterMigrationVerificationHook("a")).toBe(false);
      expect(getMigrationVerificationHookNames()).toEqual(["b"]);

      clearMigrationVerificationHooks();
      expect(getMigrationVerificationHookNames()).toEqual([]);
    });
  });

  describe("write enforcement", () => {
    it("allows writes without a start by default, preserving existing behaviour", async () => {
      testDb.exec("CREATE TABLE IF NOT EXISTS wp_test (id INTEGER PRIMARY KEY, v TEXT)");

      const result = await queueWrite(
        createSqlOperation("insert", "INSERT INTO wp_test (v) VALUES (?)", ["a"]),
      );

      expect(result.success).toBe(true);
      expect(isWriterPoolStarted()).toBe(false);
    });

    it("refuses writes when enforcement is on and the pool was stopped", async () => {
      testDb.exec("CREATE TABLE IF NOT EXISTS wp_test (id INTEGER PRIMARY KEY, v TEXT)");
      startWriterPool({ enforce: true });
      stopWriterPool();

      await expect(
        queueWrite(
          createSqlOperation("insert", "INSERT INTO wp_test (v) VALUES (?)", ["a"]),
        ),
      ).rejects.toThrow(WriterPoolSchemaError);

      const count = testDb.prepare("SELECT COUNT(*) as c FROM wp_test").get() as any;
      expect(count.c).toBe(0);
    });

    it("accepts writes again after a successful restart", async () => {
      testDb.exec("CREATE TABLE IF NOT EXISTS wp_test (id INTEGER PRIMARY KEY, v TEXT)");
      startWriterPool({ enforce: true });
      stopWriterPool();
      startWriterPool({ enforce: true });

      const result = await queueWrite(
        createSqlOperation("insert", "INSERT INTO wp_test (v) VALUES (?)", ["b"]),
      );

      expect(result.success).toBe(true);
    });

    it("carries the schema issues into the refusal", async () => {
      testDb.exec("CREATE TABLE IF NOT EXISTS wp_test (id INTEGER PRIMARY KEY, v TEXT)");
      startWriterPool({ enforce: true });
      testDb.prepare("DELETE FROM schema_migrations WHERE version = 6").run();
      expect(() => startWriterPool({ enforce: true })).toThrow();

      await expect(
        queueWrite(
          createSqlOperation("insert", "INSERT INTO wp_test (v) VALUES (?)", ["c"]),
        ),
      ).rejects.toThrow(/refusing write/);
    });
  });
});
