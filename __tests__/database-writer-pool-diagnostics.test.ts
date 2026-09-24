import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import { setDb, runMigrations, closeDb } from "../src/indexer/db.js";
import {
  createReadWriteOperation,
  createSqlOperation,
  executeBatchWrite,
  flushWriteQueue,
  logWriterPoolDiagnostics,
  queueWrite,
  resetWriterPoolStartState,
  startWriterPool,
  writerPoolPayloadSizeBytes,
} from "../src/indexer/database-writer-pool.js";
import logger from "../src/utils/logger.js";

type DebugCall = [string, any];

/** Winston's logger methods are overloaded, so spies are handled untyped. */
function spyOnLogger(method: "debug" | "info" | "warn" | "error"): any {
  return jest.spyOn(logger, method).mockImplementation((() => logger) as never);
}

function poolDiagnostics(spy: any): DebugCall[] {
  return (spy.mock.calls as DebugCall[]).filter((call) =>
    String(call[0]).includes("database_writer_pool poll diagnostics"),
  );
}

function diagnosticsFor(spy: any, operation: string): DebugCall[] {
  return poolDiagnostics(spy).filter((call) => call[1]?.operation === operation);
}

/** Pull a `key=value` token out of a diagnostic message string. */
function readTag(message: string, key: string): string | undefined {
  const match = new RegExp(`${key}=([^\\s]+)`).exec(message);
  return match ? match[1] : undefined;
}

