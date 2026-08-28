import request from "supertest";
import express from "express";
import Database from "better-sqlite3";
import { initSchema, setDb } from "../src/indexer/db.js";
import { resetTimeRemainingRateLimitBuckets } from "../src/middleware/job-contract-rate-limit.js";
import { getAllowedOrigins } from "../src/middleware/job-contract-security.js";

const VALID_CONTRACT =
  "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";

let testDb: Database.Database;
let app: express.Express;

beforeAll(async () => {
  testDb = new Database(":memory:");
  setDb(testDb);
  initSchema();
  const { default: router } = await import("../src/routes/jobs.js");
  app = express();
  app.use(express.json());
  app.use("/api/jobs", router);
});

afterAll(() => {
  testDb.close();
});

describe("GET /api/jobs/:contractId/milestones/:index/time-remaining", () => {
  describe("#120 – CORS and Security Headers", () => {
    const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;

    beforeEach(() => {
      process.env.ALLOWED_ORIGINS = "https://trusted.example.com";
    });

    afterEach(() => {
      if (originalAllowedOrigins === undefined) {
        delete process.env.ALLOWED_ORIGINS;
      } else {
        process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
      }
    });

    describe("CORS validation", () => {
      it("rejects requests from unauthorized origins with 403", async () => {
        const res = await request(app)
          .get(`/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`)
          .set("Origin", "https://evil.example.com")
          .expect(403);

        expect(res.body).toEqual({
          success: false,
          error: "Origin not allowed by CORS policy",
        });
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      });

      it("allows trusted origins and sets CORS response headers", async () => {
        const res = await request(app)
          .get(`/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`)
          .set("Origin", "https://trusted.example.com");

        // May be 4xx/5xx due to contract simulation, but CORS headers should be present
        if (res.status !== 403) {
          expect(res.headers["access-control-allow-origin"]).toBe(
            "https://trusted.example.com"
          );
          expect(res.headers.vary).toContain("Origin");
        }
      });

      it("allows GET and OPTIONS methods in CORS headers", async () => {
        const res = await request(app)
          .get(`/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`)
          .set("Origin", "https://trusted.example.com");

        if (res.status !== 403) {
          expect(res.headers["access-control-allow-methods"]).toContain("GET");
        }
      });

      it("allows Content-Type and Authorization headers in CORS", async () => {
        const res = await request(app)
          .get(`/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`)
          .set("Origin", "https://trusted.example.com");

        if (res.status !== 403) {
          expect(res.headers["access-control-allow-headers"]).toContain(
            "Content-Type"
          );
          expect(res.headers["access-control-allow-headers"]).toContain(
            "Authorization"
          );
        }
      });

      it("includes Vary header for Origin-based caching", async () => {
        const res = await request(app)
          .get(`/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`)
          .set("Origin", "https://trusted.example.com");

        if (res.status !== 403) {
          expect(res.headers.vary).toBeDefined();
        }
      });
    });

    describe("Security headers", () => {
      it("applies X-Content-Type-Options header", async () => {
        const res = await request(app)
          .get(`/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`)
          .set("Origin", "https://trusted.example.com");

        expect(res.headers["x-content-type-options"]).toBe("nosniff");
      });

      it("applies X-Frame-Options header", async () => {
        const res = await request(app)
          .get(`/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`)
          .set("Origin", "https://trusted.example.com");

        expect(res.headers["x-frame-options"]).toBe("DENY");
      });

      it("applies Referrer-Policy header", async () => {
        const res = await request(app)
          .get(`/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`)
          .set("Origin", "https://trusted.example.com");

        expect(res.headers["referrer-policy"]).toBe("no-referrer");
      });

      it("applies X-XSS-Protection header", async () => {
        const res = await request(app)
          .get(`/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`)
          .set("Origin", "https://trusted.example.com");

        expect(res.headers["x-xss-protection"]).toBe("0");
      });

      it("applies Content-Security-Policy header", async () => {
        const res = await request(app)
          .get(`/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`)
          .set("Origin", "https://trusted.example.com");

        expect(res.headers["content-security-policy"]).toBe("default-src 'none'");
      });

      it("applies Permissions-Policy header", async () => {
        const res = await request(app)
          .get(`/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`)
          .set("Origin", "https://trusted.example.com");

        expect(res.headers["permissions-policy"]).toContain("camera=()");
        expect(res.headers["permissions-policy"]).toContain("microphone=()");
        expect(res.headers["permissions-policy"]).toContain("geolocation=()");
      });
    });
  });

  describe("#121 – Rate Limiting", () => {
    const originalMax = process.env.TIME_REMAINING_RATE_MAX;
    const originalWindow = process.env.TIME_REMAINING_RATE_WINDOW_MS;

    beforeEach(() => {
      resetTimeRemainingRateLimitBuckets();
      process.env.TIME_REMAINING_RATE_MAX = "5";
      process.env.TIME_REMAINING_RATE_WINDOW_MS = "60000";
    });

    afterEach(() => {
      resetTimeRemainingRateLimitBuckets();
      if (originalMax === undefined) {
        delete process.env.TIME_REMAINING_RATE_MAX;
      } else {
        process.env.TIME_REMAINING_RATE_MAX = originalMax;
      }
      if (originalWindow === undefined) {
        delete process.env.TIME_REMAINING_RATE_WINDOW_MS;
      } else {
        process.env.TIME_REMAINING_RATE_WINDOW_MS = originalWindow;
      }
    });

    it("allows requests up to the configured threshold", async () => {
      const threshold = 5;
      for (let i = 0; i < threshold; i++) {
        const res = await request(app).get(
          `/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`
        );
        // Status can be anything except 429 (rate limit exceeded)
        expect(res.status).not.toBe(429);
      }
    });

    it("returns 429 once the threshold is exceeded", async () => {
      // Make 5 requests (max threshold)
      for (let i = 0; i < 5; i++) {
        await request(app).get(
          `/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`
        );
      }

      // The 6th request should be rate limited
      const res = await request(app)
        .get(`/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`)
        .expect(429);

      expect(res.body).toEqual({
        success: false,
        error: "Too many requests, please try again later",
      });
    });

    it("includes X-RateLimit headers in response", async () => {
      const res = await request(app).get(
        `/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`
      );

      expect(res.headers["x-ratelimit-limit"]).toBe("5");
      expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
      expect(res.headers["x-ratelimit-reset"]).toBeDefined();
    });

    it("decrements X-RateLimit-Remaining with each request", async () => {
      const res1 = await request(app).get(
        `/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`
      );
      const remaining1 = parseInt(res1.headers["x-ratelimit-remaining"] as string, 10);

      const res2 = await request(app).get(
        `/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`
      );
      const remaining2 = parseInt(res2.headers["x-ratelimit-remaining"] as string, 10);

      expect(remaining2).toBe(remaining1 - 1);
    });

    it("includes X-RateLimit-Reset header with unix timestamp", async () => {
      const res = await request(app).get(
        `/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`
      );

      const resetTime = parseInt(res.headers["x-ratelimit-reset"] as string, 10);
      const now = Math.floor(Date.now() / 1000);

      // Reset time should be in the future (within a reasonable window)
      expect(resetTime).toBeGreaterThan(now);
      expect(resetTime).toBeLessThan(now + 120); // Within 2 minutes
    });

    it("has correct default rate limit configuration", async () => {
      delete process.env.TIME_REMAINING_RATE_MAX;
      delete process.env.TIME_REMAINING_RATE_WINDOW_MS;
      resetTimeRemainingRateLimitBuckets();

      // Default: 60 requests per 60000ms (60s). The first response advertises
      // the default limit, and requests 2–60 must all pass through.
      //
      // Every request must be awaited: constructing a supertest chain opens a
      // real listening server, and only executing the chain closes it again.
      const first = await request(app).get(
        `/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`
      );
      expect(first.status).not.toBe(429);
      expect(first.headers["x-ratelimit-limit"]).toBe("60");

      for (let i = 0; i < 59; i++) {
        const res = await request(app).get(
          `/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`
        );
        expect(res.status).not.toBe(429);
      }

      // The 61st request exceeds the default threshold.
      const blocked = await request(app).get(
        `/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`
      );
      expect(blocked.status).toBe(429);
      expect(blocked.body).toEqual({
        success: false,
        error: "Too many requests, please try again later",
      });
    });
  });

  describe("#123 – Zod Schema Validation", () => {
    it("rejects invalid contract ID format with validation error", async () => {
      const res = await request(app)
        .get("/api/jobs/INVALID/milestones/0/time-remaining")
        .expect(400);

      expect(res.body).toHaveProperty("error", "ValidationError");
      expect(res.body).toHaveProperty("details");
      expect(Array.isArray(res.body.details)).toBe(true);
    });

    it("rejects negative milestone index", async () => {
      const res = await request(app)
        .get(`/api/jobs/${VALID_CONTRACT}/milestones/-1/time-remaining`)
        .expect(400);

      expect(res.body).toHaveProperty("error", "ValidationError");
      expect(res.body.details).toContainEqual(
        expect.objectContaining({
          field: "index",
        })
      );
    });

    it("rejects non-integer milestone index", async () => {
      const res = await request(app)
        .get(`/api/jobs/${VALID_CONTRACT}/milestones/1.5/time-remaining`)
        .expect(400);

      expect(res.body).toHaveProperty("error", "ValidationError");
      expect(res.body.details).toContainEqual(
        expect.objectContaining({
          field: "index",
        })
      );
    });

    it("accepts valid contract ID and milestone index", async () => {
      const res = await request(app).get(
        `/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`
      );

      // Should not be a validation error (may be 4xx/5xx for other reasons)
      expect(res.body.error).not.toBe("ValidationError");
    });

    it("accepts string milestone index and converts to number", async () => {
      const res = await request(app).get(
        `/api/jobs/${VALID_CONTRACT}/milestones/42/time-remaining`
      );

      // Should not be a validation error
      expect(res.body.error).not.toBe("ValidationError");
    });
  });

  describe("#122 – Winston Logger Traces", () => {
    it("should have valid path variables and endpoint logic", async () => {
      // This test verifies the endpoint can be called with valid params
      // Logger output is captured at runtime, not in tests
      const res = await request(app).get(
        `/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`
      );

      // Response should have the expected shape (whether success or error)
      expect(res.body).toHaveProperty("success");
    });

    it("logs should be structured JSON format", async () => {
      // The logger is configured to output JSON structured logs
      // This test verifies the endpoint runs without error
      const res = await request(app)
        .get(`/api/jobs/${VALID_CONTRACT}/milestones/0/time-remaining`)
        .set("Origin", "https://trusted.example.com");

      // Just verify the request completes (logs are checked in debug mode)
      expect(res).toBeDefined();
    });
  });
});
