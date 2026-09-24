import Database from "better-sqlite3";
import { setDb, runMigrations, closeDb, insertEvent } from "../src/indexer/db.js";
import {
  WRITER_POOL_INDEXES,
  WRITER_POOL_QUERIES,
  WRITER_POOL_UNIQUE_INDEXES,
  createSqlOperation,
  explainWriterPoolQueryPlan,
  queueWrite,
  verifyWriterPoolIndexes,
  verifyWriterPoolSchema,
  writerPoolQueryPlanUsesIndex,
  writerPoolQueryPlanUsesTempBTree,
} from "../src/indexer/database-writer-pool.js";

describe("database_writer_pool – SQLite index structures (#326)", () => {
  let testDb: Database.Database;

  beforeEach(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
    runMigrations();
    seedWriterPoolLookupRows(testDb);
  });

  afterEach(() => {
    closeDb();
  });

  function indexNames(): string[] {
    return (
      testDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
  }

  describe("migrations", () => {
    it("creates every named index the writer pool's lookups depend on", () => {
      const names = indexNames();
      for (const indexName of Object.values(WRITER_POOL_INDEXES)) {
        expect(names).toContain(indexName);
      }
    });

    it("preserves uniqueness indexes created by table constraints", () => {
      const names = indexNames();
      for (const indexName of Object.values(WRITER_POOL_UNIQUE_INDEXES)) {
        expect(names).toContain(indexName);
      }
    });

    it("records the writer-pool index migration as applied", () => {
      const versions = (
        testDb
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all() as Array<{ version: number }>
      ).map((row) => row.version);

      expect(versions).toContain(7);
    });

    it("is idempotent when migrations run twice", () => {
      runMigrations();

      const matching = indexNames().filter(
        (name) => name === WRITER_POOL_INDEXES.webhookByUrl,
      );
      expect(matching).toHaveLength(1);
    });

    it("verifyWriterPoolIndexes reports a healthy schema", () => {
      const report = verifyWriterPoolIndexes(testDb);

      expect(report.valid).toBe(true);
      expect(report.missing).toEqual([]);
      expect(report.present).toEqual(
        expect.arrayContaining([
          ...Object.values(WRITER_POOL_INDEXES),
          ...Object.values(WRITER_POOL_UNIQUE_INDEXES),
        ]),
      );
    });

    it("verifyWriterPoolIndexes reports a dropped write-path index", () => {
      testDb.exec(`DROP INDEX ${WRITER_POOL_INDEXES.webhookByUrl}`);

      const report = verifyWriterPoolIndexes(testDb);

      expect(report.valid).toBe(false);
      expect(report.missing).toEqual([WRITER_POOL_INDEXES.webhookByUrl]);
    });

    it("verifyWriterPoolSchema reports a dropped write-path index", () => {
      testDb.exec(`DROP INDEX ${WRITER_POOL_INDEXES.webhookByUrl}`);

      const report = verifyWriterPoolSchema();

      expect(report.valid).toBe(false);
      expect(report.issues.join(" ")).toContain(
        `missing index: ${WRITER_POOL_INDEXES.webhookByUrl}`,
      );
    });
  });

  describe("EXPLAIN QUERY PLAN – indexes are used for lookups", () => {
    it("uses sqlite_autoindex_events_1 for event uniqueness lookups", () => {
      const plan = explainWriterPoolQueryPlan(
        WRITER_POOL_QUERIES.eventDedup,
        ["contract-0", 10, "initialized"],
        testDb,
      );

      expect(
        writerPoolQueryPlanUsesIndex(
          plan,
          WRITER_POOL_UNIQUE_INDEXES.eventDedup,
        ),
      ).toBe(true);
      expect(writerPoolQueryPlanUsesTempBTree(plan)).toBe(false);
    });

    it("uses idx_events_contract_ledger for contract+ledger lookups", () => {
      const plan = explainWriterPoolQueryPlan(
        WRITER_POOL_QUERIES.eventContractLedger,
        ["contract-0", 10],
        testDb,
      );

      expect(
        writerPoolQueryPlanUsesIndex(
          plan,
          WRITER_POOL_INDEXES.eventContractLedger,
        ),
      ).toBe(true);
    });

    it("uses the indexer_state primary key for ledger-pointer reads and writes", () => {
      const readPlan = explainWriterPoolQueryPlan(
        WRITER_POOL_QUERIES.ledgerPointer,
        ["last_ledger_sequence"],
        testDb,
      );
      const writePlan = explainWriterPoolQueryPlan(
        WRITER_POOL_QUERIES.updateLedger,
        ["42", "last_ledger_sequence"],
        testDb,
      );

      expect(
        writerPoolQueryPlanUsesIndex(
          readPlan,
          WRITER_POOL_UNIQUE_INDEXES.indexerStateKey,
        ),
      ).toBe(true);
      expect(
        writerPoolQueryPlanUsesIndex(
          writePlan,
          WRITER_POOL_UNIQUE_INDEXES.indexerStateKey,
        ),
      ).toBe(true);
    });

    it("uses the monitored_contracts unique index for keyed updates", () => {
      const selectPlan = explainWriterPoolQueryPlan(
        WRITER_POOL_QUERIES.contractById,
        ["contract-0"],
        testDb,
      );
      const updatePlan = explainWriterPoolQueryPlan(
        WRITER_POOL_QUERIES.updateContract,
        ["contract-0"],
        testDb,
      );

      expect(
        writerPoolQueryPlanUsesIndex(
          selectPlan,
          WRITER_POOL_UNIQUE_INDEXES.monitoredContractId,
        ),
      ).toBe(true);
      expect(
        writerPoolQueryPlanUsesIndex(
          updatePlan,
          WRITER_POOL_UNIQUE_INDEXES.monitoredContractId,
        ),
      ).toBe(true);
    });

    it("uses idx_monitored_contracts_active for the active-contract filter", () => {
      const plan = explainWriterPoolQueryPlan(
        WRITER_POOL_QUERIES.activeContracts,
        [],
        testDb,
      );

      expect(
        writerPoolQueryPlanUsesIndex(
          plan,
          WRITER_POOL_INDEXES.activeContracts,
        ),
      ).toBe(true);
    });

    it("uses idx_webhook_subscriptions_contract for contract-scoped lookups", () => {
      const plan = explainWriterPoolQueryPlan(
        WRITER_POOL_QUERIES.webhookByContract,
        ["contract-0"],
        testDb,
      );

      expect(
        writerPoolQueryPlanUsesIndex(
          plan,
          WRITER_POOL_INDEXES.webhookByContract,
        ),
      ).toBe(true);
    });

    it("uses the webhook unique index for contract+url lookups", () => {
      const plan = explainWriterPoolQueryPlan(
        WRITER_POOL_QUERIES.webhookByContractUrl,
        ["contract-0", "https://hooks.example/0"],
        testDb,
      );

      expect(
        writerPoolQueryPlanUsesIndex(
          plan,
          WRITER_POOL_UNIQUE_INDEXES.webhookContractUrl,
        ),
      ).toBe(true);
    });

    it("uses idx_webhook_subscriptions_webhook_url for URL lookups and deletes", () => {
      const selectPlan = explainWriterPoolQueryPlan(
        WRITER_POOL_QUERIES.webhookByUrl,
        ["https://hooks.example/0"],
        testDb,
      );
      const deletePlan = explainWriterPoolQueryPlan(
        WRITER_POOL_QUERIES.deleteWebhookByUrl,
        ["https://hooks.example/0"],
        testDb,
      );

      expect(
        writerPoolQueryPlanUsesIndex(
          selectPlan,
          WRITER_POOL_INDEXES.webhookByUrl,
        ),
      ).toBe(true);
      expect(
        writerPoolQueryPlanUsesIndex(
          deletePlan,
          WRITER_POOL_INDEXES.webhookByUrl,
        ),
      ).toBe(true);
    });

    it("falls back to a table scan without the webhook URL index", () => {
      testDb.exec(`DROP INDEX ${WRITER_POOL_INDEXES.webhookByUrl}`);

      const plan = explainWriterPoolQueryPlan(
        WRITER_POOL_QUERIES.webhookByUrl,
        ["https://hooks.example/0"],
        testDb,
      );

      const details = plan.map((row) => String((row as { detail?: unknown }).detail));
      expect(details.some((detail) => /SCAN webhook_subscriptions/.test(detail))).toBe(
        true,
      );
      expect(
        writerPoolQueryPlanUsesIndex(plan, WRITER_POOL_INDEXES.webhookByUrl),
      ).toBe(false);
    });

    it("resolves schema version lookups through the integer primary key", () => {
      const plan = explainWriterPoolQueryPlan(
        WRITER_POOL_QUERIES.schemaVersionLookup,
        [7],
        testDb,
      );

      const details = plan.map((row) => String((row as { detail?: unknown }).detail));
      expect(details.join(" ")).toContain("SEARCH schema_migrations");
      expect(details.join(" ")).toContain("INTEGER PRIMARY KEY");
    });

    it("plans every writer-pool lookup without a temporary B-tree", () => {
      const lookupParams: Record<keyof typeof WRITER_POOL_QUERIES, unknown[]> = {
        eventDedup: ["contract-0", 10, "initialized"],
        eventContractLedger: ["contract-0", 10],
        ledgerPointer: ["last_ledger_sequence"],
        updateLedger: ["42", "last_ledger_sequence"],
        contractById: ["contract-0"],
        updateContract: ["contract-0"],
        activeContracts: [],
        webhookByContract: ["contract-0"],
        webhookByContractUrl: ["contract-0", "https://hooks.example/0"],
        webhookByUrl: ["https://hooks.example/0"],
        deleteWebhookByUrl: ["https://hooks.example/0"],
        schemaVersionLookup: [7],
      };

      for (const [name, sql] of Object.entries(WRITER_POOL_QUERIES)) {
        const plan = explainWriterPoolQueryPlan(
          sql,
          lookupParams[name as keyof typeof WRITER_POOL_QUERIES],
          testDb,
        );
        expect(writerPoolQueryPlanUsesTempBTree(plan)).toBe(false);
      }
    });
  });

  describe("existing write behavior stays correct after the index work", () => {
    it("still enforces event uniqueness on INSERT OR IGNORE", async () => {
      const first = await queueWrite(
        createSqlOperation(
          "insert-event",
          `INSERT OR IGNORE INTO events
           (contract_id, event_type, ledger_sequence, timestamp, data_json)
           VALUES (?, ?, ?, ?, ?)`,
          ["contract-uniq", "funded", 999, 1_700_000_999, "{}"],
        ),
      );
      const duplicate = await queueWrite(
        createSqlOperation(
          "insert-event-dup",
          `INSERT OR IGNORE INTO events
           (contract_id, event_type, ledger_sequence, timestamp, data_json)
           VALUES (?, ?, ?, ?, ?)`,
          ["contract-uniq", "funded", 999, 1_700_000_999, '{"dup":true}'],
        ),
      );

      expect(first.success).toBe(true);
      expect(first.data?.changes).toBe(1);
      expect(duplicate.success).toBe(true);
      expect(duplicate.data?.changes).toBe(0);

      const rows = testDb
        .prepare(
          "SELECT data_json FROM events WHERE contract_id = ? AND ledger_sequence = ? AND event_type = ?",
        )
        .all("contract-uniq", 999, "funded");
      expect(rows).toHaveLength(1);
      expect((rows[0] as { data_json: string }).data_json).toBe("{}");
    });

    it("still enforces webhook (contract_id, webhook_url) uniqueness", () => {
      const insert = testDb.prepare(
        `INSERT OR IGNORE INTO webhook_subscriptions
         (contract_id, webhook_url, event_types)
         VALUES (?, ?, ?)`,
      );
      insert.run("contract-0", "https://hooks.example/new", '["*"]');
      insert.run("contract-0", "https://hooks.example/new", '["funded"]');

      const rows = testDb
        .prepare(
          "SELECT event_types FROM webhook_subscriptions WHERE contract_id = ? AND webhook_url = ?",
        )
        .all("contract-0", "https://hooks.example/new");

      expect(rows).toHaveLength(1);
      expect((rows[0] as { event_types: string }).event_types).toBe('["*"]');
    });

    it("updates the ledger pointer through the same keyed write", async () => {
      const result = await queueWrite(
        createSqlOperation(
          "advance-ledger",
          WRITER_POOL_QUERIES.updateLedger,
          ["2048", "last_ledger_sequence"],
        ),
      );

      expect(result.success).toBe(true);
      const row = testDb
        .prepare(WRITER_POOL_QUERIES.ledgerPointer)
        .get("last_ledger_sequence") as { value: string };
      expect(row.value).toBe("2048");
    });

    it("deletes a webhook subscription by URL using the new index path", async () => {
      const result = await queueWrite(
        createSqlOperation(
          "delete-webhook",
          WRITER_POOL_QUERIES.deleteWebhookByUrl,
          ["https://hooks.example/0"],
        ),
      );

      expect(result.success).toBe(true);
      expect(result.data?.changes).toBe(1);

      const remaining = testDb
        .prepare(WRITER_POOL_QUERIES.webhookByUrl)
        .all("https://hooks.example/0");
      expect(remaining).toHaveLength(0);
    });
  });
});

function seedWriterPoolLookupRows(testDb: Database.Database): void {
  for (let ledger = 1; ledger <= 40; ledger++) {
    insertEvent(
      `contract-${ledger % 4}`,
      ["initialized", "funded", "approved"][ledger % 3],
      ledger,
      1_700_000_000 + ledger,
      JSON.stringify({ ledger }),
    );
  }

  for (let i = 0; i < 8; i++) {
    testDb
      .prepare(
        "INSERT OR IGNORE INTO monitored_contracts (contract_id, active) VALUES (?, ?)",
      )
      .run(`contract-${i % 4}`, i % 2);
    testDb
      .prepare(
        `INSERT OR IGNORE INTO webhook_subscriptions
         (contract_id, webhook_url, event_types)
         VALUES (?, ?, ?)`,
      )
      .run(`contract-${i % 4}`, `https://hooks.example/${i}`, '["*"]');
  }
}
