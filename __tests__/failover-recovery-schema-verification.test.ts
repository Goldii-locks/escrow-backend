import Database from "better-sqlite3";
import {
  setDb,
  runMigrations,
  closeDb,
} from "../src/indexer/db.js";
import {
  initializeNodeHealthTables,
  validateFailoverRecoverySchema,
  verifyFailoverRecoverySchema,
  assertFailoverRecoverySchemaValid,
  assertFailoverRecoverySchemaReady,
  FailoverRecoverySchemaError,
  registerFailoverRecoveryMigrationHook,
  unregisterFailoverRecoveryMigrationHook,
  clearFailoverRecoveryMigrationHooks,
  getFailoverRecoveryMigrationHookNames,
  startFailoverRecovery,
  isFailoverRecoveryStarted,
  stopFailoverRecovery,
  resetFailoverRecovery,
  getFailoverRecoverySchemaReport,
  FAILOVER_RECOVERY_REQUIRED_SCHEMA,
} from "../src/indexer/failover-recovery.js";

describe("indexer_failover_recovery – migration verification hooks (#417)", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
    runMigrations();
    initializeNodeHealthTables();
  });

  afterAll(() => {
    testDb.close();
    closeDb();
  });

  beforeEach(() => {
    resetFailoverRecovery();
    testDb.exec("PRAGMA foreign_keys = OFF");
    testDb.exec("DROP TABLE IF EXISTS node_failure_events");
    testDb.exec("DROP TABLE IF EXISTS rpc_node_health");
    testDb.exec("DROP TABLE IF EXISTS failover_state");
    testDb.exec("DROP TABLE IF EXISTS events");
    testDb.exec("DROP TABLE IF EXISTS indexer_state");
    testDb.exec("DROP TABLE IF EXISTS monitored_contracts");
    testDb.exec("DROP TABLE IF EXISTS schema_migrations");
    testDb.exec("PRAGMA foreign_keys = ON");
    runMigrations();
    initializeNodeHealthTables();
  });

  // -------------------------------------------------------------------------
  // validateFailoverRecoverySchema
  // -------------------------------------------------------------------------

  describe("validateFailoverRecoverySchema", () => {
    it("defines the expected required schema tables and columns", () => {
      expect(FAILOVER_RECOVERY_REQUIRED_SCHEMA).toHaveProperty("rpc_node_health");
      expect(FAILOVER_RECOVERY_REQUIRED_SCHEMA).toHaveProperty("failover_state");
      expect(FAILOVER_RECOVERY_REQUIRED_SCHEMA).toHaveProperty("node_failure_events");
      expect(FAILOVER_RECOVERY_REQUIRED_SCHEMA).toHaveProperty("schema_migrations");
    });

    it("returns valid when all required tables and columns exist after migrations", () => {
      const result = validateFailoverRecoverySchema(testDb);
      expect(result.valid).toBe(true);
      expect(result.missingTables).toHaveLength(0);
      expect(Object.keys(result.missingColumns)).toHaveLength(0);
      expect(result.missingMigrations).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      expect(result.issues).toHaveLength(0);
    });

    it("verifyFailoverRecoverySchema alias works identically", () => {
      const result = verifyFailoverRecoverySchema(testDb);
      expect(result.valid).toBe(true);
    });

    it("detects missing rpc_node_health table", () => {
      testDb.exec("DROP TABLE IF EXISTS rpc_node_health");

      const result = validateFailoverRecoverySchema(testDb);
      expect(result.valid).toBe(false);
      expect(result.missingTables).toContain("rpc_node_health");
      expect(result.errors.some((e) => e.includes("rpc_node_health"))).toBe(true);
    });

    it("detects missing failover_state table", () => {
      testDb.exec("DROP TABLE IF EXISTS failover_state");

      const result = validateFailoverRecoverySchema(testDb);
      expect(result.valid).toBe(false);
      expect(result.missingTables).toContain("failover_state");
    });

    it("detects missing node_failure_events table", () => {
      testDb.exec("DROP TABLE IF EXISTS node_failure_events");

      const result = validateFailoverRecoverySchema(testDb);
      expect(result.valid).toBe(false);
      expect(result.missingTables).toContain("node_failure_events");
    });

    it("detects missing schema_migrations table", () => {
      testDb.exec("DROP TABLE IF EXISTS schema_migrations");

      const result = validateFailoverRecoverySchema(testDb);
      expect(result.valid).toBe(false);
      expect(result.missingTables).toContain("schema_migrations");
    });

    it("detects missing columns in rpc_node_health", () => {
      testDb.exec("DROP TABLE rpc_node_health");
      testDb.exec(`
        CREATE TABLE rpc_node_health (
          node_url TEXT PRIMARY KEY,
          is_healthy INTEGER NOT NULL DEFAULT 1
        );
      `);

      const result = validateFailoverRecoverySchema(testDb);
      expect(result.valid).toBe(false);
      expect(result.missingColumns["rpc_node_health"]).toContain("failure_count");
      expect(result.missingColumns["rpc_node_health"]).toContain("backoff_duration_ms");
      expect(result.missingColumns["rpc_node_health"]).toContain("consecutive_successes");
    });

    it("detects missing columns in failover_state", () => {
      testDb.exec("DROP TABLE failover_state");
      testDb.exec(`
        CREATE TABLE failover_state (
          id INTEGER PRIMARY KEY
        );
      `);

      const result = validateFailoverRecoverySchema(testDb);
      expect(result.valid).toBe(false);
      expect(result.missingColumns["failover_state"]).toContain("active_node_url");
      expect(result.missingColumns["failover_state"]).toContain("total_failovers");
    });

    it("detects unapplied migrations", () => {
      testDb.prepare("DELETE FROM schema_migrations WHERE version = 8").run();

      const result = validateFailoverRecoverySchema(testDb);
      expect(result.valid).toBe(false);
      expect(result.missingMigrations).toContain(8);
      expect(result.errors.some((e) => e.includes("Missing applied migrations"))).toBe(true);
    });

    it("detects migration version gaps", () => {
      testDb.prepare("DELETE FROM schema_migrations WHERE version = 3").run();

      const result = validateFailoverRecoverySchema(testDb);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Migration version gap"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // assertFailoverRecoverySchemaValid
  // -------------------------------------------------------------------------

  describe("assertFailoverRecoverySchemaValid", () => {
    it("does not throw on a fully migrated database", () => {
      expect(() => assertFailoverRecoverySchemaValid(testDb)).not.toThrow();
    });

    it("assertFailoverRecoverySchemaReady alias functions identically", () => {
      expect(() => assertFailoverRecoverySchemaReady(testDb)).not.toThrow();
    });

    it("throws FailoverRecoverySchemaError when tables are missing", () => {
      testDb.exec("DROP TABLE rpc_node_health");

      expect(() => assertFailoverRecoverySchemaValid(testDb)).toThrow(
        FailoverRecoverySchemaError
      );
      expect(() => assertFailoverRecoverySchemaValid(testDb)).toThrow(
        /database schema is out of sync/
      );
    });

    it("attaches issues list to the thrown error", () => {
      testDb.exec("DROP TABLE failover_state");

      try {
        assertFailoverRecoverySchemaValid(testDb);
        fail("expected assertFailoverRecoverySchemaValid to throw");
      } catch (err: any) {
        expect(err).toBeInstanceOf(FailoverRecoverySchemaError);
        expect(err.issues).toBeDefined();
        expect(err.issues.some((i: string) => i.includes("failover_state"))).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Migration verification hook registry
  // -------------------------------------------------------------------------

  describe("migration verification hook registry", () => {
    it("registers and executes custom migration verification hook", () => {
      registerFailoverRecoveryMigrationHook("custom_node_check", (db) => {
        const count = (
          db.prepare("SELECT COUNT(*) as c FROM rpc_node_health").get() as any
        ).c;
        if (count === 0) {
          return "no nodes registered in health table";
        }
      });

      expect(getFailoverRecoveryMigrationHookNames()).toContain("custom_node_check");

      const result = validateFailoverRecoverySchema(testDb);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("custom_node_check: no nodes registered"))).toBe(
        true
      );
    });

    it("unregisters migration verification hook", () => {
      registerFailoverRecoveryMigrationHook("temp_hook", () => "error");
      expect(getFailoverRecoveryMigrationHookNames()).toContain("temp_hook");

      const removed = unregisterFailoverRecoveryMigrationHook("temp_hook");
      expect(removed).toBe(true);
      expect(getFailoverRecoveryMigrationHookNames()).not.toContain("temp_hook");

      const result = validateFailoverRecoverySchema(testDb);
      expect(result.valid).toBe(true);
    });

    it("clears all migration verification hooks", () => {
      registerFailoverRecoveryMigrationHook("hook1", () => "err1");
      registerFailoverRecoveryMigrationHook("hook2", () => "err2");
      expect(getFailoverRecoveryMigrationHookNames()).toHaveLength(2);

      clearFailoverRecoveryMigrationHooks();
      expect(getFailoverRecoveryMigrationHookNames()).toHaveLength(0);

      const result = validateFailoverRecoverySchema(testDb);
      expect(result.valid).toBe(true);
    });

    it("catches throwing hooks and reports as schema issues without crashing", () => {
      registerFailoverRecoveryMigrationHook("exploding_hook", () => {
        throw new Error("unexpected explosion");
      });

      const result = validateFailoverRecoverySchema(testDb);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("exploding_hook: hook threw"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Validation check: Confirm start fails if database state is out of sync
  // -------------------------------------------------------------------------

  describe("Validation check: Confirm start fails if database state is out of sync", () => {
    it("starts successfully against a fully migrated database", () => {
      expect(isFailoverRecoveryStarted()).toBe(false);

      const report = startFailoverRecovery({ targetDb: testDb });

      expect(report.valid).toBe(true);
      expect(isFailoverRecoveryStarted()).toBe(true);
      expect(getFailoverRecoverySchemaReport()?.valid).toBe(true);
    });

    it("fails to start when database state is out of sync due to missing migrations", () => {
      testDb.prepare("DELETE FROM schema_migrations WHERE version = 7").run();

      expect(() => startFailoverRecovery({ targetDb: testDb })).toThrow(
        FailoverRecoverySchemaError
      );
      expect(() => startFailoverRecovery({ targetDb: testDb })).toThrow(/out of sync/);
      expect(isFailoverRecoveryStarted()).toBe(false);

      const report = getFailoverRecoverySchemaReport();
      expect(report?.valid).toBe(false);
      expect(report?.missingMigrations).toContain(7);
    });

    it("fails to start when required health tables are dropped", () => {
      testDb.exec("DROP TABLE rpc_node_health");

      expect(() => startFailoverRecovery({ targetDb: testDb })).toThrow(
        FailoverRecoverySchemaError
      );
      expect(isFailoverRecoveryStarted()).toBe(false);

      const report = getFailoverRecoverySchemaReport();
      expect(report?.valid).toBe(false);
      expect(report?.missingTables).toContain("rpc_node_health");
    });

    it("fails to start when custom migration verification hook fails", () => {
      registerFailoverRecoveryMigrationHook("strict_check", () => "custom requirement unmet");

      expect(() => startFailoverRecovery({ targetDb: testDb })).toThrow(
        FailoverRecoverySchemaError
      );
      expect(isFailoverRecoveryStarted()).toBe(false);

      const report = getFailoverRecoverySchemaReport();
      expect(report?.errors.some((e) => e.includes("strict_check"))).toBe(true);
    });

    it("starts cleanly once out-of-sync condition is fixed", () => {
      testDb.prepare("DELETE FROM schema_migrations WHERE version = 8").run();
      expect(() => startFailoverRecovery({ targetDb: testDb })).toThrow();
      expect(isFailoverRecoveryStarted()).toBe(false);

      // Re-apply migration
      runMigrations();

      const report = startFailoverRecovery({ targetDb: testDb });
      expect(report.valid).toBe(true);
      expect(isFailoverRecoveryStarted()).toBe(true);
    });

    it("autoInitialize option creates missing health tables before starting", () => {
      testDb.exec("DROP TABLE rpc_node_health");
      testDb.exec("DROP TABLE failover_state");
      testDb.exec("DROP TABLE node_failure_events");

      // Without autoInitialize it fails
      expect(() => startFailoverRecovery({ targetDb: testDb })).toThrow();

      // With autoInitialize it sets up the tables and starts
      const report = startFailoverRecovery({
        targetDb: testDb,
        autoInitialize: true,
      });
      expect(report.valid).toBe(true);
      expect(isFailoverRecoveryStarted()).toBe(true);
    });

    it("stopFailoverRecovery resets started flag and report", () => {
      startFailoverRecovery({ targetDb: testDb });
      expect(isFailoverRecoveryStarted()).toBe(true);

      stopFailoverRecovery();
      expect(isFailoverRecoveryStarted()).toBe(false);
      expect(getFailoverRecoverySchemaReport()).toBeNull();
    });
  });
});
