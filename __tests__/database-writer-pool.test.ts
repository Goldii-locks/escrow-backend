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
      let executionOrder: string[] = [];

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
});
