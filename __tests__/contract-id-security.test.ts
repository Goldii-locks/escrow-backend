import request from "supertest";
import express from "express";
import Database from "better-sqlite3";
import { initSchema, setDb } from "../src/indexer/db.js";
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

describe("job contract security middleware", () => {
  const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;

  afterEach(() => {
    if (originalAllowedOrigins === undefined) {
      delete process.env.ALLOWED_ORIGINS;
    } else {
      process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
    }
  });

  it("parses ALLOWED_ORIGINS from the environment", () => {
    process.env.ALLOWED_ORIGINS =
      "https://app.example.com, https://admin.example.com";
    expect(getAllowedOrigins()).toEqual([
      "https://app.example.com",
      "https://admin.example.com",
    ]);
  });
});

describe("GET /api/jobs/:contractId – CORS and security headers", () => {
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

  it("rejects requests from unauthorized origins with 403", async () => {
    const res = await request(app)
      .get(`/api/jobs/${VALID_CONTRACT}`)
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
      .get(`/api/jobs/${VALID_CONTRACT}`)
      .set("Origin", "https://trusted.example.com");

    expect(res.status).not.toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://trusted.example.com"
    );
    expect(res.headers.vary).toContain("Origin");
  });

  it("applies security headers on GET /api/jobs/:contractId", async () => {
    const res = await request(app).get(`/api/jobs/${VALID_CONTRACT}`);

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'");
  });

  it("does not apply the contract security headers to by-wallet routes", async () => {
    const res = await request(app)
      .get("/api/jobs/by-wallet/GNOBODYKNOWSME")
      .set("Origin", "https://evil.example.com")
      .expect(200);

    expect(res.headers["x-frame-options"]).toBeUndefined();
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
