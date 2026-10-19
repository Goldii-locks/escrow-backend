import request from "supertest";
import express from "express";
import adminRoutes from "../src/routes/admin.js";
import Database from "better-sqlite3";
import {
  setDb,
  runMigrations,
  closeDb,
  getActiveContractIds,
  getAllContracts,
  deregisterContract,
  registerContract,
} from "../src/indexer/db.js";

const app = express();
app.use(express.json());
app.use("/api/admin", adminRoutes);

const VALID_CONTRACT_1 = "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";
const VALID_CONTRACT_2 = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

describe("Admin Contracts Endpoints (#659)", () => {
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

  describe("Authentication and Authorization", () => {
    it("returns 401 when no admin API key is provided", async () => {
      await request(app).get("/api/admin/contracts").expect(401);
      await request(app)
        .post("/api/admin/contracts")
        .send({ contractId: VALID_CONTRACT_1 })
        .expect(401);
      await request(app)
        .delete(`/api/admin/contracts/${VALID_CONTRACT_1}`)
        .expect(401);
    });

    it("returns 401 when an invalid admin API key is provided", async () => {
      await request(app)
        .get("/api/admin/contracts")
        .set("x-api-key", "wrong-key")
        .expect(401);
    });
  });

  describe("Contract Validation", () => {
    it("returns 400 for a bad contract ID on POST", async () => {
      const res = await request(app)
        .post("/api/admin/contracts")
        .set("x-api-key", "test-admin-key")
        .send({ contractId: "not-a-valid-contract" })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("ValidationError");
    });

    it("returns 400 for a bad contract ID on DELETE", async () => {
      const res = await request(app)
        .delete("/api/admin/contracts/invalid-id")
        .set("x-api-key", "test-admin-key")
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("ValidationError");
    });
  });

  describe("CRUD operations and inclusion in active contracts", () => {
    it("registers a contract and verifies it is active and returned in pollEvents list", async () => {
      const postRes = await request(app)
        .post("/api/admin/contracts")
        .set("x-api-key", "test-admin-key")
        .send({ contractId: VALID_CONTRACT_1, label: "Test escrow 1", startLedger: 100 })
        .expect(201);

      expect(postRes.body.success).toBe(true);
      expect(postRes.body.contract.contractId).toBe(VALID_CONTRACT_1);
      expect(postRes.body.contract.label).toBe("Test escrow 1");

      const activeIds = getActiveContractIds();
      expect(activeIds).toContain(VALID_CONTRACT_1);

      const getRes = await request(app)
        .get("/api/admin/contracts")
        .set("x-api-key", "test-admin-key")
        .expect(200);

      expect(getRes.body.success).toBe(true);
      const found = getRes.body.contracts.find((c: any) => c.contractId === VALID_CONTRACT_1);
      expect(found).toBeDefined();
      expect(found.active).toBe(true);
      expect(found.registered_at).toBeDefined();
      expect(found.startLedger).toBe(100);
    });

    it("deactivates (soft deletes) a contract", async () => {
      // Ensure VALID_CONTRACT_2 is registered first
      await request(app)
        .post("/api/admin/contracts")
        .set("x-api-key", "test-admin-key")
        .send({ contractId: VALID_CONTRACT_2, label: "Test escrow 2" })
        .expect(201);

      expect(getActiveContractIds()).toContain(VALID_CONTRACT_2);

      // Delete it
      const delRes = await request(app)
        .delete(`/api/admin/contracts/${VALID_CONTRACT_2}`)
        .set("x-api-key", "test-admin-key")
        .expect(200);

      expect(delRes.body.success).toBe(true);
      expect(delRes.body.contractId).toBe(VALID_CONTRACT_2);

      // No longer in active contract IDs
      expect(getActiveContractIds()).not.toContain(VALID_CONTRACT_2);

      // Still in GET /contracts list but marked active: false
      const getRes = await request(app)
        .get("/api/admin/contracts")
        .set("x-api-key", "test-admin-key")
        .expect(200);

      const found = getRes.body.contracts.find((c: any) => c.contractId === VALID_CONTRACT_2);
      expect(found).toBeDefined();
      expect(found.active).toBe(false);
    });
  });
});
