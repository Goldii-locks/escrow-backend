import request from "supertest";
import express from "express";
import estimateRouter from "../src/routes/estimate.js";
import { resetInterestYieldRateLimitBuckets } from "../src/middleware/interest-yield-rate-limit.js";

const app = express();
app.use(express.json());
app.use("/api/estimate", estimateRouter);

describe("POST /api/estimate/interest-yield", () => {
  const originalMax = process.env.INTEREST_YIELD_RATE_MAX;
  const originalWindow = process.env.INTEREST_YIELD_RATE_WINDOW_MS;

  beforeEach(() => {
    resetInterestYieldRateLimitBuckets();
    process.env.INTEREST_YIELD_RATE_MAX = "3";
    process.env.INTEREST_YIELD_RATE_WINDOW_MS = "60000";
  });

  afterEach(() => {
    resetInterestYieldRateLimitBuckets();
    if (originalMax === undefined) {
      delete process.env.INTEREST_YIELD_RATE_MAX;
    } else {
      process.env.INTEREST_YIELD_RATE_MAX = originalMax;
    }
    if (originalWindow === undefined) {
      delete process.env.INTEREST_YIELD_RATE_WINDOW_MS;
    } else {
      process.env.INTEREST_YIELD_RATE_WINDOW_MS = originalWindow;
    }
  });

  it("returns the estimated yield for a valid request", async () => {
    const res = await request(app)
      .post("/api/estimate/interest-yield")
      .send({ principal: "100", rate: "2" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.yield).toBe("200");
  });

  it("returns 400 when principal is missing", async () => {
    const res = await request(app)
      .post("/api/estimate/interest-yield")
      .send({ rate: "2" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("principal and rate are required");
  });

  it("returns 400 when rate is missing", async () => {
    const res = await request(app)
      .post("/api/estimate/interest-yield")
      .send({ principal: "100" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("principal and rate are required");
  });

  it("returns 400 when operands are not numeric", async () => {
    const res = await request(app)
      .post("/api/estimate/interest-yield")
      .send({ principal: {}, rate: "2" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("principal and rate must be numeric values");
  });

  it("returns 400 when the principal exceeds the digit limit", async () => {
    const res = await request(app)
      .post("/api/estimate/interest-yield")
      .send({ principal: "9".repeat(16), rate: "1" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/exceeds maximum/i);
  });

  it("returns 400 when the product overflows the digit limit", async () => {
    const res = await request(app)
      .post("/api/estimate/interest-yield")
      .send({ principal: "9".repeat(15), rate: "10" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/exceeds maximum/i);
  });

  it("allows requests up to the configured threshold", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post("/api/estimate/interest-yield")
        .send({ principal: "100", rate: "2" });
      expect(res.status).toBe(200);
      expect(res.headers["x-ratelimit-limit"]).toBe("3");
    }
  });

  it("returns 429 once the threshold is exceeded", async () => {
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post("/api/estimate/interest-yield")
        .send({ principal: "100", rate: "2" });
    }

    const res = await request(app)
      .post("/api/estimate/interest-yield")
      .send({ principal: "100", rate: "2" })
      .expect(429);

    expect(res.body).toEqual({
      success: false,
      error: "Too many requests, please try again later",
    });
    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
  });
});
