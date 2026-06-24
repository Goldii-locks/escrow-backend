import request from "supertest";
import express from "express";
import router from "../src/routes/jobs.js";
import { isValidStellarContractId } from "../src/utils/stellar.js";

const VALID_CONTRACT =
  "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";

const app = express();
app.use(express.json());
app.use("/api/jobs", router);

describe("isValidStellarContractId()", () => {
  it("accepts a well-formed Soroban contract address", () => {
    expect(isValidStellarContractId(VALID_CONTRACT)).toBe(true);
  });

  it("rejects account addresses (G...)", () => {
    expect(
      isValidStellarContractId(
        "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX"
      )
    ).toBe(false);
  });

  it("rejects empty and garbage strings", () => {
    expect(isValidStellarContractId("")).toBe(false);
    expect(isValidStellarContractId("not-a-contract")).toBe(false);
    expect(isValidStellarContractId("CINVALID")).toBe(false);
  });
});

describe("GET /api/jobs/:contractId – address validation", () => {
  it("returns 400 for an invalid contractId", async () => {
    const res = await request(app)
      .get("/api/jobs/not-a-valid-contract-id")
      .expect(400);

    expect(res.body).toEqual({
      success: false,
      error: "contractId must be a valid Stellar contract address (C...)",
    });
  });

  it("returns 400 for a Stellar account address used as contractId", async () => {
    const res = await request(app)
      .get(
        "/api/jobs/GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX"
      )
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/valid Stellar contract address/i);
  });

  it("does not return 400 for a syntactically valid contractId", async () => {
    const res = await request(app).get(`/api/jobs/${VALID_CONTRACT}`);

    expect(res.status).not.toBe(400);
  });
});
