import Database from "better-sqlite3";
import {
  setDb,
  runMigrations,
  getDb,
  computeSchemaBackoffMs,
  withSchemaRetry,
  withSchemaRetrySync,
  isSchemaRetryableError,
} from "../src/indexer/db.js";
import { jest } from "@jest/globals";
import logger from "../src/utils/logger.js";

describe("SQLite Schema Manager – in-memory integration tests", () => {
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

  describe("schema initialization", () => {
    it("creates all expected tables after migration", () => {
      const tables = testDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);

      expect(names).toContain("events");
      expect(names).toContain("indexer_state");
      expect(names).toContain("monitored_contracts");
      expect(names).toContain("schema_migrations");
      expect(names).toContain("webhook_subscriptions");
    });

    it("schema_migrations tracks all applied versions", () => {
      const rows = testDb
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number }>;
      const versions = rows.map((r) => r.version);
      expect(versions).toContain(1);
      expect(versions).toContain(2);
      expect(versions).toContain(3);
      expect(versions).toContain(4);
      expect(versions).toContain(5);
    });

    it("creates all schema-manager lookup indexes (#259)", () => {
      const indexes = testDb
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND name LIKE 'idx_%'
           ORDER BY name`,
        )
        .all() as Array<{ name: string }>;
      const names = indexes.map((i) => i.name);

      for (const indexName of Object.values(SCHEMA_MANAGER_INDEXES)) {
        expect(names).toContain(indexName);
      }
    });
  });

  describe("events table – RPC event writes", () => {
    it("inserts a single event with all fields", () => {
      testDb
        .prepare(
          `INSERT INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("C1", "initialized", 1000, 1700000000, '{"key":"value"}');

      const row = testDb
        .prepare("SELECT * FROM events WHERE contract_id = 'C1'")
        .get() as any;

      expect(row).toBeTruthy();
      expect(row.event_type).toBe("initialized");
      expect(row.ledger_sequence).toBe(1000);
      expect(row.timestamp).toBe(1700000000);
      expect(row.data_json).toBe('{"key":"value"}');
    });

    it("enforces unique constraint on contract_id + ledger_sequence + event_type", () => {
      const insert = testDb.prepare(
        `INSERT OR IGNORE INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json)
         VALUES (?, ?, ?, ?, ?)`,
      );

      insert.run("C1", "initialized", 100, 1000, "{}");
      insert.run("C1", "initialized", 100, 1001, '{"updated":true}');

      const rows = testDb.prepare("SELECT * FROM events").all();
      expect(rows.length).toBe(1);
      expect((rows[0] as any).data_json).toBe("{}");
    });

    it("allows different event types on the same ledger", () => {
      const insert = testDb.prepare(
        `INSERT OR IGNORE INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json)
         VALUES (?, ?, ?, ?, ?)`,
      );

      insert.run("C1", "initialized", 100, 1000, "{}");
      insert.run("C1", "funded", 100, 1000, "{}");

      const rows = testDb.prepare("SELECT * FROM events").all();
      expect(rows.length).toBe(2);
    });

    it("allows events across multiple contracts", () => {
      const insert = testDb.prepare(
        `INSERT OR IGNORE INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json)
         VALUES (?, ?, ?, ?, ?)`,
      );

      insert.run("C1", "initialized", 100, 1000, "{}");
      insert.run("C2", "initialized", 100, 1000, "{}");
      insert.run("C3", "funded", 101, 1001, "{}");

      const rows = testDb.prepare("SELECT * FROM events").all();
      expect(rows.length).toBe(3);
    });

    it("persists large data_json payloads", () => {
      const largeData = JSON.stringify({
        milestones: Array.from({ length: 50 }, (_, i) => ({
          id: i,
          description: `Milestone ${i}`.repeat(10),
          amount: "1000.00",
        })),
      });

      testDb
        .prepare(
          `INSERT INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("C1", "initialized", 100, 1000, largeData);

      const row = testDb
        .prepare("SELECT data_json FROM events WHERE contract_id = 'C1'")
        .get() as any;

      expect(JSON.parse(row.data_json).milestones.length).toBe(50);
    });
  });

  describe("indexer_state – ledger pointer", () => {
    it("initializes last_ledger_sequence to 0", () => {
      const row = testDb
        .prepare("SELECT value FROM indexer_state WHERE key = 'last_ledger_sequence'")
        .get() as any;
      expect(row.value).toBe("0");
    });

    it("updates ledger pointer", () => {
      testDb
        .prepare("UPDATE indexer_state SET value = ? WHERE key = 'last_ledger_sequence'")
        .run("5000");

      const row = testDb
        .prepare("SELECT value FROM indexer_state WHERE key = 'last_ledger_sequence'")
        .get() as any;
      expect(row.value).toBe("5000");
    });
  });

  describe("monitored_contracts – RPC contract registry", () => {
    it("registers a contract", () => {
      testDb
        .prepare(
          `INSERT INTO monitored_contracts (contract_id, label, active)
           VALUES (?, ?, 1)`,
        )
        .run("CONTRACT-ALPHA", "alpha");

      const row = testDb
        .prepare("SELECT * FROM monitored_contracts WHERE contract_id = 'CONTRACT-ALPHA'")
        .get() as any;

      expect(row).toBeTruthy();
      expect(row.label).toBe("alpha");
      expect(row.active).toBe(1);
    });

    it("enforces unique contract_id", () => {
      const insert = testDb.prepare(
        `INSERT OR IGNORE INTO monitored_contracts (contract_id, label, active)
         VALUES (?, ?, 1)`,
      );

      insert.run("C1", "first");
      insert.run("C1", "second");

      const rows = testDb
        .prepare("SELECT * FROM monitored_contracts WHERE contract_id = 'C1'")
        .all();
      expect(rows.length).toBe(1);
      expect((rows[0] as any).label).toBe("first");
    });

    it("returns only active contracts", () => {
      testDb
        .prepare("INSERT INTO monitored_contracts (contract_id, active) VALUES (?, 1)")
        .run("C1");
      testDb
        .prepare("INSERT INTO monitored_contracts (contract_id, active) VALUES (?, 0)")
        .run("C2");

      const rows = testDb
        .prepare("SELECT contract_id FROM monitored_contracts WHERE active = 1")
        .all() as Array<{ contract_id: string }>;

      expect(rows.map((r) => r.contract_id)).toContain("C1");
      expect(rows.map((r) => r.contract_id)).not.toContain("C2");
    });
  });

  describe("transaction atomicity", () => {
    it("rolls back all changes on transaction failure", () => {
      const countBefore = testDb
        .prepare("SELECT COUNT(*) as cnt FROM events")
        .get() as { cnt: number };

      try {
        testDb.transaction(() => {
          testDb
            .prepare(
              "INSERT INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json) VALUES (?, ?, ?, ?, ?)",
            )
            .run("C1", "t", 1, 1, "{}");
          throw new Error("intentional rollback");
        })();
      } catch {
        // expected
      }

      const countAfter = testDb
        .prepare("SELECT COUNT(*) as cnt FROM events")
        .get() as { cnt: number };

      expect(countAfter.cnt).toBe(countBefore.cnt);
    });

    it("commits all changes atomically on success", () => {
      testDb.transaction(() => {
        testDb
          .prepare(
            "INSERT INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json) VALUES (?, ?, ?, ?, ?)",
          )
          .run("C1", "initialized", 100, 1000, "{}");
        testDb
          .prepare(
            "INSERT INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json) VALUES (?, ?, ?, ?, ?)",
          )
          .run("C1", "funded", 101, 1001, "{}");
        testDb
          .prepare("UPDATE indexer_state SET value = ? WHERE key = 'last_ledger_sequence'")
          .run("101");
      })();

      const rows = testDb.prepare("SELECT * FROM events").all();
      expect(rows.length).toBe(2);

      const ledger = testDb
        .prepare("SELECT value FROM indexer_state WHERE key = 'last_ledger_sequence'")
        .get() as any;
      expect(ledger.value).toBe("101");
    });
  });

  describe("migration idempotency", () => {
    it("running migrations multiple times does not duplicate data", () => {
      testDb
        .prepare(
          "INSERT INTO monitored_contracts (contract_id, label, active) VALUES (?, ?, 1)",
        )
        .run("C1", "original");

      runMigrations();
      runMigrations();

      const rows = testDb
        .prepare("SELECT * FROM monitored_contracts WHERE contract_id = 'C1'")
        .all();
      expect(rows.length).toBe(1);
      expect((rows[0] as any).label).toBe("original");
    });

    it("new migrations are applied when added", () => {
      const versionsBefore = testDb
        .prepare("SELECT version FROM schema_migrations")
        .all() as Array<{ version: number }>;
      const countBefore = versionsBefore.length;

      runMigrations();

      const versionsAfter = testDb
        .prepare("SELECT version FROM schema_migrations")
        .all() as Array<{ version: number }>;

      expect(versionsAfter.length).toBe(countBefore);
    });
  });

  describe("transaction atomicity – full rollback on failure (#186)", () => {
    it("successful multi-statement migration commits every table + row", () => {
      const cleanDb = new Database(":memory:");
      setDb(cleanDb);
      try {
        runMigrations();

        const tables = (cleanDb
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as Array<{ name: string }>).map((t) => t.name);

        expect(tables).toContain("schema_migrations");
        expect(tables).toContain("events");
        expect(tables).toContain("indexer_state");
        expect(tables).toContain("monitored_contracts");
        expect(tables).toContain("webhook_subscriptions");

        const versions = (cleanDb
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all() as Array<{ version: number }>).map((r) => r.version);
        expect(versions).toEqual([1, 2, 3]);

        const ledger = cleanDb
          .prepare("SELECT value FROM indexer_state WHERE key = 'last_ledger_sequence'")
          .get() as { value: string };
        expect(ledger.value).toBe("0");
      } finally {
        cleanDb.close();
        setDb(testDb);
      }
    });

    it("forced failure mid-migration rolls back ALL schema changes – no partial tables/rows persist", () => {
      const cleanDb = new Database(":memory:");
      setDb(cleanDb);
      try {
        cleanDb.exec(`
          CREATE TABLE webhook_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL UNIQUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
        `);

        expect(() => runMigrations()).toThrow();

        const tables = new Set(
          (cleanDb
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all() as Array<{ name: string }>).map((t) => t.name)
        );

        expect(tables.has("webhook_subscriptions")).toBe(true);

        const hasSchemaMigrations = tables.has("schema_migrations");
        const hasEvents = tables.has("events");
        const hasIndexerState = tables.has("indexer_state");
        const hasMonitoredContracts = tables.has("monitored_contracts");
        const hasRpcNodeHealth = tables.has("rpc_node_health");
        const hasFailoverState = tables.has("failover_state");
        const hasNodeFailureEvents = tables.has("node_failure_events");

        expect(hasSchemaMigrations).toBe(false);
        expect(hasEvents).toBe(false);
        expect(hasIndexerState).toBe(false);
        expect(hasMonitoredContracts).toBe(false);
        expect(hasRpcNodeHealth).toBe(false);
        expect(hasFailoverState).toBe(false);
        expect(hasNodeFailureEvents).toBe(false);

        if (hasSchemaMigrations) {
          const versions = cleanDb
            .prepare("SELECT version FROM schema_migrations")
            .all() as Array<{ version: number }>;
          expect(versions.length).toBe(0);
        }
      } finally {
        cleanDb.close();
        setDb(testDb);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// #258 – Exponential backoff retry on connection / lock timeouts
// ---------------------------------------------------------------------------

describe("SQLite Schema Manager – exponential backoff retry (#258)", () => {
  describe("computeSchemaBackoffMs", () => {
    const config = {
      initialBackoffMs: 50,
      backoffMultiplier: 2,
      maxBackoffMs: 2000,
    };

    it("returns initial backoff for attempt 0", () => {
      expect(computeSchemaBackoffMs(0, config)).toBe(50);
    });

    it("doubles backoff on each attempt (retry frequency increases)", () => {
      expect(computeSchemaBackoffMs(1, config)).toBe(100);
      expect(computeSchemaBackoffMs(2, config)).toBe(200);
      expect(computeSchemaBackoffMs(3, config)).toBe(400);
      expect(computeSchemaBackoffMs(4, config)).toBe(800);
    });

    it("caps at maxBackoffMs", () => {
      expect(computeSchemaBackoffMs(6, config)).toBe(2000);
      expect(computeSchemaBackoffMs(10, config)).toBe(2000);
      expect(computeSchemaBackoffMs(100, config)).toBe(2000);
    });

    it("respects custom multiplier", () => {
      const cfg3x = { ...config, backoffMultiplier: 3 };
      expect(computeSchemaBackoffMs(0, cfg3x)).toBe(50);
      expect(computeSchemaBackoffMs(1, cfg3x)).toBe(150);
      expect(computeSchemaBackoffMs(2, cfg3x)).toBe(450);
    });
  });

  describe("isSchemaRetryableError", () => {
    it("treats SQLITE_BUSY / locked / timeout / connection dropouts as retryable", () => {
      expect(isSchemaRetryableError(new Error("SQLITE_BUSY"))).toBe(true);
      expect(isSchemaRetryableError(new Error("database is locked"))).toBe(true);
      expect(isSchemaRetryableError(new Error("connect timeout"))).toBe(true);
      expect(isSchemaRetryableError(new Error("ECONNRESET"))).toBe(true);
      expect(isSchemaRetryableError(new Error("RPC connection dropped"))).toBe(true);
    });

    it("does not retry permanent schema errors", () => {
      expect(isSchemaRetryableError(new Error("UNIQUE constraint failed"))).toBe(false);
      expect(isSchemaRetryableError(new Error("no such table: events"))).toBe(false);
      expect(isSchemaRetryableError("not-an-error")).toBe(false);
    });
  });

  describe("withSchemaRetry", () => {
    it("returns result on first success without retry", async () => {
      let calls = 0;
      const result = await withSchemaRetry(
        async () => {
          calls++;
          return "ok";
        },
        { maxRetries: 3, initialBackoffMs: 5 },
        "test",
      );
      expect(result).toBe("ok");
      expect(calls).toBe(1);
    });

    it("retries transient connection timeouts with increasing backoff", async () => {
      let calls = 0;
      const delays: number[] = [];
      const warnSpy = jest.spyOn(logger, "warn").mockImplementation((() => logger) as any);

      try {
        const result = await withSchemaRetry(
          async () => {
            calls++;
            if (calls < 3) {
              throw new Error("connect timeout");
            }
            return "recovered";
          },
          { maxRetries: 5, initialBackoffMs: 10, backoffMultiplier: 2, maxBackoffMs: 1000 },
          "schema_test",
        );

        expect(result).toBe("recovered");
        expect(calls).toBe(3);

        const retryWarns = warnSpy.mock.calls.filter(
          ([msg]) => msg === "schema_test failed, retrying",
        );
        expect(retryWarns.length).toBe(2);
        for (const [, meta] of retryWarns) {
          delays.push((meta as { backoffMs: number }).backoffMs);
        }
        expect(delays[0]).toBe(10);
        expect(delays[1]).toBe(20);
        expect(delays[1]).toBeGreaterThan(delays[0]);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("stops after max attempts on persistent connection dropout", async () => {
      let calls = 0;
      await expect(
        withSchemaRetry(
          async () => {
            calls++;
            throw new Error("ECONNRESET connection dropped");
          },
          { maxRetries: 2, initialBackoffMs: 5 },
          "schema_test",
        ),
      ).rejects.toThrow(/ECONNRESET/);
      // initial + 2 retries = 3 attempts
      expect(calls).toBe(3);
    });

    it("does not retry non-retryable errors", async () => {
      let calls = 0;
      await expect(
        withSchemaRetry(
          async () => {
            calls++;
            throw new Error("UNIQUE constraint failed");
          },
          { maxRetries: 5, initialBackoffMs: 5 },
        ),
      ).rejects.toThrow(/UNIQUE/);
      expect(calls).toBe(1);
    });
  });

  describe("withSchemaRetrySync / runMigrations wiring", () => {
    it("retries sync SQLITE_BUSY then succeeds", () => {
      let calls = 0;
      const result = withSchemaRetrySync(
        () => {
          calls++;
          if (calls < 2) throw new Error("SQLITE_BUSY: database is locked");
          return "synced";
        },
        { maxRetries: 3, initialBackoffMs: 1, maxBackoffMs: 5 },
        "sync_test",
      );
      expect(result).toBe("synced");
      expect(calls).toBe(2);
    });

    it("runMigrations still succeeds under normal conditions with retry wrapper", () => {
      const db = new Database(":memory:");
      setDb(db);
      try {
        expect(() =>
          runMigrations({ maxRetries: 2, initialBackoffMs: 1, maxBackoffMs: 5 }),
        ).not.toThrow();
        expect(getDb()).toBe(db);
      } finally {
        db.close();
      }
    });
  });
});
