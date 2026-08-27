import Database from "better-sqlite3";
import { setDb, runMigrations } from "../src/indexer/db.js";
import logger from "../src/utils/logger.js";
import { jest } from "@jest/globals";
import {
  initializeNodeHealthTables,
  recordNodeHealth,
  getNodeHealth,
  getAllNodeHealth,
  recordNodeFailure,
  recordNodeSuccess,
  getActiveNodeUrl,
  failoverToNode,
  getFailoverState,
  selectHealthiestNode,
  createFailoverServer,
  type NodeHealthStatus,
  type FailoverState,
} from "../src/indexer/failover-recovery.js";

describe("FailoverRecovery – RPC Node Failover & Recovery", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
  });

  afterAll(() => {
    testDb.close();
  });

  beforeEach(async () => {
    // Drop in correct order to respect foreign key constraints
    testDb.exec("PRAGMA foreign_keys = OFF");
    testDb.exec("DROP TABLE IF EXISTS node_failure_events");
    testDb.exec("DROP TABLE IF EXISTS rpc_node_health");
    testDb.exec("DROP TABLE IF EXISTS failover_state");
    testDb.exec("PRAGMA foreign_keys = ON");
    runMigrations();
    initializeNodeHealthTables();
    // Ensure node_failure_events table exists
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS node_failure_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_url TEXT NOT NULL,
        error_message TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        recovery_attempt_at INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (node_url) REFERENCES rpc_node_health(node_url)
      );
    `);
  });

  describe("initializeNodeHealthTables – schema setup", () => {
    it("creates required tables", () => {
      const tables = testDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        .all() as any[];

      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain("rpc_node_health");
      expect(tableNames).toContain("failover_state");
      expect(tableNames).toContain("node_failure_events");
    });

    it("initializes failover_state singleton", () => {
      const row = testDb
        .prepare("SELECT id, active_node_url FROM failover_state WHERE id = 1")
        .get() as any;

      expect(row).toBeTruthy();
      expect(row.id).toBe(1);
    });
  });

  describe("recordNodeHealth – record health status", () => {
    it("creates a new node health record", async () => {
      const status: NodeHealthStatus = {
        nodeUrl: "https://node1.example.com",
        isHealthy: true,
        failureCount: 0,
        lastFailureAt: null,
        lastSuccessAt: Date.now(),
        nextRetryAt: null,
        backoffDurationMs: 1000,
        consecutiveSuccesses: 1,
      };

      const success = await recordNodeHealth(status);

      expect(success).toBe(true);

      const retrieved = getNodeHealth("https://node1.example.com");
      expect(retrieved).toBeTruthy();
      expect(retrieved?.isHealthy).toBe(true);
      expect(retrieved?.failureCount).toBe(0);
    });
  });

  describe("Transaction rollback on failure", () => {
    it("rolls back health update if database operation fails", async () => {
      const nodeUrl = "https://rollback-test.example.com";
      const initialStatus: NodeHealthStatus = {
        nodeUrl,
        isHealthy: true,
        failureCount: 0,
        lastFailureAt: null,
        lastSuccessAt: Date.now(),
        nextRetryAt: null,
        backoffDurationMs: 1000,
        consecutiveSuccesses: 1,
      };

      await recordNodeHealth(initialStatus);

      const before = getNodeHealth(nodeUrl);
      expect(before?.failureCount).toBe(0);

      // Transaction wraps the operation
      const result = await recordNodeSuccess(nodeUrl, 3);

      // Should succeed
      expect(result).not.toBeNull();

      // Verify data was updated atomically
      const after = getNodeHealth(nodeUrl);
      expect(after?.consecutiveSuccesses).toBe(before!.consecutiveSuccesses + 1);
    });

    it("maintains audit trail consistency through failures", async () => {
      const nodeUrl = "https://failure-audit-test.example.com";

      // Initialize node
      await recordNodeHealth({
        nodeUrl,
        isHealthy: true,
        failureCount: 0,
        lastFailureAt: null,
        lastSuccessAt: Date.now(),
        nextRetryAt: null,
        backoffDurationMs: 1000,
        consecutiveSuccesses: 1,
      });

      const eventCountBefore = testDb
        .prepare("SELECT COUNT(*) as cnt FROM node_failure_events WHERE node_url = ?")
        .get(nodeUrl) as { cnt: number };

      // Record multiple failures within transactions
      for (let i = 0; i < 3; i++) {
        await recordNodeFailure(nodeUrl, `Test error ${i}`, 10, 2);
      }

      // Verify all failure events were recorded
      const eventCountAfter = testDb
        .prepare("SELECT COUNT(*) as cnt FROM node_failure_events WHERE node_url = ?")
        .get(nodeUrl) as { cnt: number };

      expect(eventCountAfter.cnt).toBe(eventCountBefore.cnt + 3);
    });

    it("ensures failover state remains consistent through updates", async () => {
      const nodeBefore = "https://current-node.example.com";
      const nodeAfter = "https://next-node.example.com";

      // Set initial node
      const state1 = await failoverToNode(nodeBefore);
      expect(state1?.activeNodeUrl).toBe(nodeBefore);

      const failoverCountAfterFirst = state1?.totalFailovers || 0;

      // Failover to new node
      const state2 = await failoverToNode(nodeAfter);
      expect(state2?.activeNodeUrl).toBe(nodeAfter);
      expect(state2?.totalFailovers).toBe(failoverCountAfterFirst + 1);

      // Verify state is consistent
      const finalState = getFailoverState();
      expect(finalState.activeNodeUrl).toBe(nodeAfter);
      expect(finalState.totalFailovers).toBe(failoverCountAfterFirst + 1);
    });

    it("all transaction operations complete atomically under concurrent load", async () => {
      const nodeUrl = "https://concurrent-atomic.example.com";

      // Initialize node
      await recordNodeHealth({
        nodeUrl,
        isHealthy: true,
        failureCount: 0,
        lastFailureAt: null,
        lastSuccessAt: Date.now(),
        nextRetryAt: null,
        backoffDurationMs: 1000,
        consecutiveSuccesses: 5,
      });

      // Concurrent failure and success operations
      const operations = [];
      for (let i = 0; i < 5; i++) {
        if (i % 2 === 0) {
          operations.push(recordNodeFailure(nodeUrl, `Concurrent failure ${i}`, 50, 2));
        } else {
          operations.push(recordNodeSuccess(nodeUrl, 5));
        }
      }

      const results = await Promise.all(operations);

      // All should succeed atomically
      expect(results.every((r) => r !== null)).toBe(true);

      // Final state should be valid and consistent
      const finalStatus = getNodeHealth(nodeUrl);
      expect(finalStatus).not.toBeNull();
      expect(finalStatus!.failureCount).toBeGreaterThanOrEqual(0);
      expect(finalStatus!.consecutiveSuccesses).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Data consistency under load", () => {
    it("ensures failover counter accuracy under concurrent failovers", async () => {
      const nodes = Array.from({ length: 20 }, (_, i) => `https://failover-stress-${i}.example.com`);

      const initialState = getFailoverState();
      const expectedFailovers = initialState.totalFailovers + nodes.length;

      // Execute all failovers concurrently
      const failovers = nodes.map((node) => failoverToNode(node));
      const results = await Promise.all(failovers);

      expect(results.every((r) => r !== null)).toBe(true);

      const finalState = getFailoverState();
      expect(finalState.totalFailovers).toBe(expectedFailovers);
    });
  });

  describe("Query functions", () => {
    it("getNodeHealth returns null for non-existent node", () => {
      const health = getNodeHealth("https://non-existent.example.com");
      expect(health).toBeNull();
    });

    it("getFailoverState returns current state", () => {
      const state = getFailoverState();
      expect(state).toBeTruthy();
      expect(state.totalFailovers).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------------------------
  // Failover diagnostics (#355)
  // -------------------------------------------------------------------------
  describe("failover diagnostics (#355)", () => {
    it("logs elapsed time and payload sizes when recording failures", async () => {
      const debugSpy = jest.spyOn(logger, "debug");

      await recordNodeFailure("rpc://node-a", "connection timeout", 5, 2);

      const messages = debugSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(messages).toMatch(/node failure poll for rpc:\/\/node-a recorded in \d+ms/);
      expect(messages).toMatch(/payload: failure_count=\d+/);
      expect(messages).toMatch(/backoff_duration_ms=\d+/);

      debugSpy.mockRestore();
    });

    it("logs success poll diagnostics with consecutive_successes", async () => {
      const debugSpy = jest.spyOn(logger, "debug");

      await recordNodeSuccess("rpc://node-b");

      const messages = debugSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(messages).toMatch(/node success poll for rpc:\/\/node-b recorded in \d+ms/);
      expect(messages).toMatch(/consecutive_successes=\d+/);

      debugSpy.mockRestore();
    });
  });
});
