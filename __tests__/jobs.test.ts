import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import type { NextFunction, Request, Response } from "express";

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
  // Add error interceptor for test coverage
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  });
  return app;
}

describe("GET /api/jobs/:contractId – error interceptor", () => {
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

  it("returns sanitized 500 for unexpected simulation errors (no leak)", async () => {
    mockSimulateTransaction.mockResolvedValue({
      error: "host unreachable - internal detail",
    });

    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}`)
      .expect(500);

    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expect(res.text).not.toContain("host unreachable");
    expect(res.text).not.toContain("stack");
    expect(res.text).not.toContain("Error");
  });

  it("returns sanitized 500 when RPC client throws (no leak)", async () => {
    mockGetAccount.mockRejectedValue(new Error("connection refused - detail"));

    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}`)
      .expect(500);

    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expect(res.text).not.toContain("connection refused");
    expect(res.text).not.toContain("stack");
  });

  it("never includes stack traces in 500 responses", async () => {
    const stackError = new Error("boom");
    stackError.stack = "Error: boom\n    at Object.<anonymous> (/app/src/file.ts:1:1)";
    mockGetAccount.mockRejectedValue(stackError);

    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}`)
      .expect(500);

    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expect(res.text).not.toContain("/app/src");
    expect(res.text).not.toContain("file.ts");
    expect(res.text).not.toContain("at ");
  });

  it("returns sanitized 500 for 401-pattern errors in catch (no false mapping)", async () => {
    mockGetAccount.mockRejectedValue(new Error("authentication failed"));

    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}`)
      .expect(500);

    expect(res.body).toEqual({ success: false, error: "Internal server error" });
  });

  it("returns sanitized 500 when simulation returns a generic error", async () => {
    mockSimulateTransaction.mockResolvedValue({
      error: "some random simulation failure",
    });

    const res = await request(buildApp())
      .get(`/api/jobs/${VALID_CONTRACT}`)
      .expect(500);

    expect(res.body).toEqual({ success: false, error: "Internal server error" });
  });
});
