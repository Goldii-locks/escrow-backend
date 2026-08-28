import request from "supertest";
import express from "express";
import { jest } from "@jest/globals";

// Mock the indexer DB so we don't need a real SQLite connection for security tests
jest.unstable_mockModule("../src/indexer/db.js", () => ({
  getJobsByWallet: jest.fn().mockReturnValue({
    data: [],
    pagination: { page: 1, limit: 10, totalPages: 0, totalItems: 0 },
  }),
  getEventsByContract: jest.fn(),
}));

const { default: router } = await import("../src/routes/jobs.js");

const app = express();
app.use(express.json());
app.use("/api/jobs", router);

describe("GET /api/jobs/by-wallet/:address — security and CORS", () => {
  const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;
  const WALLET_ADDRESS = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";

  beforeEach(() => {
    process.env.ALLOWED_ORIGINS = "https://trusted-frontend.com,http://localhost:3000";
  });

  afterEach(() => {
    if (originalAllowedOrigins === undefined) {
      delete process.env.ALLOWED_ORIGINS;
    } else {
      process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
    }
  });

  describe("CORS behavior", () => {
    it("allows requests from a configured allowed origin", async () => {
      const res = await request(app)
        .get(`/api/jobs/by-wallet/${WALLET_ADDRESS}`)
        .set("Origin", "https://trusted-frontend.com")
        .expect(200);

      expect(res.headers["access-control-allow-origin"]).toBe("https://trusted-frontend.com");
    });

    it("allows OPTIONS requests from a configured allowed origin", async () => {
      const res = await request(app)
        .options(`/api/jobs/by-wallet/${WALLET_ADDRESS}`)
        .set("Origin", "http://localhost:3000")
        .expect(204);

      expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
      expect(res.headers["access-control-allow-methods"]).toContain("GET");
      expect(res.headers["access-control-allow-methods"]).toContain("OPTIONS");
    });

    it("rejects requests from an unauthorized origin", async () => {
      const res = await request(app)
        .get(`/api/jobs/by-wallet/${WALLET_ADDRESS}`)
        .set("Origin", "https://malicious-site.com")
        .expect(403);

      expect(res.body).toEqual({
        success: false,
        error: "Origin not allowed by CORS policy",
      });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("rejects OPTIONS requests from an unauthorized origin", async () => {
      const res = await request(app)
        .options(`/api/jobs/by-wallet/${WALLET_ADDRESS}`)
        .set("Origin", "https://malicious-site.com")
        .expect(403);

      expect(res.body).toEqual({
        success: false,
        error: "Origin not allowed by CORS policy",
      });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("allows requests without an Origin header (e.g. server-to-server / curl)", async () => {
      const res = await request(app)
        .get(`/api/jobs/by-wallet/${WALLET_ADDRESS}`)
        .expect(200);

      expect(res.body.success).toBe(true);
    });
  });

  describe("Security Headers", () => {
    it("includes required security headers in the response", async () => {
      const res = await request(app)
        .get(`/api/jobs/by-wallet/${WALLET_ADDRESS}`)
        .set("Origin", "https://trusted-frontend.com")
        .expect(200);

      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["x-xss-protection"]).toBe("0");
      expect(res.headers["content-security-policy"]).toBe("default-src 'none'");
      expect(res.headers["permissions-policy"]).toContain("camera=()");
    });
  });
});
