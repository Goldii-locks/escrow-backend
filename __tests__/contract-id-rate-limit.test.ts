import request from "supertest";
import express from "express";
import router from "../src/routes/jobs.js";
import { resetJobContractRateLimitBuckets } from "../src/middleware/job-contract-rate-limit.js";

const VALID_CONTRACT =
  "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";

const app = express();
app.use(express.json());
app.use("/api/jobs", router);

describe("GET /api/jobs/:contractId – rate limiting", () => {
  const originalMax = process.env.JOB_CONTRACT_RATE_MAX;
  const originalWindow = process.env.JOB_CONTRACT_RATE_WINDOW_MS;

  beforeEach(() => {
    resetJobContractRateLimitBuckets();
    process.env.JOB_CONTRACT_RATE_MAX = "3";
    process.env.JOB_CONTRACT_RATE_WINDOW_MS = "60000";
  });

  afterEach(() => {
    resetJobContractRateLimitBuckets();
    if (originalMax === undefined) {
      delete process.env.JOB_CONTRACT_RATE_MAX;
    } else {
      process.env.JOB_CONTRACT_RATE_MAX = originalMax;
    }
    if (originalWindow === undefined) {
      delete process.env.JOB_CONTRACT_RATE_WINDOW_MS;
    } else {
      process.env.JOB_CONTRACT_RATE_WINDOW_MS = originalWindow;
    }
  });

  it("allows requests up to the configured threshold", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get(`/api/jobs/${VALID_CONTRACT}`);
      expect(res.status).not.toBe(429);
      expect(res.headers["x-ratelimit-limit"]).toBe("3");
    }
  });

  it("returns 429 once the threshold is exceeded", async () => {
    for (let i = 0; i < 3; i++) {
      await request(app).get(`/api/jobs/${VALID_CONTRACT}`);
    }

    const res = await request(app)
      .get(`/api/jobs/${VALID_CONTRACT}`)
      .expect(429);

    expect(res.body).toEqual({
      success: false,
      error: "Too many requests, please try again later",
    });
    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
  });

  it("does not rate limit other job routes", async () => {
    process.env.JOB_CONTRACT_RATE_MAX = "1";

    await request(app).get(`/api/jobs/${VALID_CONTRACT}`);
    const blocked = await request(app).get(`/api/jobs/${VALID_CONTRACT}`);
    expect(blocked.status).toBe(429);

    const byWallet = await request(app).get("/api/jobs/by-wallet/GTESTWALLET");
    expect(byWallet.status).not.toBe(429);
  });
});
