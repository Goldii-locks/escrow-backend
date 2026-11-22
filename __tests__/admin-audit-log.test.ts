import request from "supertest";
import express from "express";
import adminRoutes from "../src/routes/admin.js";
import webhookRoutes from "../src/routes/webhooks.js";
import Database from "better-sqlite3";
import {
  setDb,
  runMigrations,
  closeDb,
  getAdminAuditLogs,
  pruneOldAuditLogs,
  addSubscription,
  registerContract,
} from "../src/indexer/db.js";

const app = express();
app.use(express.json());
app.use("/api/admin", adminRoutes);
app.use("/api/webhooks", webhookRoutes);

const CONTRACT_ID = "CARZQMYKDGA4TTIE2XBDJ42EX27VYLLJGGG4WGUIXXWIVHPDTX3UCLJA";
const WEBHOOK_URL = "https://example.com/api/callback?secret_token=supersecret123";

describe("Admin Audit Logging (#928)", () => {
  const originalKey = process.env.ADMIN_API_KEY;
  let testDb: Database.Database;

  beforeAll(() => {
    process.env.ADMIN_API_KEY = "test-admin-key";
    testDb = new Database(":memory:");
    setDb(testDb);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    if (originalKey !== undefined) {
      process.env.ADMIN_API_KEY = originalKey;
    } else {
      delete process.env.ADMIN_API_KEY;
    }
  });

  beforeEach(() => {
    testDb.exec("DELETE FROM admin_audit_log");
    testDb.exec("DELETE FROM webhook_subscriptions");
    testDb.exec("DELETE FROM monitored_contracts");
  });

  it("registering a contract creates one audit row with the correct action and target", async () => {
    const res = await request(app)
      .post("/api/admin/contracts")
      .set("x-api-key", "test-admin-key")
      .send({ contractId: CONTRACT_ID, label: "Test Escrow", startLedger: 100 })
      .expect(201);

    expect(res.body.success).toBe(true);

    const logs = getAdminAuditLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("register_contract");
    expect(logs[0].target).toBe(CONTRACT_ID);
    expect(logs[0].status).toBe(201);
    expect(logs[0].method).toBe("POST");
    expect(logs[0].path).toContain("/api/admin/contracts");

    const params = JSON.parse(logs[0].params_json || "{}");
    expect(params.contractId).toBe(CONTRACT_ID);
    expect(params.label).toBe("Test Escrow");
    expect(params.startLedger).toBe(100);
  });

  it("unsubscribing a webhook creates one audit row with the correct action and target", async () => {
    registerContract(CONTRACT_ID);
    addSubscription(CONTRACT_ID, "https://example.com/api/callback", ["*"]);

    const res = await request(app)
      .post("/api/webhooks/unsubscribe")
      .set("x-api-key", "test-admin-key")
      .send({
        contract_id: CONTRACT_ID,
        webhook_url: "https://example.com/api/callback",
      })
      .expect(200);

    expect(res.body.success).toBe(true);

    const logs = getAdminAuditLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("remove_webhook_subscription");
    expect(logs[0].target).toBe(CONTRACT_ID);
    expect(logs[0].status).toBe(200);
    expect(logs[0].method).toBe("POST");
  });

  it("subscribing a webhook redacts full webhook URLs and secrets", async () => {
    registerContract(CONTRACT_ID);

    const res = await request(app)
      .post("/api/webhooks/subscribe")
      .set("x-api-key", "test-admin-key")
      .send({
        contract_id: CONTRACT_ID,
        webhook_url: WEBHOOK_URL,
        event_types: ["fund"],
      })
      .expect(200);

    expect(res.body.success).toBe(true);

    const logs = getAdminAuditLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("create_webhook_subscription");
    expect(logs[0].target).toBe(CONTRACT_ID);
    expect(logs[0].status).toBe(200);

    // Ensure secrets and full path with query parameters are redacted
    expect(logs[0].params_json).not.toContain("supersecret123");
    expect(logs[0].params_json).not.toContain("/api/callback");
    expect(logs[0].params_json).toContain("https://example.com/***");
  });

  it("read-only admin GET requests do not create audit-log entries", async () => {
    await request(app)
      .get("/api/admin/contracts")
      .set("x-api-key", "test-admin-key")
      .expect(200);

    await request(app)
      .get("/api/admin/indexer-status")
      .set("x-api-key", "test-admin-key")
      .expect(200);

    await request(app)
      .get("/api/admin/audit-log")
      .set("x-api-key", "test-admin-key")
      .expect(200);

    const logs = getAdminAuditLogs();
    expect(logs).toHaveLength(0);
  });

  it("GET /api/admin/audit-log supports limit and before query parameters", async () => {
    // Register 3 contracts to create 3 audit rows
    const contractIds = [
      "CARZQMYKDGA4TTIE2XBDJ42EX27VYLLJGGG4WGUIXXWIVHPDTX3UCLJA",
      "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      "CBQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCV5G",
    ];
    for (const cid of contractIds) {
      await request(app)
        .post("/api/admin/contracts")
        .set("x-api-key", "test-admin-key")
        .send({ contractId: cid })
        .expect(201);
    }

    const allLogs = getAdminAuditLogs();
    expect(allLogs).toHaveLength(3);

    // Test limit=2
    const resLimit = await request(app)
      .get("/api/admin/audit-log?limit=2")
      .set("x-api-key", "test-admin-key")
      .expect(200);
    expect(resLimit.body.entries).toHaveLength(2);
    expect(resLimit.body.entries[0].id).toBe(allLogs[0].id);

    // Test before (using id of the latest entry)
    const resBefore = await request(app)
      .get(`/api/admin/audit-log?before=${allLogs[0].id}`)
      .set("x-api-key", "test-admin-key")
      .expect(200);
    expect(resBefore.body.entries).toHaveLength(2);
    expect(resBefore.body.entries[0].id).toBe(allLogs[1].id);
  });

  it("prunes audit-log entries older than one year in maintenance", () => {
    // Insert stale entry (2 years old) and fresh entry
    testDb
      .prepare(
        `INSERT INTO admin_audit_log (at, key_index, method, path, action, target, params_json, status)
         VALUES (datetime('now', '-2 years'), 0, 'POST', '/api/admin/contracts', 'register_contract', 'C1', '{}', 201)`
      )
      .run();

    testDb
      .prepare(
        `INSERT INTO admin_audit_log (at, key_index, method, path, action, target, params_json, status)
         VALUES (datetime('now'), 0, 'POST', '/api/admin/contracts', 'register_contract', 'C2', '{}', 201)`
      )
      .run();

    const beforePrune = testDb.prepare("SELECT COUNT(*) AS c FROM admin_audit_log").get() as { c: number };
    expect(beforePrune.c).toBe(2);

    const prunedCount = pruneOldAuditLogs(testDb);
    expect(prunedCount).toBe(1);

    const afterPrune = testDb.prepare("SELECT * FROM admin_audit_log").all() as any[];
    expect(afterPrune).toHaveLength(1);
    expect(afterPrune[0].target).toBe("C2");
  });
});
