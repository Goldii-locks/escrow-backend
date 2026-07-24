import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";

const mockSendTransaction = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("../src/middleware/rateLimiter.js", () => ({
  strictLimiter: (_req: any, _res: any, next: any) => next(),
  generalLimiter: (_req: any, _res: any, next: any) => next(),
}));

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    sendTransaction = mockSendTransaction;
  },
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { default: router } = await import("../src/routes/jobs.js");

const app = express();
app.use(express.json());
app.use("/api/jobs", router);

const VALID_SIGNED_XDR = "AAAAAQAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAA";

describe("POST /api/jobs/submit — schema validation", () => {
  beforeEach(() => {
    mockSendTransaction.mockReset();
  });

  it("returns 200 with success on valid submission", async () => {
    mockSendTransaction.mockResolvedValue({ hash: "test-hash" });

    const res = await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 400 when signedXdr is missing", async () => {
    const res = await request(app)
      .post("/api/jobs/submit")
      .send({})
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeDefined();
  });

  it("returns 400 when signedXdr is an empty string", async () => {
    const res = await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: "" })
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeDefined();
  });

  it("returns 400 when signedXdr is not a string (number)", async () => {
    const res = await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: 12345 })
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeDefined();
  });

  it("returns 400 when signedXdr is not a string (object)", async () => {
    const res = await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: { invalid: "data" } })
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeDefined();
  });

  it("returns 400 when signedXdr is null", async () => {
    const res = await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: null })
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeDefined();
  });

  it("returns 400 when signedXdr is undefined", async () => {
    const res = await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: undefined })
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeDefined();
  });

  it("returns 400 when signedXdr is invalid base64", async () => {
    const res = await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: "not-base64!@#$" })
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeDefined();
  });
});

describe("POST /api/jobs/submit — error handling", () => {
  beforeEach(() => {
    mockSendTransaction.mockReset();
  });

  it("returns 500 without leaking internal error details", async () => {
    mockSendTransaction.mockRejectedValue(
      new Error("RPC error: internal secret detail")
    );

    const res = await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(500);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("Internal server error");
    expect(JSON.stringify(res.body)).not.toContain("internal secret");
  });

  it("returns 500 without leaking stack trace", async () => {
    mockSendTransaction.mockRejectedValue(new Error("some failure"));

    const res = await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(500);

    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/at Object\./);
    expect(body).not.toContain(".ts:");
    expect(body).not.toContain(".js:");
  });
});
