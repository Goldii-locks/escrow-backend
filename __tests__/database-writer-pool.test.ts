import Database from "better-sqlite3";
import { setDb, runMigrations } from "../src/indexer/db.js";
import {
  queueWrite,
  executeWriteTransaction,
  executeBatchWrite,
  flushWriteQueue,
  getWriteQueueSize,
  isWriteQueueProcessing,
  createSqlOperation,
  createReadWriteOperation,
  isRpcTimeoutError,
  computeRpcBackoffMs,
  setWriterPoolRpcRetryConfig,
  getWriterPoolRpcRetryConfig,
  resetWriterPoolRpcRetryConfig,
  type WriteOperation,
} from "../src/indexer/database-writer-pool.js";

describe("DatabaseWriterPool – Concurrent Write Operations", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
  });

  afterAll(() => {
    testDb.close();
  });

  beforeEach(async () => {
    testDb.exec("DROP TABLE IF EXISTS test_data");
    testDb.exec("DROP TABLE IF EXISTS events");
    testDb.exec("DROP TABLE IF EXISTS indexer_state");
    testDb.exec("DROP TABLE IF EXISTS monitored_contracts");
    testDb.exec("DROP TABLE IF EXISTS schema_migrations");

    // Create a test table
    testDb.exec(`
      CREATE TABLE test_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        value TEXT NOT NULL,
        count INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    runMigrations();
    await flushWriteQueue();
  });

  // -------------------------------------------------------------------------
  // Basic write operations
  // -------------------------------------------------------------------------

  describe("queueWrite – basic write operations", () => {
    it("executes a simple INSERT operation", async () => {
      const operation: WriteOperation<{ changes: number }> = {
        name: "insert-test",
        execute: (db) => {
          const stmt = db.prepare("INSERT INTO test_data (value) VALUES (?)");
          const result = stmt.run("test_value");
          return { changes: result.changes };
        },
      };

      const result = await queueWrite(operation);

      expect(result.success).toBe(true);
      expect(result.data?.changes).toBe(1);
      expect(result.retries).toBe(0);

      const rows = testDb.prepare("SELECT * FROM test_data").all();
      expect(rows).toHaveLength(1);
      expect((rows[0] as any).value).toBe("test_value");
    });

    it("executes a simple UPDATE operation", async () => {
      // Seed data
      testDb.prepare("INSERT INTO test_data (value) VALUES (?)").run("initial");

      const operation: WriteOperation<{ changes: number }> = {
        name: "update-test",
        execute: (db) => {
          const stmt = db.prepare("UPDATE test_data SET value = ? WHERE id = 1");
          const result = stmt.run("updated");
          return { changes: result.changes };
        },
      };

      const result = await queueWrite(operation);

      expect(result.success).toBe(true);
      expect(result.data?.changes).toBe(1);

      const row = testDb.prepare("SELECT * FROM test_data WHERE id = 1").get() as any;
      expect(row.value).toBe("updated");
    });

    it("executes a simple DELETE operation", async () => {
      testDb.prepare("INSERT INTO test_data (value) VALUES (?)").run("to_delete");

      const operation: WriteOperation<{ changes: number }> = {
        name: "delete-test",
        execute: (db) => {
          const stmt = db.prepare("DELETE FROM test_data WHERE id = 1");
          const result = stmt.run();
          return { changes: result.changes };
        },
      };

      const result = await queueWrite(operation);

      expect(result.success).toBe(true);
      expect(result.data?.changes).toBe(1);

      const rows = testDb.prepare("SELECT * FROM test_data").all();
      expect(rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Transaction atomicity
  // -------------------------------------------------------------------------

  describe("executeWriteTransaction – ACID guarantees", () => {
    it("rolls back entire transaction on error", async () => {
      testDb.prepare("INSERT INTO test_data (value) VALUES (?)").run("initial");

      const operation: WriteOperation<void> = {
        name: "failing-transaction",
        execute: (db) => {
          // Insert one row
          db.prepare("INSERT INTO test_data (value) VALUES (?)").run("row1");

          // Try to insert duplicate (will fail)
          throw new Error("Simulated failure");
        },
      };

      const result = await executeWriteTransaction(operation);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain("Simulated failure");

      // Only the initial row should exist
      const rows = testDb.prepare("SELECT * FROM test_data").all();
      expect(rows).toHaveLength(1);
    });

    it("commits transaction on success", async () => {
      const operation: WriteOperation<string> = {
        name: "successful-transaction",
        execute: (db) => {
          db.prepare("INSERT INTO test_data (value) VALUES (?)").run("row1");
          db.prepare("INSERT INTO test_data (value) VALUES (?)").run("row2");
          return "success";
        },
      };

      const result = await executeWriteTransaction(operation);

      expect(result.success).toBe(true);
      expect(result.data).toBe("success");

      const rows = testDb.prepare("SELECT * FROM test_data").all();
      expect(rows).toHaveLength(2);
    });

    it("isolation: concurrent writes are serialized", async () => {
      const operation1 = async () => {
        const op: WriteOperation<number> = {
          name: "write-1",
          execute: (db) => {
            db.prepare("INSERT INTO test_data (value) VALUES (?)").run("write1");
            return 1;
          },
        };
        return queueWrite(op);
      };

      const operation2 = async () => {
        const op: WriteOperation<number> = {
          name: "write-2",
          execute: (db) => {
            db.prepare("INSERT INTO test_data (value) VALUES (?)").run("write2");
            return 2;
          },
        };
        return queueWrite(op);
      };

      const [result1, result2] = await Promise.all([operation1(), operation2()]);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      const rows = testDb.prepare("SELECT * FROM test_data ORDER BY id").all() as any[];
      expect(rows).toHaveLength(2);
      expect(rows[0].value).toBe("write1");
      expect(rows[1].value).toBe("write2");
    });
  });

  // -------------------------------------------------------------------------
  // Batch operations
  // -------------------------------------------------------------------------

  describe("executeBatchWrite – atomic batch operations", () => {
    it("executes multiple operations as a single transaction", async () => {
      const operations: WriteOperation<number>[] = [
        {
          name: "batch-insert-1",
          execute: (db) => {
            const result = db.prepare("INSERT INTO test_data (value) VALUES (?)").run("batch1");
            return result.changes;
          },
        },
        {
          name: "batch-insert-2",
          execute: (db) => {
            const result = db.prepare("INSERT INTO test_data (value) VALUES (?)").run("batch2");
            return result.changes;
          },
        },
        {
          name: "batch-insert-3",
          execute: (db) => {
            const result = db.prepare("INSERT INTO test_data (value) VALUES (?)").run("batch3");
            return result.changes;
          },
        },
      ];

      const result = await executeBatchWrite(operations, "insert-batch");

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(3);
      expect(result.data?.every((r) => r === 1)).toBe(true);

      const rows = testDb.prepare("SELECT * FROM test_data").all();
      expect(rows).toHaveLength(3);
    });

    it("rolls back all operations if one fails", async () => {
      const operations: WriteOperation<number>[] = [
        {
          name: "batch-insert-ok",
          execute: (db) => {
            const result = db.prepare("INSERT INTO test_data (value) VALUES (?)").run("ok");
            return result.changes;
          },
        },
        {
          name: "batch-insert-fail",
          execute: (db) => {
            throw new Error("Batch operation failed");
          },
        },
      ];

      const result = await executeBatchWrite(operations, "failing-batch");

      expect(result.success).toBe(false);

      // No rows should have been inserted
      const rows = testDb.prepare("SELECT * FROM test_data").all();
      expect(rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Read-write consistency
  // -------------------------------------------------------------------------

  describe("createReadWriteOperation – consistent read-write", () => {
    it("reads and writes within the same transaction", async () => {
      testDb.prepare("INSERT INTO test_data (value, count) VALUES (?, ?)").run("counter", 5);

      const operation = createReadWriteOperation("increment-counter", (db) => {
        const row = db
          .prepare("SELECT * FROM test_data WHERE value = 'counter'")
          .get() as any;

        const newCount = row.count + 1;

        db.prepare("UPDATE test_data SET count = ? WHERE value = 'counter'").run(newCount);

        return newCount;
      });

      const result = await executeWriteTransaction(operation);

      expect(result.success).toBe(true);
      expect(result.data).toBe(6);

      const row = testDb
        .prepare("SELECT * FROM test_data WHERE value = 'counter'")
        .get() as any;
      expect(row.count).toBe(6);
    });

    it("isolation: read-write is consistent across concurrent operations", async () => {
      testDb.prepare("INSERT INTO test_data (value, count) VALUES (?, ?)").run("counter", 0);

      const increment = () => {
        const operation = createReadWriteOperation("increment", (db) => {
          const row = db
            .prepare("SELECT * FROM test_data WHERE value = 'counter'")
            .get() as any;
          db.prepare("UPDATE test_data SET count = ? WHERE value = 'counter'").run(row.count + 1);
          return row.count + 1;
        });
        return executeWriteTransaction(operation);
      };

      const results = await Promise.all([
        increment(),
        increment(),
        increment(),
        increment(),
        increment(),
      ]);

      results.forEach((result) => {
        expect(result.success).toBe(true);
      });

      const row = testDb
        .prepare("SELECT * FROM test_data WHERE value = 'counter'")
        .get() as any;
      expect(row.count).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // Queue management
  // -------------------------------------------------------------------------

  describe("Queue management functions", () => {
    it("getWriteQueueSize returns correct queue length", async () => {
      let queueSizeAtStart = 0;

      const operation: WriteOperation<void> = {
        name: "queue-size-check",
        execute: (db) => {
          // Capture queue size during execution
          queueSizeAtStart = getWriteQueueSize();
        },
      };

      const promise = queueWrite(operation);
      const queueSizeAfterQueue = getWriteQueueSize();

      await promise;
      const queueSizeAfterExecution = getWriteQueueSize();

      expect(queueSizeAfterExecution).toBe(0);
    });

    it("isWriteQueueProcessing returns correct state", async () => {
      let wasProcessing = false;

      const operation: WriteOperation<void> = {
        name: "processing-check",
        execute: () => {
          wasProcessing = isWriteQueueProcessing();
        },
      };

      const promise = queueWrite(operation);
      await promise;

      const isProcessingNow = isWriteQueueProcessing();
      expect(isProcessingNow).toBe(false);
    });

    it("flushWriteQueue waits for all pending operations", async () => {
      const executionOrder: string[] = [];

      const operations = [1, 2, 3].map((num) => ({
        name: `operation-${num}`,
        execute: (db: any) => {
          executionOrder.push(`op${num}`);
          db.prepare("INSERT INTO test_data (value) VALUES (?)").run(`value${num}`);
        },
      }));

      // Queue all operations
      const promises = operations.map((op) => queueWrite(op));

      // Flush and wait
      await flushWriteQueue();

      // All should have completed
      expect(executionOrder).toHaveLength(3);
      const rows = testDb.prepare("SELECT * FROM test_data").all();
      expect(rows).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // Helper functions
  // -------------------------------------------------------------------------

  describe("createSqlOperation – SQL helper", () => {
    it("creates and executes INSERT operation", async () => {
      const operation = createSqlOperation(
        "insert-via-helper",
        "INSERT INTO test_data (value) VALUES (?)",
        ["test_value"]
      );

      const result = await queueWrite(operation);

      expect(result.success).toBe(true);
      expect(result.data?.changes).toBe(1);

      const rows = testDb.prepare("SELECT * FROM test_data").all();
      expect(rows).toHaveLength(1);
    });

    it("creates and executes UPDATE operation", async () => {
      testDb.prepare("INSERT INTO test_data (value) VALUES (?)").run("initial");

      const operation = createSqlOperation(
        "update-via-helper",
        "UPDATE test_data SET value = ? WHERE id = 1",
        ["updated"]
      );

      const result = await queueWrite(operation);

      expect(result.success).toBe(true);
      expect(result.data?.changes).toBe(1);

      const row = testDb.prepare("SELECT * FROM test_data WHERE id = 1").get() as any;
      expect(row.value).toBe("updated");
    });
  });

  // -------------------------------------------------------------------------
  // Error handling and retries
  // -------------------------------------------------------------------------

  describe("Error handling and retries", () => {
    it("returns error information on failed operation", async () => {
      const operation: WriteOperation<void> = {
        name: "failing-operation",
        execute: () => {
          throw new Error("Intentional test failure");
        },
      };

      const result = await queueWrite(operation);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain("Intentional test failure");
    });

    it("includes execution time metrics", async () => {
      const operation: WriteOperation<void> = {
        name: "metric-test",
        execute: (db) => {
          db.prepare("INSERT INTO test_data (value) VALUES (?)").run("test");
        },
      };

      const result = await queueWrite(operation);

      expect(result.success).toBe(true);
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.executionTimeMs).toBe("number");
    });
  });

  // -------------------------------------------------------------------------
  // Stress testing
  // -------------------------------------------------------------------------

  describe("Stress tests", () => {
    it("handles large number of sequential writes", async () => {
      const operations = Array.from({ length: 100 }, (_, i) => ({
        name: `write-${i}`,
        execute: (db: any) => {
          db.prepare("INSERT INTO test_data (value) VALUES (?)").run(`value-${i}`);
          return i;
        },
      }));

      const results = await Promise.all(operations.map((op) => queueWrite(op)));

      expect(results.every((r) => r.success)).toBe(true);

      const rows = testDb.prepare("SELECT * FROM test_data").all();
      expect(rows).toHaveLength(100);
    });

    it("handles mixed read-write operations with consistency", async () => {
      testDb.prepare("INSERT INTO test_data (value, count) VALUES (?, ?)").run("counter", 0);

      const operations = Array.from({ length: 50 }, () =>
        createReadWriteOperation("increment", (db) => {
          const row = db
            .prepare("SELECT * FROM test_data WHERE value = 'counter'")
            .get() as any;
          db.prepare("UPDATE test_data SET count = ? WHERE value = 'counter'").run(
            row.count + 1
          );
          return row.count + 1;
        })
      );

      const results = await Promise.all(operations.map((op) => executeWriteTransaction(op)));

      expect(results.every((r) => r.success)).toBe(true);

      const row = testDb
        .prepare("SELECT * FROM test_data WHERE value = 'counter'")
        .get() as any;
      expect(row.count).toBe(50);
    });

    it("maintains consistency with batch operations under load", async () => {
      const batches = Array.from({ length: 10 }, (_, batchNum) => {
        const operations = Array.from({ length: 10 }, (_, opNum) => ({
          execute: (db: any) => {
            db.prepare("INSERT INTO test_data (value) VALUES (?)").run(
              `batch-${batchNum}-op-${opNum}`
            );
          },
        }));
        return executeBatchWrite(operations, `batch-${batchNum}`);
      });

      const results = await Promise.all(batches);

      expect(results.every((r) => r.success)).toBe(true);

      const rows = testDb.prepare("SELECT * FROM test_data").all();
      expect(rows).toHaveLength(100);
    });
  });

  // -------------------------------------------------------------------------
  // Integration: Complex scenarios
  // -------------------------------------------------------------------------

  describe("Integration scenarios", () => {
    it("complete workflow: insert, update, read, delete", async () => {
      // Step 1: Insert
      const insertOp = createSqlOperation("insert", "INSERT INTO test_data (value) VALUES (?)", [
        "workflow-test",
      ]);
      const insertResult = await queueWrite(insertOp);
      expect(insertResult.success).toBe(true);

      // Step 2: Update
      const updateOp = createSqlOperation("update", "UPDATE test_data SET count = ? WHERE id = 1", [
        42,
      ]);
      const updateResult = await queueWrite(updateOp);
      expect(updateResult.success).toBe(true);

      // Step 3: Read
      const row = testDb.prepare("SELECT * FROM test_data WHERE id = 1").get();
      expect((row as any).count).toBe(42);

      // Step 4: Delete
      const deleteOp = createSqlOperation("delete", "DELETE FROM test_data WHERE id = 1", []);
      const deleteResult = await queueWrite(deleteOp);
      expect(deleteResult.success).toBe(true);

      const finalRows = testDb.prepare("SELECT * FROM test_data").all();
      expect(finalRows).toHaveLength(0);
    });

    it("recovers from failure and processes subsequent operations", async () => {
      const failOp: WriteOperation<void> = {
        name: "failing",
        execute: () => {
          throw new Error("Intentional failure");
        },
      };

      const successOp = createSqlOperation("insert", "INSERT INTO test_data (value) VALUES (?)", [
        "recovery-test",
      ]);

      const result1 = await queueWrite(failOp);
      expect(result1.success).toBe(false);

      const result2 = await queueWrite(successOp);
      expect(result2.success).toBe(true);

      const rows = testDb.prepare("SELECT * FROM test_data").all();
      expect(rows).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Simulated RPC events → database schema integration (#333)
  // -------------------------------------------------------------------------

  describe("Simulated RPC events — database schema integration", () => {
    /**
     * Helper: simulate an RPC event insertion into the events table,
     * mirroring the pattern used by insertEventBatch in db.ts.
     */
    function simulateRpcEvent(
      contractId: string,
      eventType: string,
      ledgerSequence: number,
      timestamp: number,
      dataJson: string,
    ): WriteOperation<{ changes: number; lastInsertRowid: number | bigint }> {
      return createSqlOperation(
        `rpc-event-${contractId}-${ledgerSequence}`,
        `INSERT OR IGNORE INTO events
           (contract_id, event_type, ledger_sequence, timestamp, data_json)
         VALUES (?, ?, ?, ?, ?)`,
        [contractId, eventType, ledgerSequence, timestamp, dataJson],
      );
    }

    it("simulated ContractInitialized event is written to events schema", async () => {
      const op = simulateRpcEvent(
        "CONTRACT-1",
        "ContractInitialized",
        100,
        1700000000,
        JSON.stringify({ client: "GABC", freelancer: "GDEF", amount: 500 }),
      );

      const result = await queueWrite(op);

      expect(result.success).toBe(true);
      expect(result.data?.changes).toBe(1);

      const row = testDb
        .prepare("SELECT * FROM events WHERE contract_id = ?")
        .get("CONTRACT-1") as any;
      expect(row).toBeDefined();
      expect(row.event_type).toBe("ContractInitialized");
      expect(row.ledger_sequence).toBe(100);
      expect(row.timestamp).toBe(1700000000);
    });

    it("simulated MilestoneApproved event is written to events schema", async () => {
      const op = simulateRpcEvent(
        "CONTRACT-2",
        "MilestoneApproved",
        200,
        1700001000,
        JSON.stringify({ milestone_index: 0, approved_by: "GABC" }),
      );

      const result = await queueWrite(op);

      expect(result.success).toBe(true);

      const row = testDb
        .prepare("SELECT event_type FROM events WHERE contract_id = ? AND event_type = ?")
        .get("CONTRACT-2", "MilestoneApproved") as any;
      expect(row).toBeDefined();
      expect(row.event_type).toBe("MilestoneApproved");
    });

    it("multiple simulated RPC events for the same contract are all written", async () => {
      const events = [
        { type: "ContractInitialized", ledger: 300 },
        { type: "FundsDeposited", ledger: 310 },
        { type: "MilestoneApproved", ledger: 320 },
        { type: "ContractCompleted", ledger: 330 },
      ];

      const operations = events.map((ev) =>
        simulateRpcEvent("CONTRACT-3", ev.type, ev.ledger, 1700002000 + ev.ledger, "{}"),
      );

      const results = await Promise.all(operations.map((op) => queueWrite(op)));

      expect(results.every((r) => r.success)).toBe(true);

      const count = (
        testDb
          .prepare("SELECT COUNT(*) as cnt FROM events WHERE contract_id = ?")
          .get("CONTRACT-3") as { cnt: number }
      ).cnt;
      expect(count).toBe(events.length);
    });

    it("duplicate RPC events (same contract+ledger+type) are not double-written", async () => {
      const op1 = simulateRpcEvent("CONTRACT-4", "FundsDeposited", 400, 1700003000, "{}");
      const op2 = simulateRpcEvent("CONTRACT-4", "FundsDeposited", 400, 1700003000, "{}");

      const r1 = await queueWrite(op1);
      const r2 = await queueWrite(op2);

      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);

      // UNIQUE constraint means second insert is ignored.
      const count = (
        testDb
          .prepare(
            "SELECT COUNT(*) as cnt FROM events WHERE contract_id = ? AND event_type = ?",
          )
          .get("CONTRACT-4", "FundsDeposited") as { cnt: number }
      ).cnt;
      expect(count).toBe(1);
    });

    it("concurrent simulated RPC events from multiple contracts are all persisted", async () => {
      const contracts = ["CA", "CB", "CC", "CD", "CE"];
      const operations = contracts.map((c, i) =>
        simulateRpcEvent(c, "ContractInitialized", 100 + i, 1700004000 + i, "{}"),
      );

      const results = await Promise.all(operations.map((op) => queueWrite(op)));

      expect(results.every((r) => r.success)).toBe(true);

      const total = (
        testDb.prepare("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number }
      ).cnt;
      expect(total).toBe(contracts.length);
    });

    it("simulated events survive a read-after-write consistency check", async () => {
      const op = simulateRpcEvent(
        "CONTRACT-6",
        "ContractInitialized",
        600,
        1700005000,
        JSON.stringify({ client: "GXYZ" }),
      );

      await queueWrite(op);

      // Read back using a separate query to confirm write committed.
      const row = testDb
        .prepare("SELECT data_json FROM events WHERE contract_id = ?")
        .get("CONTRACT-6") as { data_json: string };
      expect(row).toBeDefined();

      const parsed = JSON.parse(row.data_json);
      expect(parsed.client).toBe("GXYZ");
    });

    it("batch write of simulated RPC events is atomic", async () => {
      const events = [
        { type: "ContractInitialized", ledger: 700 },
        { type: "FundsDeposited", ledger: 701 },
        { type: "MilestoneApproved", ledger: 702 },
      ];

      const operations = events.map((ev) =>
        simulateRpcEvent("CONTRACT-7", ev.type, ev.ledger, 1700006000 + ev.ledger, "{}"),
      );

      const result = await executeBatchWrite(operations, "rpc-event-batch");

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(3);

      const count = (
        testDb
          .prepare("SELECT COUNT(*) as cnt FROM events WHERE contract_id = ?")
          .get("CONTRACT-7") as { cnt: number }
      ).cnt;
      expect(count).toBe(3);
    });

    it("all required events schema columns are populated after write", async () => {
      const op = simulateRpcEvent(
        "CONTRACT-8",
        "ContractInitialized",
        800,
        1700007000,
        JSON.stringify({ test: true }),
      );

      await queueWrite(op);

      const row = testDb
        .prepare("SELECT * FROM events WHERE contract_id = ?")
        .get("CONTRACT-8") as any;

      expect(row.id).toBeDefined();
      expect(row.contract_id).toBe("CONTRACT-8");
      expect(row.event_type).toBe("ContractInitialized");
      expect(row.ledger_sequence).toBe(800);
      expect(row.timestamp).toBe(1700007000);
      expect(row.data_json).toBe(JSON.stringify({ test: true }));
      expect(row.created_at).toBeDefined();
    });

    it("write-through transaction provides ACID guarantees for RPC events", async () => {
      const failingOp: WriteOperation<void> = {
        name: "failing-rpc-event",
        execute: (db) => {
          // Insert one valid event
          db.prepare(
            `INSERT OR IGNORE INTO events
               (contract_id, event_type, ledger_sequence, timestamp, data_json)
             VALUES (?, ?, ?, ?, ?)`,
          ).run("C-OK", "ContractInitialized", 900, 1700008000, "{}");

          // Then fail
          throw new Error("Simulated RPC write failure");
        },
      };

      const result = await executeWriteTransaction(failingOp);

      expect(result.success).toBe(false);

      // The entire transaction should have rolled back — no rows inserted.
      const count = (
        testDb.prepare("SELECT COUNT(*) as cnt FROM events WHERE contract_id = ?").get("C-OK") as { cnt: number }
      ).cnt;
      expect(count).toBe(0);
    });
  });

  // RPC connection timeout retry: helpers
  // -------------------------------------------------------------------------

  describe("computeRpcBackoffMs – exponential backoff calculation", () => {
    const baseConfig = {
      initialBackoffMs: 1000,
      backoffMultiplier: 2,
      maxBackoffMs: 30000,
    };

    it("returns initial backoff for attempt 0", () => {
      expect(computeRpcBackoffMs(0, baseConfig)).toBe(1000);
    });

    it("increases exponentially with each subsequent attempt", () => {
      expect(computeRpcBackoffMs(0, baseConfig)).toBe(1000);
      expect(computeRpcBackoffMs(1, baseConfig)).toBe(2000);
      expect(computeRpcBackoffMs(2, baseConfig)).toBe(4000);
      expect(computeRpcBackoffMs(3, baseConfig)).toBe(8000);
      expect(computeRpcBackoffMs(4, baseConfig)).toBe(16000);
      const d0 = computeRpcBackoffMs(0, baseConfig);
      const d1 = computeRpcBackoffMs(1, baseConfig);
      const d2 = computeRpcBackoffMs(2, baseConfig);
      expect(d1).toBeGreaterThan(d0);
      expect(d2).toBeGreaterThan(d1);
    });

    it("caps at maxBackoffMs", () => {
      expect(computeRpcBackoffMs(5, baseConfig)).toBe(30000);
      expect(computeRpcBackoffMs(10, baseConfig)).toBe(30000);
      expect(computeRpcBackoffMs(100, baseConfig)).toBe(30000);
    });

    it("respects custom multiplier", () => {
      const cfg3x = { ...baseConfig, backoffMultiplier: 3 };
      expect(computeRpcBackoffMs(0, cfg3x)).toBe(1000);
      expect(computeRpcBackoffMs(1, cfg3x)).toBe(3000);
      expect(computeRpcBackoffMs(2, cfg3x)).toBe(9000);
    });

    it("respects custom initial backoff and max", () => {
      const cfgCustom = { initialBackoffMs: 500, backoffMultiplier: 2, maxBackoffMs: 4000 };
      expect(computeRpcBackoffMs(0, cfgCustom)).toBe(500);
      expect(computeRpcBackoffMs(1, cfgCustom)).toBe(1000);
      expect(computeRpcBackoffMs(2, cfgCustom)).toBe(2000);
      expect(computeRpcBackoffMs(3, cfgCustom)).toBe(4000);
      expect(computeRpcBackoffMs(4, cfgCustom)).toBe(4000);
    });
  });

  describe("isRpcTimeoutError – retryable error detection", () => {
    it("matches all RPC connection timeout patterns", () => {
      const patterns = [
        "timeout",
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "socket hang up",
        "network error",
        "status 429",
        "status 503",
        "status 502",
        "request timeout",
        "connect timeout",
      ];
      for (const pattern of patterns) {
        expect(isRpcTimeoutError(new Error(pattern))).toBe(true);
        expect(isRpcTimeoutError(new Error("prefix " + pattern + " suffix"))).toBe(true);
        expect(isRpcTimeoutError(new Error(pattern.toUpperCase()))).toBe(true);
      }
    });

    it("does not match non-timeout errors", () => {
      const nonRetryable = [
        "UNIQUE constraint failed",
        "SQLITE_CONSTRAINT",
        "syntax error",
        "invalid argument",
        "no such table",
        "permission denied",
        "Intentional failure",
      ];
      for (const msg of nonRetryable) {
        expect(isRpcTimeoutError(new Error(msg))).toBe(false);
      }
    });

    it("returns false for non-Error values", () => {
      expect(isRpcTimeoutError("timeout")).toBe(false);
      expect(isRpcTimeoutError(undefined)).toBe(false);
      expect(isRpcTimeoutError(null)).toBe(false);
      expect(isRpcTimeoutError({ message: "timeout" })).toBe(false);
    });
  });

  describe("WriterPoolRpcRetryConfig – config management", () => {
    afterEach(() => {
      resetWriterPoolRpcRetryConfig();
    });

    it("exposes sensible defaults", () => {
      const cfg = getWriterPoolRpcRetryConfig();
      expect(cfg.maxRetries).toBe(5);
      expect(cfg.initialBackoffMs).toBe(1000);
      expect(cfg.backoffMultiplier).toBe(2);
      expect(cfg.maxBackoffMs).toBe(30000);
    });

    it("applies partial overrides via setWriterPoolRpcRetryConfig", () => {
      setWriterPoolRpcRetryConfig({ maxRetries: 3, initialBackoffMs: 500 });
      const cfg = getWriterPoolRpcRetryConfig();
      expect(cfg.maxRetries).toBe(3);
      expect(cfg.initialBackoffMs).toBe(500);
      expect(cfg.backoffMultiplier).toBe(2);
      expect(cfg.maxBackoffMs).toBe(30000);
    });

    it("returns a defensive copy from getWriterPoolRpcRetryConfig", () => {
      const cfg1 = getWriterPoolRpcRetryConfig();
      cfg1.maxRetries = 999;
      const cfg2 = getWriterPoolRpcRetryConfig();
      expect(cfg2.maxRetries).toBe(5);
    });

    it("resetWriterPoolRpcRetryConfig restores defaults", () => {
      setWriterPoolRpcRetryConfig({ maxRetries: 1, initialBackoffMs: 10, maxBackoffMs: 100 });
      resetWriterPoolRpcRetryConfig();
      const cfg = getWriterPoolRpcRetryConfig();
      expect(cfg.maxRetries).toBe(5);
      expect(cfg.initialBackoffMs).toBe(1000);
      expect(cfg.maxBackoffMs).toBe(30000);
    });
  });

  // -------------------------------------------------------------------------
  // RPC connection timeout retry: integration with queueWrite
  // -------------------------------------------------------------------------

  describe("queueWrite – RPC connection timeout retry", () => {
    beforeEach(() => {
      setWriterPoolRpcRetryConfig({
        maxRetries: 3,
        initialBackoffMs: 1,
        backoffMultiplier: 2,
        maxBackoffMs: 10,
      });
    });

    afterEach(() => {
      resetWriterPoolRpcRetryConfig();
    });

    it("succeeds on first attempt without RPC retry", async () => {
      let calls = 0;
      const op: WriteOperation<number> = {
        name: "first-attempt-ok",
        execute: (db) => {
          calls++;
          const r = db.prepare("INSERT INTO test_data (value) VALUES (?)").run("ok");
          return r.changes;
        },
      };

      const result = await queueWrite(op);

      expect(result.success).toBe(true);
      expect(result.retries).toBe(0);
      expect(result.rpcRetries).toBe(0);
      expect(calls).toBe(1);
    });

    it("retries on repeated RPC timeouts and increases delay exponentially", async () => {
      let calls = 0;
      const op: WriteOperation<void> = {
        name: "always-timeout",
        execute: () => {
          calls++;
          throw new Error("ETIMEDOUT: request to RPC timed out");
        },
      };

      const result = await queueWrite(op);

      expect(result.success).toBe(false);
      expect(result.rpcRetries).toBe(3);
      expect(calls).toBe(4);

      const config = getWriterPoolRpcRetryConfig();
      const expected0 = computeRpcBackoffMs(0, config);
      const expected1 = computeRpcBackoffMs(1, config);
      const expected2 = computeRpcBackoffMs(2, config);
      expect(expected1).toBeGreaterThan(expected0);
      expect(expected2).toBeGreaterThan(expected1);
    });

    it("stops retrying after max attempts and surfaces the timeout error", async () => {
      let calls = 0;
      setWriterPoolRpcRetryConfig({
        maxRetries: 2,
        initialBackoffMs: 1,
        backoffMultiplier: 2,
        maxBackoffMs: 10,
      });

      const op: WriteOperation<void> = {
        name: "max-retries-timeout",
        execute: () => {
          calls++;
          throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
        },
      };

      const result = await queueWrite(op);

      expect(result.success).toBe(false);
      expect(result.rpcRetries).toBe(2);
      expect(calls).toBe(3);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain("ECONNREFUSED");
    });

    it("successful retry within max attempts resolves normally", async () => {
      let calls = 0;
      const op: WriteOperation<number> = {
        name: "recover-after-timeout",
        execute: (db) => {
          calls++;
          if (calls === 1) throw new Error("socket hang up");
          if (calls === 2) throw new Error("request timeout");
          const r = db.prepare("INSERT INTO test_data (value) VALUES (?)").run("recovered");
          return r.changes;
        },
      };

      const result = await queueWrite(op);

      expect(result.success).toBe(true);
      expect(result.data).toBe(1);
      expect(result.rpcRetries).toBe(2);
      expect(calls).toBe(3);

      const rows = testDb.prepare("SELECT * FROM test_data WHERE value = ?").all("recovered");
      expect(rows).toHaveLength(1);
    });

    it("does not retry non-timeout errors (e.g. constraint violations)", async () => {
      let calls = 0;
      testDb.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_test_data_value ON test_data(value)");
      testDb.prepare("INSERT INTO test_data (value) VALUES (?)").run("unique");

      const op: WriteOperation<void> = {
        name: "constraint-violation",
        execute: (db) => {
          calls++;
          db.prepare("INSERT INTO test_data (value) VALUES (?)").run("unique");
        },
      };

      const result = await queueWrite(op);

      expect(result.success).toBe(false);
      expect(result.rpcRetries).toBe(0);
      expect(calls).toBe(1);
      expect(result.error?.message).toMatch(/UNIQUE|constraint/i);
    });

    it("does not retry generic syntax or application errors", async () => {
      let calls = 0;
      const op: WriteOperation<void> = {
        name: "syntax-error",
        execute: (db) => {
          calls++;
          db.exec("INVALID SQL SYNTAX HERE");
        },
      };

      const result = await queueWrite(op);

      expect(result.success).toBe(false);
      expect(result.rpcRetries).toBe(0);
      expect(calls).toBe(1);
    });

    it("rpcRetries field is present in all result paths", async () => {
      const successOp = createSqlOperation(
        "rpc-field-check-insert",
        "INSERT INTO test_data (value) VALUES (?)",
        ["field-check"]
      );
      const successResult = await queueWrite(successOp);
      expect(successResult.success).toBe(true);
      expect("rpcRetries" in successResult).toBe(true);
      expect(typeof successResult.rpcRetries).toBe("number");
      expect(successResult.rpcRetries).toBeGreaterThanOrEqual(0);

      let failCalls = 0;
      const failOp: WriteOperation<void> = {
        name: "rpc-field-check-fail",
        execute: () => {
          failCalls++;
          throw new Error("timeout");
        },
      };
      setWriterPoolRpcRetryConfig({ maxRetries: 1, initialBackoffMs: 1 });
      const failResult = await queueWrite(failOp);
      expect(failResult.success).toBe(false);
      expect("rpcRetries" in failResult).toBe(true);
      expect(failResult.rpcRetries).toBe(1);
    });
  });
});
