import request from "supertest";
import express from "express";
import { autoAuth } from "./helpers/api-key-helper.js";

const { default: router } = await import("../src/routes/jobs.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(autoAuth);
  app.use("/api/jobs", router);
  return app;
}

// Route registration order (#621): static paths must be matched before the
// /:contractId param route, otherwise e.g. /build-tx would be treated as a
// contract ID and hit the simulation path instead of its own handler.
describe("jobs route registration order (#621)", () => {
  it("GET /query is handled by the query route, not /:contractId", async () => {
    const res = await request(buildApp()).get("/api/jobs/query").expect(400);
    expect(res.body.success).toBe(false);
  });

  it("GET /whitelisted-tokens alias wins over /:contractId", async () => {
    const res = await request(buildApp())
      .get("/api/jobs/whitelisted-tokens")
      .expect(400);
    expect(res.body).toEqual({ success: false, error: "contractId is required" });
  });

  it("POST /build-tx is validated by its own route, not /:contractId", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/build-tx")
      .send({})
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  it("GET /by-wallet/:address validates the address, not /:contractId", async () => {
    const res = await request(buildApp())
      .get("/api/jobs/by-wallet/not-an-address")
      .expect(400);
    expect(res.body.success).toBe(false);
  });
});
