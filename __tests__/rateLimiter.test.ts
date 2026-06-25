import request from "supertest";
import express from "express";
import rateLimit from "express-rate-limit";

describe("Rate Limiting", () => {
  it("returns 429 after exceeding configured limit", async () => {
    const app = express();
    const testLimiter = rateLimit({
      windowMs: 60_000,
      max: 3,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        success: false,
        error: "Too many requests, please try again later.",
      },
    });

    app.get("/test", testLimiter, (_req, res) => {
      res.json({ success: true });
    });

    for (let i = 0; i < 3; i++) {
      const res = await request(app).get("/test");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    }

    const res = await request(app).get("/test");
    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("Too many requests, please try again later.");
  });

  it("returns standard rate limit headers when limited", async () => {
    const app = express();
    const testLimiter = rateLimit({
      windowMs: 60_000,
      max: 1,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, error: "Too many requests" },
    });

    app.get("/test", testLimiter, (_req, res) => {
      res.json({ success: true });
    });

    await request(app).get("/test");

    const res = await request(app).get("/test");
    expect(res.status).toBe(429);
    expect(res.headers["ratelimit-remaining"]).toBe("0");
    expect(res.headers["ratelimit-limit"]).toBe("1");
    expect(res.headers["retry-after"]).toBeDefined();
  });
});
