import request from "supertest";
import express from "express";
import router from "../src/routes/jobs.js";

const VALID_CONTRACT =
  "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";

const app = express();
app.use(express.json());
app.use("/api/jobs", router);

describe("GET /api/jobs/:contractId/whitelist – Zod validation middleware", () => {
  describe("contractId validation", () => {
    it("returns 400 for an invalid contractId format", async () => {
      const res = await request(app)
        .get("/api/jobs/not-a-valid-contract-id/whitelist")
        .expect(400);

      expect(res.body).toEqual({
        success: false,
        error: "contractId must be a valid Stellar contract address (C...)",
      });
    });

    it("returns 400 for a Stellar account address used as contractId", async () => {
      const res = await request(app)
        .get("/api/jobs/GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX/whitelist")
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/valid Stellar contract address/i);
    });

    it("returns 400 for an empty contractId", async () => {
      const res = await request(app)
        .get("/api/jobs//whitelist")
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/valid Stellar contract address/i);
    });

    it("returns 400 for malformed contract IDs starting with C but wrong length", async () => {
      const res = await request(app)
        .get("/api/jobs/CINVALID/whitelist")
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/valid Stellar contract address/i);
    });

    it("does not return 400 for a syntactically valid contractId on whitelist endpoint", async () => {
      const res = await request(app).get(`/api/jobs/${VALID_CONTRACT}/whitelist`);

      expect(res.status).not.toBe(400);
    });
  });
});