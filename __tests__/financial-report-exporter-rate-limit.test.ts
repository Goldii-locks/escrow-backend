import type { NextFunction, Request, Response } from "express";
import {
  financialReportExporterRateLimit,
  resetFinancialReportExporterRateLimitBuckets,
} from "../src/middleware/financial-report-exporter-rate-limit.js";

type Recorded = {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  nextCalled: boolean;
};

function runMiddleware(ip: string): Recorded {
  const headers: Record<string, string> = {};
  const recorded: Recorded = { status: 200, body: undefined, headers, nextCalled: false };

  const req = { ip, socket: { remoteAddress: ip } } as unknown as Request;
  const res = {
    setHeader(name: string, value: string) {
      headers[name] = value;
      return this;
    },
    status(code: number) {
      recorded.status = code;
      return this;
    },
    json(payload: unknown) {
      recorded.body = payload;
      return this;
    },
  } as unknown as Response;
  const next: NextFunction = () => {
    recorded.nextCalled = true;
  };

  financialReportExporterRateLimit(req, res, next);
  return recorded;
}

const ORIGINAL_ENV = { ...process.env };

describe("financial-report-exporter-rate-limit", () => {
  beforeEach(() => {
    resetFinancialReportExporterRateLimitBuckets();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("calls next() while requests stay under the limit", () => {
    process.env.FINANCIAL_REPORT_EXPORTER_RATE_MAX = "3";
    const first = runMiddleware("10.0.0.1");
    expect(first.nextCalled).toBe(true);
    expect(first.status).toBe(200);
  });

  it("exposes the limit, remaining count and reset epoch", () => {
    process.env.FINANCIAL_REPORT_EXPORTER_RATE_MAX = "5";
    const first = runMiddleware("10.0.0.2");
    expect(first.headers["X-RateLimit-Limit"]).toBe("5");
    expect(first.headers["X-RateLimit-Remaining"]).toBe("4");
    expect(Number(first.headers["X-RateLimit-Reset"])).toBeGreaterThan(
      Math.floor(Date.now() / 1000) - 5
    );
  });

  it("returns 429 once the threshold is exceeded", () => {
    process.env.FINANCIAL_REPORT_EXPORTER_RATE_MAX = "2";
    const ip = "10.0.0.3";

    expect(runMiddleware(ip).nextCalled).toBe(true);
    expect(runMiddleware(ip).nextCalled).toBe(true);

    const blocked = runMiddleware(ip);
    expect(blocked.nextCalled).toBe(false);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      success: false,
      error: "Too many requests, please try again later",
      retryAfterSeconds: expect.any(Number),
    });
    expect(Number(blocked.headers["Retry-After"])).toBeGreaterThanOrEqual(1);
    expect(blocked.headers["X-RateLimit-Remaining"]).toBe("0");
  });

  it("tracks each client IP independently", () => {
    process.env.FINANCIAL_REPORT_EXPORTER_RATE_MAX = "1";
    expect(runMiddleware("10.0.0.4").nextCalled).toBe(true);
    expect(runMiddleware("10.0.0.4").status).toBe(429);
    // A different caller still has its full allowance.
    expect(runMiddleware("10.0.0.5").nextCalled).toBe(true);
  });

  it("starts a fresh window after the configured interval elapses", () => {
    process.env.FINANCIAL_REPORT_EXPORTER_RATE_MAX = "1";
    process.env.FINANCIAL_REPORT_EXPORTER_RATE_WINDOW_MS = "50";
    const ip = "10.0.0.6";

    expect(runMiddleware(ip).nextCalled).toBe(true);
    expect(runMiddleware(ip).status).toBe(429);

    const waitUntil = Date.now() + 60;
    while (Date.now() < waitUntil) {
      /* busy-wait the short window */
    }

    expect(runMiddleware(ip).nextCalled).toBe(true);
  });

  it("falls back to defaults when configuration is unusable", () => {
    process.env.FINANCIAL_REPORT_EXPORTER_RATE_MAX = "not-a-number";
    const recorded = runMiddleware("10.0.0.7");
    expect(recorded.headers["X-RateLimit-Limit"]).toBe("20");
    expect(recorded.nextCalled).toBe(true);
  });

  it("resetFinancialReportExporterRateLimitBuckets clears recorded usage", () => {
    process.env.FINANCIAL_REPORT_EXPORTER_RATE_MAX = "1";
    const ip = "10.0.0.8";
    expect(runMiddleware(ip).nextCalled).toBe(true);
    expect(runMiddleware(ip).status).toBe(429);

    resetFinancialReportExporterRateLimitBuckets();
    expect(runMiddleware(ip).nextCalled).toBe(true);
  });
});