describe("database_writer_pool – polling diagnostics (#328)", () => {
  let testDb: Database.Database;
  let debugSpy: any;

  beforeEach(async () => {
    testDb = new Database(":memory:");
    setDb(testDb);
    runMigrations();
    testDb.exec(
      "CREATE TABLE IF NOT EXISTS wp_diag (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)",
    );
    resetWriterPoolStartState();
    await flushWriteQueue();
    debugSpy = spyOnLogger("debug");
  });

  afterEach(async () => {
    await flushWriteQueue();
    debugSpy.mockRestore();
    resetWriterPoolStartState();
    closeDb();
  });

  describe("logWriterPoolDiagnostics", () => {
    it("logs a debug string containing elapsed time and payload size", () => {
      logWriterPoolDiagnostics({
        pool: "database_writer_pool",
        operation: "insert-event",
        status: "success",
        elapsedMs: 12.345,
        payloadSizeBytes: 2048,
        queueDepth: 3,
      });

      expect(debugSpy).toHaveBeenCalledTimes(1);
      const [message, meta] = (debugSpy.mock.calls as DebugCall[])[0];

      expect(message).toEqual(expect.stringContaining("elapsedMs=12.345"));
      expect(message).toEqual(expect.stringContaining("payloadSizeBytes=2048"));
      expect(message).toEqual(expect.stringContaining("queueDepth=3"));
      expect(message).toEqual(expect.stringContaining("operation=insert-event"));
      expect(message).toEqual(expect.stringContaining("status=success"));
      expect(meta).toMatchObject({
        pool: "database_writer_pool",
        operation: "insert-event",
        status: "success",
        elapsedMs: 12.345,
        payloadSizeBytes: 2048,
        queueDepth: 3,
      });
    });

    it("still carries elapsed time when the optional fields are unknown", () => {
      logWriterPoolDiagnostics({
        pool: "database_writer_pool",
        operation: "insert-event",
        status: "started",
        elapsedMs: 0,
      });

      const [message] = (debugSpy.mock.calls as DebugCall[])[0];
      expect(message).toEqual(expect.stringContaining("elapsedMs=0"));
      expect(message).not.toEqual(expect.stringContaining("payloadSizeBytes="));
      expect(message).not.toEqual(expect.stringContaining("queueDepth="));
    });

    it("carries the attempt number and error on a retry diagnostic", () => {
      logWriterPoolDiagnostics({
        pool: "database_writer_pool",
        operation: "insert-event",
        status: "retry",
        elapsedMs: 7,
        attempt: 2,
        error: "database is locked",
      });

      const [message, meta] = (debugSpy.mock.calls as DebugCall[])[0];
      expect(message).toEqual(expect.stringContaining("status=retry"));
      expect(message).toEqual(expect.stringContaining("attempt=2"));
      expect(meta.error).toBe("database is locked");
    });
  });

  describe("writerPoolPayloadSizeBytes", () => {
    it("measures the JSON byte size of a payload", () => {
      expect(writerPoolPayloadSizeBytes({ changes: 1 })).toBe(
        Buffer.byteLength(JSON.stringify({ changes: 1 }), "utf8"),
      );
      expect(writerPoolPayloadSizeBytes([])).toBe(2);
      expect(writerPoolPayloadSizeBytes(null)).toBe(4);
      expect(writerPoolPayloadSizeBytes(undefined)).toBe(4);
    });

    it("returns 0 for a non-serializable payload instead of throwing", () => {
      const circular: any = {};
      circular.self = circular;

      expect(writerPoolPayloadSizeBytes(circular)).toBe(0);
    });
  });

  describe("instrumented writes", () => {
    it("emits an enqueue and a success diagnostic with elapsed time", async () => {
      await queueWrite(
        createSqlOperation("insert-diag", "INSERT INTO wp_diag (value) VALUES (?)", [
          "a",
        ]),
      );

      const calls = diagnosticsFor(debugSpy, "insert-diag");
      expect(calls.length).toBeGreaterThanOrEqual(2);

      const statuses = calls.map((call) => call[1].status);
      expect(statuses).toContain("started");
      expect(statuses).toContain("success");

      for (const [message, meta] of calls) {
        expect(message).toEqual(expect.stringContaining("elapsedMs="));
        expect(Number(readTag(message, "elapsedMs"))).toBeGreaterThanOrEqual(0);
        expect(meta.elapsedMs).toBeGreaterThanOrEqual(0);
      }
    });

    it("reports the payload size of the write result", async () => {
      await queueWrite(
        createSqlOperation("sized", "INSERT INTO wp_diag (value) VALUES (?)", ["a"]),
      );

      const success = diagnosticsFor(debugSpy, "sized").find(
        (call) => call[1].status === "success",
      );

      expect(success).toBeDefined();
      expect(success![1].payloadSizeBytes).toBeGreaterThan(0);
      expect(success![0]).toEqual(expect.stringContaining("payloadSizeBytes="));
    });

    it("scales the reported payload size with the returned data", async () => {
      const small = await queueWrite(
        createReadWriteOperation("small", () => ({ n: 1 })),
      );
      const large = await queueWrite(
        createReadWriteOperation("large", () =>
          Array.from({ length: 200 }, (_, i) => ({ i, value: `row-${i}` })),
        ),
      );

      expect(small.success && large.success).toBe(true);

      const smallBytes = diagnosticsFor(debugSpy, "small").find(
        (c) => c[1].status === "success",
      )![1].payloadSizeBytes;
      const largeBytes = diagnosticsFor(debugSpy, "large").find(
        (c) => c[1].status === "success",
      )![1].payloadSizeBytes;

      expect(largeBytes).toBeGreaterThan(smallBytes);
    });

    it("reports the queue depth on enqueue", async () => {
      const writes = [
        queueWrite(
          createSqlOperation("depth", "INSERT INTO wp_diag (value) VALUES (?)", ["1"]),
        ),
        queueWrite(
          createSqlOperation("depth", "INSERT INTO wp_diag (value) VALUES (?)", ["2"]),
        ),
        queueWrite(
          createSqlOperation("depth", "INSERT INTO wp_diag (value) VALUES (?)", ["3"]),
        ),
      ];
      await Promise.all(writes);

      const depths = diagnosticsFor(debugSpy, "depth")
        .filter((call) => call[1].status === "started")
        .map((call) => call[1].queueDepth);

      expect(depths.some((depth) => depth >= 1)).toBe(true);
      expect(Math.max(...depths)).toBeGreaterThan(1);
    });

    it("emits a failure diagnostic with elapsed time when a write fails", async () => {
      const result = await queueWrite(
        createSqlOperation("bad-sql", "INSERT INTO missing_table (v) VALUES (?)", ["x"]),
      );

      expect(result.success).toBe(false);

      const failure = diagnosticsFor(debugSpy, "bad-sql").find(
        (call) => call[1].status === "failure",
      );
      expect(failure).toBeDefined();
      expect(failure![0]).toEqual(expect.stringContaining("elapsedMs="));
      expect(failure![1].elapsedMs).toBeGreaterThanOrEqual(0);
      expect(failure![1].error).toEqual(expect.stringContaining("missing_table"));
    });

    it("emits a drain diagnostic covering the whole queue pass", async () => {
      await Promise.all([
        queueWrite(
          createSqlOperation("drain", "INSERT INTO wp_diag (value) VALUES (?)", ["1"]),
        ),
        queueWrite(
          createSqlOperation("drain", "INSERT INTO wp_diag (value) VALUES (?)", ["2"]),
        ),
      ]);
      await flushWriteQueue();

      const drains = diagnosticsFor(debugSpy, "drain_write_queue");
      expect(drains.length).toBeGreaterThanOrEqual(1);
      const [message, meta] = drains[drains.length - 1];
      expect(message).toEqual(expect.stringContaining("elapsedMs="));
      expect(meta.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(meta.queueDepth).toBe(0);
    });

    it("instruments batch writes as a single composite operation", async () => {
      await executeBatchWrite(
        [
          createSqlOperation("b1", "INSERT INTO wp_diag (value) VALUES (?)", ["1"]),
          createSqlOperation("b2", "INSERT INTO wp_diag (value) VALUES (?)", ["2"]),
        ],
        "batch-diag",
      );

      const calls = diagnosticsFor(debugSpy, "batch-diag");
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls.some((call) => call[1].status === "success")).toBe(true);
      for (const [message] of calls) {
        expect(message).toEqual(expect.stringContaining("elapsedMs="));
      }
    });

    it("instruments the pool start", () => {
      startWriterPool();

      const calls = diagnosticsFor(debugSpy, "start_writer_pool");
      expect(calls.map((call) => call[1].status)).toEqual(["started", "success"]);
      for (const [message] of calls) {
        expect(message).toEqual(expect.stringContaining("elapsedMs="));
      }
    });

    it("instruments a failed start with elapsed time", () => {
      testDb.exec("DROP TABLE schema_migrations");

      expect(() => startWriterPool()).toThrow();

      const failure = diagnosticsFor(debugSpy, "start_writer_pool").find(
        (call) => call[1].status === "failure",
      );
      expect(failure).toBeDefined();
      expect(failure![0]).toEqual(expect.stringContaining("elapsedMs="));
      expect(failure![1].elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it("every diagnostic message carries a numeric elapsedMs", async () => {
      await queueWrite(
        createSqlOperation("all-diag", "INSERT INTO wp_diag (value) VALUES (?)", ["a"]),
      );
      await flushWriteQueue();

      const calls = poolDiagnostics(debugSpy);
      expect(calls.length).toBeGreaterThanOrEqual(3);
      for (const [message, meta] of calls) {
        const tag = readTag(message, "elapsedMs");
        expect(tag).toBeDefined();
        expect(Number.isNaN(Number(tag))).toBe(false);
        expect(meta.elapsedMs).toBeGreaterThanOrEqual(0);
        expect(meta.pool).toBe("database_writer_pool");
      }
    });

    it("keeps diagnostics at debug level for successful writes", async () => {
      const infoSpy = spyOnLogger("info");
      const errorSpy = spyOnLogger("error");

      await queueWrite(
        createSqlOperation("quiet", "INSERT INTO wp_diag (value) VALUES (?)", ["a"]),
      );

      expect(poolDiagnostics(debugSpy).length).toBeGreaterThan(0);
      expect(infoSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();

      infoSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });
});
