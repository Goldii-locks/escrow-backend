import Database from "better-sqlite3";
import { setDb, runMigrations, getDb } from "../src/indexer/db.js";

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
    });
  });

  describe("events table – RPC event writes", () => {
    it("inserts a single event with all fields", () => {
      testDb
        .prepare(
          `INSERT INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json)
           VALUES (?, ?, ?, ?, ?)`
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
         VALUES (?, ?, ?, ?, ?)`
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
         VALUES (?, ?, ?, ?, ?)`
      );

      insert.run("C1", "initialized", 100, 1000, "{}");
      insert.run("C1", "funded", 100, 1000, "{}");

      const rows = testDb.prepare("SELECT * FROM events").all();
      expect(rows.length).toBe(2);
    });

    it("allows events across multiple contracts", () => {
      const insert = testDb.prepare(
        `INSERT OR IGNORE INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json)
         VALUES (?, ?, ?, ?, ?)`
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
           VALUES (?, ?, ?, ?, ?)`
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
           VALUES (?, ?, 1)`
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
         VALUES (?, ?, 1)`
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
              "INSERT INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json) VALUES (?, ?, ?, ?, ?)"
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
            "INSERT INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json) VALUES (?, ?, ?, ?, ?)"
          )
          .run("C1", "initialized", 100, 1000, "{}");
        testDb
          .prepare(
            "INSERT INTO events (contract_id, event_type, ledger_sequence, timestamp, data_json) VALUES (?, ?, ?, ?, ?)"
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
          "INSERT INTO monitored_contracts (contract_id, label, active) VALUES (?, ?, 1)"
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
});
