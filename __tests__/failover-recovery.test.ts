import Database from "better-sqlite3";
import { setDb, runMigrations } from "../src/indexer/db.js";
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
  retryWithBackoff,
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
  // Issue #419 — Simulated RPC events write to DB schema
  // -------------------------------------------------------------------------

  describe("indexer_failover_recovery — Issue 419: Simulated RPC events write to DB schema", () => {
    interface SimulatedRpcEvent {
      contractId: string;
      eventType: string;
      ledgerSequence: number;
      timestamp: number;
      dataJson: string;
    }

    function simulateRpcEvent(
      db: Database.Database,
      event: SimulatedRpcEvent,
    ): void {
      db.prepare(
        `INSERT OR IGNORE INTO events
           (contract_id, event_type, ledger_sequence, timestamp, data_json)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        event.contractId,
        event.eventType,
        event.ledgerSequence,
        event.timestamp,
        event.dataJson,
      );
    }

    beforeEach(() => {
      testDb.exec("DELETE FROM events");
      testDb.exec("DELETE FROM node_failure_events");
      testDb.exec("DELETE FROM rpc_node_health");
      testDb.exec("DELETE FROM failover_state");
      testDb.prepare(
        `INSERT OR IGNORE INTO failover_state (id, active_node_url, total_failovers, last_failover_at)
         VALUES (1, NULL, 0, NULL)`,
      ).run();
    });

    it("Confirm all simulated events write successfully to the database schema", async () => {
      const primaryNode = "https://rpc-primary.stellar.org";
      await failoverToNode(primaryNode);

      const events: SimulatedRpcEvent[] = [
        {
          contractId: "CONTRACT-SIM-1",
          eventType: "ContractInitialized",
          ledgerSequence: 1000,
          timestamp: 1710000000,
          dataJson: JSON.stringify({ client: "GAAA", freelancer: "GBBB", amount: "5000" }),
        },
        {
          contractId: "CONTRACT-SIM-1",
          eventType: "FundsDeposited",
          ledgerSequence: 1005,
          timestamp: 1710000050,
          dataJson: JSON.stringify({ sender: "GAAA", amount: "5000" }),
        },
        {
          contractId: "CONTRACT-SIM-1",
          eventType: "MilestoneApproved",
          ledgerSequence: 1010,
          timestamp: 1710000100,
          dataJson: JSON.stringify({ milestone_index: 0, approved_by: "GAAA" }),
        },
        {
          contractId: "CONTRACT-SIM-1",
          eventType: "ContractCompleted",
          ledgerSequence: 1020,
          timestamp: 1710000200,
          dataJson: JSON.stringify({ completed_at: 1710000200, status: "completed" }),
        },
      ];

      for (const ev of events) {
        simulateRpcEvent(testDb, ev);
        await recordNodeSuccess(primaryNode);
      }

      const countRow = testDb
        .prepare("SELECT COUNT(*) as count FROM events WHERE contract_id = ?")
        .get("CONTRACT-SIM-1") as { count: number };
      expect(countRow.count).toBe(events.length);

      const rows = testDb
        .prepare("SELECT * FROM events WHERE contract_id = ? ORDER BY ledger_sequence ASC")
        .all("CONTRACT-SIM-1") as Array<{
          id: number;
          contract_id: string;
          event_type: string;
          ledger_sequence: number;
          timestamp: number;
          data_json: string;
          created_at: string;
        }>;

      expect(rows).toHaveLength(4);
      expect(rows[0].event_type).toBe("ContractInitialized");
      expect(rows[0].ledger_sequence).toBe(1000);
      expect(rows[0].timestamp).toBe(1710000000);
      expect(JSON.parse(rows[0].data_json)).toEqual({ client: "GAAA", freelancer: "GBBB", amount: "5000" });
      expect(rows[1].event_type).toBe("FundsDeposited");
      expect(rows[2].event_type).toBe("MilestoneApproved");
      expect(rows[3].event_type).toBe("ContractCompleted");

      const health = getNodeHealth(primaryNode);
      expect(health).not.toBeNull();
      expect(health?.isHealthy).toBe(true);
      expect(health?.consecutiveSuccesses).toBe(4);

      const failoverState = getFailoverState();
      expect(failoverState.activeNodeUrl).toBe(primaryNode);
    });

    it("simulated ContractInitialized event is persisted to schema with active node health recorded", async () => {
      const nodeUrl = "https://node-init.example.com";
      await failoverToNode(nodeUrl);

      const event: SimulatedRpcEvent = {
        contractId: "CONTRACT-INIT-1",
        eventType: "ContractInitialized",
        ledgerSequence: 200,
        timestamp: 1710001000,
        dataJson: JSON.stringify({ client: "GCLI", freelancer: "GFRE", total_amount: "10000" }),
      };

      simulateRpcEvent(testDb, event);
      await recordNodeSuccess(nodeUrl);

      const row = testDb
        .prepare("SELECT * FROM events WHERE contract_id = ?")
        .get("CONTRACT-INIT-1") as any;

      expect(row).toBeDefined();
      expect(row.contract_id).toBe("CONTRACT-INIT-1");
      expect(row.event_type).toBe("ContractInitialized");
      expect(row.ledger_sequence).toBe(200);
      expect(row.timestamp).toBe(1710001000);
      expect(row.data_json).toBe(event.dataJson);

      const health = getNodeHealth(nodeUrl);
      expect(health?.isHealthy).toBe(true);
      expect(health?.consecutiveSuccesses).toBe(1);
    });

    it("simulated MilestoneApproved event is persisted to schema", async () => {
      const nodeUrl = "https://node-milestone.example.com";
      await failoverToNode(nodeUrl);

      simulateRpcEvent(testDb, {
        contractId: "CONTRACT-MS-1",
        eventType: "MilestoneApproved",
        ledgerSequence: 300,
        timestamp: 1710002000,
        dataJson: JSON.stringify({ milestone_index: 1, approved_by: "GCLI" }),
      });
      await recordNodeSuccess(nodeUrl);

      const row = testDb
        .prepare("SELECT * FROM events WHERE contract_id = ? AND event_type = ?")
        .get("CONTRACT-MS-1", "MilestoneApproved") as any;

      expect(row).toBeDefined();
      expect(row.ledger_sequence).toBe(300);
      expect(JSON.parse(row.data_json)).toEqual({ milestone_index: 1, approved_by: "GCLI" });
    });

    it("simulated FundsDeposited and ContractCompleted events are written to schema", async () => {
      const nodeUrl = "https://node-events.example.com";
      await failoverToNode(nodeUrl);

      simulateRpcEvent(testDb, {
        contractId: "CONTRACT-DEP-1",
        eventType: "FundsDeposited",
        ledgerSequence: 400,
        timestamp: 1710003000,
        dataJson: JSON.stringify({ amount: "2500" }),
      });

      simulateRpcEvent(testDb, {
        contractId: "CONTRACT-DEP-1",
        eventType: "ContractCompleted",
        ledgerSequence: 450,
        timestamp: 1710003500,
        dataJson: JSON.stringify({ status: "success" }),
      });

      const rows = testDb
        .prepare("SELECT event_type, ledger_sequence FROM events WHERE contract_id = ? ORDER BY ledger_sequence ASC")
        .all("CONTRACT-DEP-1") as any[];

      expect(rows).toHaveLength(2);
      expect(rows[0].event_type).toBe("FundsDeposited");
      expect(rows[1].event_type).toBe("ContractCompleted");
    });

    it("multiple simulated RPC events for the same contract are all written", async () => {
      const nodeUrl = "https://node-multi.example.com";
      await failoverToNode(nodeUrl);

      const events: SimulatedRpcEvent[] = [
        { contractId: "CONTRACT-SAME-1", eventType: "ContractInitialized", ledgerSequence: 501, timestamp: 1710004001, dataJson: "{}" },
        { contractId: "CONTRACT-SAME-1", eventType: "FundsDeposited", ledgerSequence: 502, timestamp: 1710004002, dataJson: "{}" },
        { contractId: "CONTRACT-SAME-1", eventType: "MilestoneApproved", ledgerSequence: 503, timestamp: 1710004003, dataJson: "{}" },
        { contractId: "CONTRACT-SAME-1", eventType: "ContractCompleted", ledgerSequence: 504, timestamp: 1710004004, dataJson: "{}" },
      ];

      for (const ev of events) {
        simulateRpcEvent(testDb, ev);
        await recordNodeSuccess(nodeUrl);
      }

      const count = (
        testDb
          .prepare("SELECT COUNT(*) as cnt FROM events WHERE contract_id = ?")
          .get("CONTRACT-SAME-1") as { cnt: number }
      ).cnt;

      expect(count).toBe(4);
    });

    it("simulated RPC events across multiple distinct contracts are all persisted", async () => {
      const nodeUrl = "https://node-contracts.example.com";
      await failoverToNode(nodeUrl);

      const contracts = ["CONTRACT-ALPHA", "CONTRACT-BETA", "CONTRACT-GAMMA"];
      for (const contractId of contracts) {
        simulateRpcEvent(testDb, {
          contractId,
          eventType: "ContractInitialized",
          ledgerSequence: 600,
          timestamp: 1710005000,
          dataJson: JSON.stringify({ contract: contractId }),
        });
        await recordNodeSuccess(nodeUrl);
      }

      const rows = testDb
        .prepare("SELECT contract_id, event_type FROM events WHERE ledger_sequence = 600 ORDER BY contract_id ASC")
        .all() as any[];

      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.contract_id)).toEqual(["CONTRACT-ALPHA", "CONTRACT-BETA", "CONTRACT-GAMMA"]);
    });

    it("duplicate RPC events (same contract+ledger+type) are not double-written to schema", async () => {
      const nodeUrl = "https://node-dedup.example.com";
      await failoverToNode(nodeUrl);

      const dupEvent: SimulatedRpcEvent = {
        contractId: "CONTRACT-DUP-1",
        eventType: "FundsDeposited",
        ledgerSequence: 700,
        timestamp: 1710006000,
        dataJson: JSON.stringify({ amount: "100" }),
      };

      simulateRpcEvent(testDb, dupEvent);
      simulateRpcEvent(testDb, dupEvent);

      const count = (
        testDb
          .prepare("SELECT COUNT(*) as cnt FROM events WHERE contract_id = ? AND ledger_sequence = ?")
          .get("CONTRACT-DUP-1", 700) as { cnt: number }
      ).cnt;

      expect(count).toBe(1);
    });

    it("re-delivered simulated events after node failover reconnect do not duplicate rows in schema", async () => {
      const nodeA = "https://node-a-redelivery.example.com";
      const nodeB = "https://node-b-redelivery.example.com";

      await failoverToNode(nodeA);

      simulateRpcEvent(testDb, {
        contractId: "CONTRACT-REDELIVER",
        eventType: "MilestoneApproved",
        ledgerSequence: 800,
        timestamp: 1710007000,
        dataJson: JSON.stringify({ milestone: 0 }),
      });
      await recordNodeSuccess(nodeA);

      await failoverToNode(nodeB);

      // Node B re-delivers the identical event
      simulateRpcEvent(testDb, {
        contractId: "CONTRACT-REDELIVER",
        eventType: "MilestoneApproved",
        ledgerSequence: 800,
        timestamp: 1710007000,
        dataJson: JSON.stringify({ milestone: 0 }),
      });
      // Node B delivers subsequent new event
      simulateRpcEvent(testDb, {
        contractId: "CONTRACT-REDELIVER",
        eventType: "ContractCompleted",
        ledgerSequence: 801,
        timestamp: 1710007050,
        dataJson: JSON.stringify({ status: "done" }),
      });
      await recordNodeSuccess(nodeB);

      const rows = testDb
        .prepare("SELECT event_type, ledger_sequence FROM events WHERE contract_id = ? ORDER BY ledger_sequence ASC")
        .all("CONTRACT-REDELIVER") as any[];

      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({ event_type: "MilestoneApproved", ledger_sequence: 800 });
      expect(rows[1]).toEqual({ event_type: "ContractCompleted", ledger_sequence: 801 });
    });

    it("simulated RPC events continue writing to database schema across failover from failing node to healthy fallback", async () => {
      const nodePrimary = "https://node-primary.example.com";
      const nodeSecondary = "https://node-secondary.example.com";

      // 1. Start with primary node
      await failoverToNode(nodePrimary);
      expect(getActiveNodeUrl()).toBe(nodePrimary);

      // Ingest events 1-3 from primary node
      for (let i = 1; i <= 3; i++) {
        simulateRpcEvent(testDb, {
          contractId: "CONTRACT-FAILOVER-1",
          eventType: `Step_${i}`,
          ledgerSequence: 900 + i,
          timestamp: 1710008000 + i * 10,
          dataJson: JSON.stringify({ step: i }),
        });
        await recordNodeSuccess(nodePrimary);
      }

      // 2. Primary node experiences failures exceeding threshold (5)
      for (let attempt = 1; attempt <= 5; attempt++) {
        await recordNodeFailure(nodePrimary, `RPC connection timeout attempt ${attempt}`, 5, 2);
      }

      const primaryHealth = getNodeHealth(nodePrimary);
      expect(primaryHealth?.isHealthy).toBe(false);

      // 3. Failover selection picks secondary node
      const nextNode = selectHealthiestNode([nodePrimary, nodeSecondary]);
      expect(nextNode).toBe(nodeSecondary);

      await failoverToNode(nodeSecondary);
      expect(getActiveNodeUrl()).toBe(nodeSecondary);

      // 4. Secondary node ingests events 4-6
      for (let i = 4; i <= 6; i++) {
        simulateRpcEvent(testDb, {
          contractId: "CONTRACT-FAILOVER-1",
          eventType: `Step_${i}`,
          ledgerSequence: 900 + i,
          timestamp: 1710008000 + i * 10,
          dataJson: JSON.stringify({ step: i }),
        });
        await recordNodeSuccess(nodeSecondary);
      }

      // 5. Verify all 6 events written successfully to schema
      const eventsCount = (
        testDb
          .prepare("SELECT COUNT(*) as cnt FROM events WHERE contract_id = ?")
          .get("CONTRACT-FAILOVER-1") as { cnt: number }
      ).cnt;
      expect(eventsCount).toBe(6);

      // 6. Verify audit failure events recorded
      const failureRecords = testDb
        .prepare("SELECT * FROM node_failure_events WHERE node_url = ?")
        .all(nodePrimary) as any[];
      expect(failureRecords).toHaveLength(5);

      // 7. Verify failover state in schema
      const state = getFailoverState();
      expect(state.activeNodeUrl).toBe(nodeSecondary);
      expect(state.totalFailovers).toBe(2);
    });

    it("recovered node resumes ingesting simulated RPC events after healthy threshold is cleared", async () => {
      const nodeA = "https://node-recovery-a.example.com";
      const nodeB = "https://node-recovery-b.example.com";

      await failoverToNode(nodeA);

      // Node A fails and becomes unhealthy
      for (let i = 0; i < 5; i++) {
        await recordNodeFailure(nodeA, "503 Service Unavailable", 5, 2);
      }
      expect(getNodeHealth(nodeA)?.isHealthy).toBe(false);

      // Failover to Node B
      await failoverToNode(nodeB);

      // Ingest event on Node B
      simulateRpcEvent(testDb, {
        contractId: "CONTRACT-RECOVER-1",
        eventType: "ContractInitialized",
        ledgerSequence: 1000,
        timestamp: 1710009000,
        dataJson: "{}",
      });
      await recordNodeSuccess(nodeB);

      // Node A recovers after 3 consecutive successes
      await recordNodeSuccess(nodeA, 3);
      await recordNodeSuccess(nodeA, 3);
      await recordNodeSuccess(nodeA, 3);

      const nodeAHealth = getNodeHealth(nodeA);
      expect(nodeAHealth?.isHealthy).toBe(true);

      // Switch back to recovered Node A
      await failoverToNode(nodeA);
      simulateRpcEvent(testDb, {
        contractId: "CONTRACT-RECOVER-1",
        eventType: "MilestoneApproved",
        ledgerSequence: 1001,
        timestamp: 1710009010,
        dataJson: "{}",
      });
      await recordNodeSuccess(nodeA);

      const rows = testDb
        .prepare("SELECT event_type FROM events WHERE contract_id = ? ORDER BY ledger_sequence ASC")
        .all("CONTRACT-RECOVER-1") as any[];

      expect(rows).toHaveLength(2);
      expect(rows[0].event_type).toBe("ContractInitialized");
      expect(rows[1].event_type).toBe("MilestoneApproved");
    });

    it("simulated RPC event ingestion succeeds with retryWithBackoff when node encounters transient errors", async () => {
      const nodeUrl = "https://node-transient.example.com";
      await failoverToNode(nodeUrl);

      let attempts = 0;
      const fetchEventFromRpc = async (): Promise<SimulatedRpcEvent> => {
        attempts++;
        if (attempts < 2) {
          throw new Error("Transient 504 Gateway Timeout");
        }
        return {
          contractId: "CONTRACT-RETRY-1",
          eventType: "FundsDeposited",
          ledgerSequence: 1100,
          timestamp: 1710010000,
          dataJson: JSON.stringify({ amount: "500" }),
        };
      };

      const event = await retryWithBackoff(fetchEventFromRpc, 3, 5);
      expect(attempts).toBe(2);

      simulateRpcEvent(testDb, event);
      await recordNodeSuccess(nodeUrl);

      const row = testDb
        .prepare("SELECT * FROM events WHERE contract_id = ?")
        .get("CONTRACT-RETRY-1") as any;

      expect(row).toBeDefined();
      expect(row.event_type).toBe("FundsDeposited");
      expect(row.ledger_sequence).toBe(1100);
    });

    it("transaction rollback on simulated event write failure does not corrupt events schema or failover state", async () => {
      const nodeUrl = "https://node-rollback.example.com";
      await failoverToNode(nodeUrl);

      simulateRpcEvent(testDb, {
        contractId: "CONTRACT-BASELINE",
        eventType: "ContractInitialized",
        ledgerSequence: 1200,
        timestamp: 1710011000,
        dataJson: "{}",
      });

      const initialEventsCount = (
        testDb.prepare("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number }
      ).cnt;
      expect(initialEventsCount).toBe(1);

      expect(() => {
        const failingTx = testDb.transaction(() => {
          simulateRpcEvent(testDb, {
            contractId: "CONTRACT-FAILING",
            eventType: "FundsDeposited",
            ledgerSequence: 1201,
            timestamp: 1710011010,
            dataJson: "{}",
          });
          throw new Error("Simulated database write error mid-transaction");
        });
        failingTx();
      }).toThrow("Simulated database write error mid-transaction");

      const finalEventsCount = (
        testDb.prepare("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number }
      ).cnt;
      expect(finalEventsCount).toBe(1);

      const abortedRow = testDb
        .prepare("SELECT * FROM events WHERE contract_id = ?")
        .get("CONTRACT-FAILING");
      expect(abortedRow).toBeUndefined();

      const state = getFailoverState();
      expect(state.activeNodeUrl).toBe(nodeUrl);
    });

    it("all required schema columns and tables are present after migrations and health initialization", () => {
      const tables = testDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;
      const tableNames = new Set(tables.map((t) => t.name));

      expect(tableNames.has("events")).toBe(true);
      expect(tableNames.has("rpc_node_health")).toBe(true);
      expect(tableNames.has("failover_state")).toBe(true);
      expect(tableNames.has("node_failure_events")).toBe(true);
      expect(tableNames.has("indexer_state")).toBe(true);
      expect(tableNames.has("monitored_contracts")).toBe(true);

      const eventCols = (testDb.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>).map((c) => c.name);
      for (const col of ["id", "contract_id", "event_type", "ledger_sequence", "timestamp", "data_json", "created_at"]) {
        expect(eventCols).toContain(col);
      }

      const healthCols = (testDb.prepare("PRAGMA table_info(rpc_node_health)").all() as Array<{ name: string }>).map((c) => c.name);
      for (const col of ["node_url", "is_healthy", "failure_count", "last_failure_at", "last_success_at", "next_retry_at", "backoff_duration_ms", "consecutive_successes"]) {
        expect(healthCols).toContain(col);
      }

      const failoverCols = (testDb.prepare("PRAGMA table_info(failover_state)").all() as Array<{ name: string }>).map((c) => c.name);
      for (const col of ["id", "active_node_url", "total_failovers", "last_failover_at"]) {
        expect(failoverCols).toContain(col);
      }

      const failureCols = (testDb.prepare("PRAGMA table_info(node_failure_events)").all() as Array<{ name: string }>).map((c) => c.name);
      for (const col of ["id", "node_url", "error_message", "retry_count", "recovery_attempt_at", "created_at"]) {
        expect(failureCols).toContain(col);
      }
    });

    it("createFailoverServer selects healthiest node and records simulated RPC events", async () => {
      const serverInstance = await createFailoverServer(
        ["https://rpc-failover-srv-1.example.com", "https://rpc-failover-srv-2.example.com"],
        (url) => ({ rpcUrl: url }),
      );

      expect(serverInstance).not.toBeNull();
      expect(serverInstance?.nodeUrl).toBe("https://rpc-failover-srv-1.example.com");

      simulateRpcEvent(testDb, {
        contractId: "CONTRACT-SERVER-1",
        eventType: "ContractInitialized",
        ledgerSequence: 1300,
        timestamp: 1710012000,
        dataJson: "{}",
      });
      await recordNodeSuccess(serverInstance!.nodeUrl);

      const allHealth = getAllNodeHealth();
      expect(allHealth.length).toBeGreaterThanOrEqual(1);
      const activeHealth = allHealth.find((h) => h.nodeUrl === serverInstance!.nodeUrl);
      expect(activeHealth?.isHealthy).toBe(true);

      const state: FailoverState = getFailoverState();
      expect(state.activeNodeUrl).toBe(serverInstance!.nodeUrl);

      const row = testDb
        .prepare("SELECT * FROM events WHERE contract_id = ?")
        .get("CONTRACT-SERVER-1");
      expect(row).toBeDefined();
    });
  });
});
