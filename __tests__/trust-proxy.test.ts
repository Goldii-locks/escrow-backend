import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import rateLimit from "express-rate-limit";
import { resolveTrustProxy } from "../src/utils/trust-proxy.js";

function buildApp(env: NodeJS.ProcessEnv) {
  const app = express();
  app.set("trust proxy", resolveTrustProxy(env));
  app.use(rateLimit({ windowMs: 60_000, limit: 1, standardHeaders: true, legacyHeaders: false }));
  app.get("/ip", (req, res) => {
    res.json({ ip: req.ip });
  });
  return app;
}

describe("resolveTrustProxy (#600)", () => {
  it("defaults to one hop in production and off elsewhere", () => {
    expect(resolveTrustProxy({ NODE_ENV: "production" })).toBe(1);
    expect(resolveTrustProxy({ NODE_ENV: "development" })).toBe(false);
  });

  it("honours TRUST_PROXY_HOPS, treating 0 as off", () => {
    expect(resolveTrustProxy({ NODE_ENV: "production", TRUST_PROXY_HOPS: "0" })).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY_HOPS: "2" })).toBe(2);
  });

  it("rejects values that are not a hop count", () => {
    expect(() => resolveTrustProxy({ TRUST_PROXY_HOPS: "true" })).toThrow(/TRUST_PROXY_HOPS/);
    expect(() => resolveTrustProxy({ TRUST_PROXY_HOPS: "-1" })).toThrow(/TRUST_PROXY_HOPS/);
  });
});

describe("trust proxy and rate limiting (#600)", () => {
  let consoleError: ReturnType<typeof jest.spyOn>;
  let consoleWarn: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  it("puts different X-Forwarded-For clients in separate buckets with TRUST_PROXY_HOPS=1", async () => {
    const app = buildApp({ TRUST_PROXY_HOPS: "1" });

    const a = await request(app).get("/ip").set("X-Forwarded-For", "203.0.113.1");
    const b = await request(app).get("/ip").set("X-Forwarded-For", "203.0.113.2");
    const aAgain = await request(app).get("/ip").set("X-Forwarded-For", "203.0.113.1");

    expect(a.status).toBe(200);
    expect(a.body.ip).toBe("203.0.113.1");
    expect(b.status).toBe(200);
    expect(b.body.ip).toBe("203.0.113.2");
    expect(aAgain.status).toBe(429);

    const logged = JSON.stringify([...consoleError.mock.calls, ...consoleWarn.mock.calls]);
    expect(logged).not.toContain("ERR_ERL_UNEXPECTED_X_FORWARDED_FOR");
  });

  it("ignores a spoofed X-Forwarded-For when trust proxy is off", async () => {
    const app = buildApp({ NODE_ENV: "development" });

    const res = await request(app).get("/ip").set("X-Forwarded-For", "203.0.113.9");

    expect(res.status).toBe(200);
    expect(res.body.ip).not.toBe("203.0.113.9");
  });
});
