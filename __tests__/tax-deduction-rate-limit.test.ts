import request from "supertest";
import express from "express";
import {
  taxDeductionRateLimit,
  resetTaxDeductionRateLimitBuckets,
} from "../src/middleware/tax-deduction-rate-limit.js";

describe("taxDeductionRateLimit middleware", () => {
  let app: express.Express;

  beforeEach(() => {
    resetTaxDeductionRateLimitBuckets();
    process.env.TAX_ESTIMATOR_RATE_MAX = "3";
    process.env.TAX_ESTIMATOR_RATE_WINDOW_MS = "60000";

    app = express();
    app.use(express.json());
    app.get("/api/tax-deduction-estimator", taxDeductionRateLimit, (_req, res) => {
      res.json({ success: true, message: "tax deduction calculation result" });
    });
  });

  afterEach(() => {
    delete process.env.TAX_ESTIMATOR_RATE_MAX;
    delete process.env.TAX_ESTIMATOR_RATE_WINDOW_MS;
  });

  it("permits client requests under the threshold", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get("/api/tax-deduction-estimator");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.headers["x-ratelimit-limit"]).toBe("3");
      expect(res.headers["x-ratelimit-remaining"]).toBe(String(3 - (i + 1)));
    }
  });

  it("returns 429 status code and warning when client requests exceed threshold", async () => {
    for (let i = 0; i < 3; i++) {
      await request(app).get("/api/tax-deduction-estimator");
    }

    const res = await request(app).get("/api/tax-deduction-estimator");
    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("Too many requests, please try again later");
    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
  });
});
