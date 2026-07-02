import request from "supertest";
import express from "express";
import jobsRouter from "./jobs.js";
import { Server } from "@stellar/stellar-sdk/rpc";

// Mock internal dependencies to isolate the router
jest.mock("../indexer/db.js", () => ({ getJobsByWallet: jest.fn() }));
jest.mock("../middleware/rateLimiter.js", () => ({ strictLimiter: (req: any, res: any, next: any) => next() }));
jest.mock("../middleware/job-contract-rate-limit.js", () => ({ jobContractRateLimit: (req: any, res: any, next: any) => next() }));
jest.mock("../middleware/job-contract-security.js", () => ({
  jobContractCors: (req: any, res: any, next: any) => next(),
  jobContractSecurityHeaders: (req: any, res: any, next: any) => next()
}));
jest.mock("../utils/stellar.js", () => ({ isValidStellarContractId: jest.fn((id) => id === "VALID_CONTRACT_ID") }));

// Mock Stellar SDK external calls
jest.mock("@stellar/stellar-sdk/rpc", () => ({
  Server: jest.fn().mockImplementation(() => ({
    getAccount: jest.fn().mockResolvedValue({}),
    simulateTransaction: jest.fn()
  }))
}));
jest.mock("@stellar/stellar-sdk", () => ({
  Contract: jest.fn().mockImplementation(() => ({ call: jest.fn() })),
  TransactionBuilder: jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({})
  })),
  Networks: { TESTNET: "Testnet" },
  BASE_FEE: "100"
}));

const app = express();
app.use(express.json());
app.use("/api/jobs", jobsRouter);

describe("GET /api/jobs/:contractId/whitelist", () => {
  let simulateMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    const serverInstance = new Server("dummy");
    simulateMock = serverInstance.simulateTransaction as jest.Mock;
  });

  it("returns 400 for invalid contractId", async () => {
    const res = await request(app).get("/api/jobs/INVALID_ID/whitelist");
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("valid Stellar contract address");
  });

  it("returns 200 and empty tokens if contract is not initialized", async () => {
    simulateMock.mockResolvedValueOnce({ error: "contract error #2" });
    const res = await request(app).get("/api/jobs/VALID_CONTRACT_ID/whitelist");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.tokens).toEqual([]);
  });

  it("returns 200 and token list on successful simulation", async () => {
    simulateMock.mockResolvedValueOnce({
      result: {
        retval: {
          forEach: (cb: any) => {
            cb({ toString: () => "TokenA" });
            cb({ toString: () => "TokenB" });
          }
        }
      }
    });
    const res = await request(app).get("/api/jobs/VALID_CONTRACT_ID/whitelist");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.tokens).toEqual(["TokenA", "TokenB"]);
  });

  it("returns 500 on standard RPC error", async () => {
    simulateMock.mockResolvedValueOnce({ error: "Random RPC error" });
    const res = await request(app).get("/api/jobs/VALID_CONTRACT_ID/whitelist");
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });

  it("returns 500 when retval is completely missing", async () => {
    simulateMock.mockResolvedValueOnce({ result: {} });
    const res = await request(app).get("/api/jobs/VALID_CONTRACT_ID/whitelist");
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });

  it("returns 500 on unexpected JS exception without leaking the raw error", async () => {
    simulateMock.mockRejectedValueOnce(new Error("Network exploded"));
    const res = await request(app).get("/api/jobs/VALID_CONTRACT_ID/whitelist");
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("Internal server error");
    expect(JSON.stringify(res.body)).not.toContain("Network exploded");
  });
});
