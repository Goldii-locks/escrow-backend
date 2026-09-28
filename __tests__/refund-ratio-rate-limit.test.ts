import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import {
  refundRatioRateLimit,
  resetRefundRatioRateLimitBuckets,
} from "../src/middleware/refund-ratio-rate-limit.js";
import { applyRefundRatio } from "../src/utils/refund_ratio_helper.js";
import logger from "../src/utils/logger.js";

describe("refundRatioRateLimit middleware", () => {
  let app: express.Express;

  beforeEach(() => {
    resetRefundRatioRateLimitBuckets();
    process.env.REFUND_RATIO_RATE_MAX = "3";
    process.env.REFUND_RATIO_RATE_WINDOW_MS = "60000";

    app = express();
    app.set("trust proxy", true);
    app.use(express.json());
    app.post("/api/refund-ratio", refundRatioRateLimit, (req, res) => {
      const result = applyRefundRatio(req.body.amount, req.body.ratio);
      res.json(
        result.ok
          ? { success: true, data: { refund: result.value.toString() } }
          : { success: false, error: result.error }
      );
    });
    app.get("/api/other", (_req, res) => {
      res.json({ success: true });
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    resetRefundRatioRateLimitBuckets();
    delete process.env.REFUND_RATIO_RATE_MAX;
    delete process.env.REFUND_RATIO_RATE_WINDOW_MS;
  });

  const hit = (ip = "10.0.0.1") =>
    request(app)
      .post("/api/refund-ratio")
      .set("X-Forwarded-For", ip)
      .send({ amount: "10000", ratio: "2500" });

  it("permits client requests under the threshold", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await hit();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { refund: "2500" } });
      expect(res.headers["x-ratelimit-limit"]).toBe("3");
      expect(res.headers["x-ratelimit-remaining"]).toBe(String(3 - (i + 1)));
    }
  });

  it("returns 429 with a warning once the threshold is exceeded", async () => {
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => logger);

    for (let i = 0; i < 3; i++) {
      await hit();
    }
    const res = await hit();

    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      success: false,
      error: "Too many requests, please try again later",
    });
    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(warn).toHaveBeenCalledWith(
      "Refund ratio helper rate limit exceeded",
      expect.objectContaining({ label: "refund-ratio-helper", status: 429 })
    );
  });

  it("keeps rejecting further requests within the same window", async () => {
    jest.spyOn(logger, "warn").mockImplementation(() => logger);
    for (let i = 0; i < 3; i++) {
      await hit();
    }
    expect((await hit()).status).toBe(429);
    expect((await hit()).status).toBe(429);
  });

  it("tracks each client independently", async () => {
    jest.spyOn(logger, "warn").mockImplementation(() => logger);
    for (let i = 0; i < 4; i++) {
      await hit("10.0.0.1");
    }
    expect((await hit("10.0.0.1")).status).toBe(429);
    expect((await hit("10.0.0.2")).status).toBe(200);
  });

  it("does not throttle routes outside the refund ratio path", async () => {
    jest.spyOn(logger, "warn").mockImplementation(() => logger);
    for (let i = 0; i < 4; i++) {
      await hit();
    }
    const res = await request(app).get("/api/other").set("X-Forwarded-For", "10.0.0.1");
    expect(res.status).toBe(200);
  });

  it("resets the bucket once the window elapses", async () => {
    jest.spyOn(logger, "warn").mockImplementation(() => logger);
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
    for (let i = 0; i < 4; i++) {
      await hit();
    }
    expect((await hit()).status).toBe(429);

    now.mockReturnValue(1_000_000 + 60_000);
    expect((await hit()).status).toBe(200);
  });

  it("falls back to defaults when env configuration is invalid", async () => {
    process.env.REFUND_RATIO_RATE_MAX = "not-a-number";
    process.env.REFUND_RATIO_RATE_WINDOW_MS = "-5";
    const res = await hit();
    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBe("20");
  });
});
