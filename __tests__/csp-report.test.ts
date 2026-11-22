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

const {
  default: cspReportRoutes,
  resetCspReportRateLimitBuckets,
  resetCspReportDedupCache,
} = await import("../src/routes/csp-report.js");

function buildApp() {
  const app = express();
  app.use("/api/csp-report", cspReportRoutes);
  return app;
}

describe("POST /api/csp-report (#918)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetCspReportRateLimitBuckets();
    resetCspReportDedupCache();
  });

  it("accepts application/csp-report format, strips query strings, and returns 204", async () => {
    const app = buildApp();
    const payload = {
      "csp-report": {
        "document-uri": "https://example.com/jobs/detail?id=123&token=abc",
        "violated-directive": "script-src 'self'",
        "blocked-uri": "https://evil.com:8080/tracker.js?uid=456",
        "source-file": "https://example.com/bundle.js?v=2",
      },
    };

    await request(app)
      .post("/api/csp-report")
      .set("Content-Type", "application/csp-report")
      .send(JSON.stringify(payload))
      .expect(204);

    expect(mockLogger.info).toHaveBeenCalledWith(
      "CSP violation report",
      expect.objectContaining({
        documentUri: "/jobs/detail",
        violatedDirective: "script-src 'self'",
        blockedUri: "https://evil.com:8080",
        sourceFile: "https://example.com/bundle.js",
      }),
    );
  });

  it("accepts application/reports+json format and returns 204", async () => {
    const app = buildApp();
    const payload = [
      {
        type: "csp-violation",
        body: {
          documentURL: "https://example.com/admin/settings?section=security",
          effectiveDirective: "img-src",
          blockedURL: "https://untrusted-cdn.com/pixel.png?ref=1",
          sourceFile: "https://example.com/admin.js",
        },
      },
    ];

    await request(app)
      .post("/api/csp-report")
      .set("Content-Type", "application/reports+json")
      .send(JSON.stringify(payload))
      .expect(204);

    expect(mockLogger.info).toHaveBeenCalledWith(
      "CSP violation report",
      expect.objectContaining({
        documentUri: "/admin/settings",
        violatedDirective: "img-src",
        blockedUri: "https://untrusted-cdn.com",
        sourceFile: "https://example.com/admin.js",
      }),
    );
  });

  it("returns HTTP 400 for malformed JSON instead of HTTP 500", async () => {
    const app = buildApp();

    const res = await request(app)
      .post("/api/csp-report")
      .set("Content-Type", "application/csp-report")
      .send('{"csp-report": { invalid json')
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("deduplicates reports: same directive and blocked origin logged at most once per minute", async () => {
    const app = buildApp();
    const payload = {
      "csp-report": {
        "document-uri": "https://example.com/page1",
        "violated-directive": "connect-src",
        "blocked-uri": "https://blocked-api.com/v1",
      },
    };

    // First report logs
    await request(app)
      .post("/api/csp-report")
      .set("Content-Type", "application/csp-report")
      .send(JSON.stringify(payload))
      .expect(204);

    expect(mockLogger.info).toHaveBeenCalledTimes(1);

    // Second report with same directive & blocked origin within 1 min does NOT log
    await request(app)
      .post("/api/csp-report")
      .set("Content-Type", "application/csp-report")
      .send(JSON.stringify(payload))
      .expect(204);

    expect(mockLogger.info).toHaveBeenCalledTimes(1);

    // Different directive logs
    const diffPayload = {
      "csp-report": {
        "document-uri": "https://example.com/page1",
        "violated-directive": "script-src",
        "blocked-uri": "https://blocked-api.com/v1",
      },
    };

    await request(app)
      .post("/api/csp-report")
      .set("Content-Type", "application/csp-report")
      .send(JSON.stringify(diffPayload))
      .expect(204);

    expect(mockLogger.info).toHaveBeenCalledTimes(2);
  });

  it("enforces per-IP rate limiting and returns 429", async () => {
    const app = buildApp();
    const payload = {
      "csp-report": {
        "violated-directive": "script-src",
        "blocked-uri": "https://evil.com",
      },
    };

    for (let i = 0; i < 30; i++) {
      await request(app)
        .post("/api/csp-report")
        .set("Content-Type", "application/csp-report")
        .send(JSON.stringify(payload))
        .expect(204);
    }

    const res = await request(app)
      .post("/api/csp-report")
      .set("Content-Type", "application/csp-report")
      .send(JSON.stringify(payload))
      .expect(429);

    expect(res.body.success).toBe(false);
  });
});
