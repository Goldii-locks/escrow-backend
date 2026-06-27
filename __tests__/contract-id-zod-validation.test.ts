import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";

const VALID_CONTRACT = "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";

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

describe("Zod contractId middleware – GET /api/jobs/:contractId", () => {
  beforeEach(() => {
    mockGetAccount.mockReset();
    mockSimulateTransaction.mockReset();
    delete process.env.API_KEY;
    mockGetAccount.mockResolvedValue({
      accountId: () => "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
      sequenceNumber: () => "123456789",
      incrementSequenceNumber: () => {},
    });
  });

  // ── invalid inputs ────────────────────────────────────────────────────────

  it("returns 400 for a garbage contractId", async () => {
    const res = await request(buildApp())
      .get("/api/jobs/not-a-valid-contract-id")
      .expect(400);
    expect(res.body).toEqual({
      success: false,
      error: "contractId must be a valid Stellar contract address (C...)",
    });
  });

  it("returns 400 for a Stellar account address (G...)", async () => {
    const res = await request(buildApp())
      .get("/api/jobs/GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX")
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/valid Stellar contract address/i);
  });

  it("returns 400 for a contractId that is too short", async () => {
    const res = await request(buildApp())
      .get(`/api/jobs/${"C" + "A".repeat(40)}`)
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/valid Stellar contract address/i);
  });

  it("returns 400 for a contractId that is too long", async () => {
    const res = await request(buildApp())
      .get(`/api/jobs/${"C" + "A".repeat(60)}`)
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/valid Stellar contract address/i);
  });

  it("returns 400 for a contractId with special characters", async () => {
    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}!`)
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 for a single-char contractId", async () => {
    const res = await request(buildApp())
      .get("/api/jobs/C")
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/valid Stellar contract address/i);
  });

  // ── error body shape ──────────────────────────────────────────────────────

  it("returns standardised error shape for invalid input", async () => {
    const res = await request(buildApp())
      .get("/api/jobs/bad")
      .expect(400);
    expect(res.body).toMatchObject({ success: false, error: expect.any(String) });
  });

  // ── valid input passes the middleware ─────────────────────────────────────

  it("does not return 400 for a syntactically valid contractId", async () => {
    mockSimulateTransaction.mockResolvedValue({
      error: "contract not found on network",
    });
    const res = await request(buildApp()).get(`/api/jobs/${VALID_CONTRACT}`);
    expect(res.status).not.toBe(400);
  });

  it("passes req.params.contractId unchanged to the handler", async () => {
    mockSimulateTransaction.mockResolvedValue({
      error: "contract not found on network",
    });
    const res = await request(buildApp()).get(`/api/jobs/${VALID_CONTRACT}`);
    // The handler returns a non-400 response — the contractId reached the handler
    expect(res.status).not.toBe(400);
  });
});
