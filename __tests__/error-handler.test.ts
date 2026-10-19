import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule("../src/utils/logger.js", () => ({ default: mockLogger }));

const { globalErrorHandler } = await import("../src/middleware/error-handler.js");
const { default: jobRoutes } = await import("../src/routes/jobs.js");

const app = express();
app.use(express.json());
app.get("/boom", () => {
  throw new Error("secret internal detail");
});
app.use("/api/jobs", jobRoutes);
app.use(globalErrorHandler);

describe("global error handler (#603)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 400 for a malformed JSON body and logs at warn", async () => {
    const res = await request(app)
      .post("/api/jobs/build-tx")
      .set("Content-Type", "application/json")
      .send('{"contractId":');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Malformed JSON body" });
    expect(mockLogger.warn).toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("returns 413 for a body over the size limit", async () => {
    const res = await request(app)
      .post("/api/jobs/build-tx")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ pad: "x".repeat(200 * 1024) }));

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ success: false, error: "Payload too large" });
  });

  it("still returns a generic 500 for a genuine thrown Error", async () => {
    const res = await request(app).get("/boom");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: "Internal server error" });
    expect(mockLogger.error).toHaveBeenCalled();
  });
});
