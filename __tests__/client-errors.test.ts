import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.unstable_mockModule("../src/utils/logger.js", () => ({ default: mockLogger }));

const { default: clientErrorRoutes, resetClientErrorRateLimitBuckets } = await import(
  "../src/routes/client-errors.js"
);
const { globalCors } = await import("../src/middleware/global-cors.js");

function buildApp() {
  const app = express();
  app.use(globalCors());
  app.use("/api/client-errors", clientErrorRoutes);
  return app;
}

describe("POST /api/client-errors (#917)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetClientErrorRateLimitBuckets();
  });

  it("accepts a valid error report and returns 204", async () => {
    const app = buildApp();
    const payload = {
      source: "api",
      message: "Network timeout fetching jobs",
      route: "/dashboard/jobs",
      status: 504,
      requestId: "req-123456",
    };

    const res = await request(app)
      .post("/api/client-errors")
      .send(payload)
      .expect(204);

    expect(res.text).toBe("");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Client error reported",
      expect.objectContaining({
        clientError: true,
        source: "api",
        message: "Network timeout fetching jobs",
        route: "/dashboard/jobs",
        status: 504,
        requestId: "req-123456",
      }),
    );
  });

  it("accepts minimal report with only source and message and returns 204", async () => {
    const app = buildApp();
    const payload = {
      source: "unhandled",
      message: "Uncaught ReferenceError: x is not defined",
    };

    await request(app)
      .post("/api/client-errors")
      .send(payload)
      .expect(204);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Client error reported",
      expect.objectContaining({
        clientError: true,
        source: "unhandled",
        message: "Uncaught ReferenceError: x is not defined",
      }),
    );
  });

  it("rejects an oversized body with HTTP 400", async () => {
    const app = buildApp();
    const oversizedPayload = {
      source: "render",
      message: "x".repeat(5000), // > 4 kB
    };

    const res = await request(app)
      .post("/api/client-errors")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(oversizedPayload))
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("rejects invalid source with HTTP 400", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/client-errors")
      .send({
        source: "invalid_source",
        message: "Something failed",
      })
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("rejects route with query string with HTTP 400", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/client-errors")
      .send({
        source: "api",
        message: "Failure",
        route: "/jobs?id=123",
      })
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("rejects invalid status (out of 100-599 range) with HTTP 400", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/client-errors")
      .send({
        source: "api",
        message: "Failure",
        status: 99,
      })
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("rejects invalid requestId pattern with HTTP 400", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/client-errors")
      .send({
        source: "api",
        message: "Failure",
        requestId: "invalid id with spaces!!",
      })
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("enforces dedicated rate limiter and returns HTTP 429", async () => {
    const app = buildApp();
    const validBody = {
      source: "tx",
      message: "Transaction failed",
    };

    for (let i = 0; i < 30; i++) {
      await request(app)
        .post("/api/client-errors")
        .send(validBody)
        .expect(204);
    }

    const limited = await request(app)
      .post("/api/client-errors")
      .send(validBody)
      .expect(429);

    expect(limited.body).toEqual({
      success: false,
      error: "Too many requests, please try again later",
    });
  });

  it("allows frontend origin via globalCors", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/client-errors")
      .set("Origin", "http://localhost:3000")
      .send({
        source: "render",
        message: "Render crash",
      })
      .expect(204);

    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });
});
