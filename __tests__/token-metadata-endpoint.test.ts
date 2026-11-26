import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";

// The strict limiter is configured with max 0 under NODE_ENV=test, which
// rejects every request; bypass it like the other route suites do.
jest.unstable_mockModule("../src/middleware/rateLimiter.js", () => ({
  strictLimiter: (_req: any, _res: any, next: any) => next(),
  walletLookupLimiter: (_req: any, _res: any, next: any) => next(),
  generalLimiter: (_req: any, _res: any, next: any) => next(),
}));

const {
  resolveTokenMetadata,
  setTokenMetadataSimulatorForTests,
  clearTokenMetadataCache,
  getTokenLabel,
} = await import("../src/utils/token-metadata.js");
const { default: tokenRoutes } = await import("../src/routes/tokens.js");

const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const NON_TOKEN = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

function buildApp() {
  const app = express();
  app.use("/api/tokens", tokenRoutes);
  return app;
}

describe("GET /api/tokens/:contractId (#957)", () => {
  beforeEach(() => {
    clearTokenMetadataCache();
    setTokenMetadataSimulatorForTests(null);
  });

  afterEach(() => {
    clearTokenMetadataCache();
    setTokenMetadataSimulatorForTests(null);
  });

  it("returns resolved metadata and sets cache headers", async () => {
    const simulate = jest.fn(async (_addr: string, method: string) => {
      if (method === "decimals") return 6;
      if (method === "symbol") return "USDC";
      if (method === "name") return "USD Coin";
      throw new Error("unexpected");
    });
    setTokenMetadataSimulatorForTests(simulate as any);

    const app = buildApp();
    const res = await request(app).get(`/api/tokens/${TOKEN}`).expect(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
    expect(res.body).toEqual({
      success: true,
      data: {
        contractId: TOKEN,
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        label: getTokenLabel("USDC"),
      },
    });
  });

  it("returns 404 when the contract is not a token", async () => {
    setTokenMetadataSimulatorForTests((async () => {
      throw new Error("missing");
    }) as any);
    const app = buildApp();
    const res = await request(app).get(`/api/tokens/${NON_TOKEN}`).expect(404);
    expect(res.body).toEqual({ success: false, error: "Token metadata not found for this contract" });
  });

  it("serves a cache hit without a second simulation", async () => {
    const simulate = jest.fn(async (_addr: string, method: string) => {
      if (method === "decimals") return 7;
      if (method === "symbol") return "XLM";
      if (method === "name") return "Stellar Lumens";
      throw new Error("unexpected");
    });
    // Prime the resolver cache directly.
    await resolveTokenMetadata(TOKEN, { simulate: simulate as any });
    expect(simulate).toHaveBeenCalled();

    // Route should answer from cache without invoking the test simulator again.
    setTokenMetadataSimulatorForTests((async () => {
      throw new Error("should not simulate on cache hit");
    }) as any);
    const app = buildApp();
    const res = await request(app).get(`/api/tokens/${TOKEN}`).expect(200);
    expect(res.body.data.decimals).toBe(7);
    expect(res.body.data.symbol).toBe("XLM");
  });
});
