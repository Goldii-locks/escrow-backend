import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { validateContractId } from "../src/utils/validation.js";
import { isValidStellarContractId } from "../src/utils/stellar.js";

const VALID_CONTRACT =
  "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";

const mockGetAccount = jest.fn<() => Promise<unknown>>();
const mockSimulateTransaction = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getAccount = mockGetAccount;
    simulateTransaction = mockSimulateTransaction;
  },
}));

const { default: router } = await import("../src/routes/jobs.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", router);
  return app;
}

describe("validateContractId()", () => {
  it("accepts a well-formed Soroban contract address", () => {
    expect(validateContractId(VALID_CONTRACT)).toEqual({ valid: true });
  });

  it("rejects undefined", () => {
    const result = validateContractId(undefined);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/required/);
  });

  it("rejects null", () => {
    const result = validateContractId(null);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/required/);
  });

  it("rejects non-string types", () => {
    expect(validateContractId(123).valid).toBe(false);
    expect(validateContractId({}).valid).toBe(false);
    expect(validateContractId([]).valid).toBe(false);
    expect(validateContractId(true).valid).toBe(false);
  });

  it("rejects empty string", () => {
    const result = validateContractId("");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/valid Stellar contract address/i);
  });

  it("rejects Stellar account addresses (G...)", () => {
    const result = validateContractId(
      "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX"
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/valid Stellar contract address/i);
  });

  it("rejects garbage strings", () => {
    expect(validateContractId("not-a-contract").valid).toBe(false);
    expect(validateContractId("CINVALID").valid).toBe(false);
    expect(validateContractId("C").valid).toBe(false);
  });

  it("rejects strings that are too short", () => {
    const short = "C" + "A".repeat(40);
    expect(short.length).toBe(41);
    expect(validateContractId(short).valid).toBe(false);
  });

  it("rejects strings that are too long", () => {
    const long = "C" + "A".repeat(60);
    expect(long.length).toBe(61);
    expect(validateContractId(long).valid).toBe(false);
  });

  it("rejects strings with special characters", () => {
    expect(validateContractId(VALID_CONTRACT + "!").valid).toBe(false);
  });
});

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
  beforeEach(() => {
    mockGetAccount.mockReset();
    mockSimulateTransaction.mockReset();
    delete process.env.API_KEY;
    mockGetAccount.mockResolvedValue({
      accountId: () =>
        "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
      sequenceNumber: () => "123456789",
      incrementSequenceNumber: () => {},
    });
  });

  it("returns 400 for an invalid contractId", async () => {
    const res = await request(buildApp())
      .get("/api/jobs/not-a-valid-contract-id")
      .expect(400);

    expect(res.body).toEqual({
      success: false,
      error: "contractId must be a valid Stellar contract address (C...)",
    });
  });

  it("returns 400 for a Stellar account address used as contractId", async () => {
    const res = await request(buildApp())
      .get(
        "/api/jobs/GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX"
      )
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/valid Stellar contract address/i);
  });

  it("returns 404 for an empty contractId route (no route matched)", async () => {
    const res = await request(buildApp())
      .get("/api/jobs/")
      .expect(404);
  });

  it("returns 400 for a contractId that is too short", async () => {
    const short = "C" + "A".repeat(40);
    const res = await request(buildApp())
      .get(`/api/jobs/${short}`)
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/valid Stellar contract address/i);
  });

  it("returns 400 for a contractId that is too long", async () => {
    const long = "C" + "A".repeat(60);
    const res = await request(buildApp())
      .get(`/api/jobs/${long}`)
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/valid Stellar contract address/i);
  });

  it("does not return 400 for a syntactically valid contractId", async () => {
    mockSimulateTransaction.mockResolvedValue({
      error: "contract not found on network",
    });

    const res = await request(buildApp()).get(`/api/jobs/${VALID_CONTRACT}`);

    expect(res.status).not.toBe(400);
  });

  it("returns standardized error body shape for all invalid inputs", async () => {
    const res = await request(buildApp())
      .get("/api/jobs/bad")
      .expect(400);

    expect(res.body).toMatchObject({
      success: false,
      error: expect.any(String),
    });
  });
});
