import { jest } from "@jest/globals";
import request from "supertest";
import type { Request, Response } from "express";
import { createApp, assertProductionEnv, globalErrorHandler } from "../src/app.js";
import { config } from "../src/config.js";

describe("assertProductionEnv (#625)", () => {
  it("does nothing outside production", () => {
    expect(() => assertProductionEnv({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => assertProductionEnv({} as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("throws listing every missing variable in production", () => {
    expect(() =>
      assertProductionEnv({ NODE_ENV: "production" } as NodeJS.ProcessEnv),
    ).toThrow(/Missing required production environment variables/);
  });

  it.each([
    "API_KEYS",
    "ADMIN_API_KEYS",
    "ALLOWED_ORIGINS",
    "CONTRACT_ID",
    "SOROBAN_RPC_URL",
    "SOROBAN_NETWORK_PASSPHRASE",
  ])("reports %s when it is the only variable missing", (missing) => {
    const full = {
      NODE_ENV: "production",
      API_KEYS: "k",
      ADMIN_API_KEYS: "k",
      ALLOWED_ORIGINS: "https://app.example.com",
      CONTRACT_ID: "CABC",
      SOROBAN_RPC_URL: "https://rpc.example.com",
      SOROBAN_NETWORK_PASSPHRASE: "passphrase",
    } as unknown as NodeJS.ProcessEnv;
    delete (full as Record<string, string | undefined>)[missing];
    expect(() => assertProductionEnv(full)).toThrow(new RegExp(missing));
  });

  it("accepts legacy API_KEY / ADMIN_API_KEY alternatives", () => {
    const env = {
      NODE_ENV: "production",
      API_KEY: "k",
      ADMIN_API_KEY: "k",
      ALLOWED_ORIGINS: "https://app.example.com",
      CONTRACT_ID: "CABC",
      SOROBAN_RPC_URL: "https://rpc.example.com",
      SOROBAN_NETWORK_PASSPHRASE: "passphrase",
    } as unknown as NodeJS.ProcessEnv;
    expect(() => assertProductionEnv(env)).not.toThrow();
  });
});

describe("createApp (#625)", () => {
  it("serves /health (covers request logger + health route)", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("global error handler returns 500 without leaking internals", () => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as unknown as Response;
    globalErrorHandler(
      new Error("secret detail"),
      { path: "/boom" } as Request,
      res,
      jest.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Internal server error",
    });
  });

  it("global error handler coerces non-Error values", () => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as unknown as Response;
    globalErrorHandler("plain string", { path: "/x" } as Request, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("rejects an oversized JSON body with the standard 413 envelope (#1005)", async () => {
    const original = process.env.JSON_BODY_LIMIT;
    process.env.JSON_BODY_LIMIT = "16b";
    try {
      const res = await request(createApp())
        .post("/api/jobs/create-job-draft")
        .send({ payload: "x".repeat(128) })
        .expect(413);

      expect(res.body).toEqual({ success: false, error: "Payload too large" });
      expect(res.headers["content-type"]).toMatch(/json/);
    } finally {
      if (original === undefined) delete process.env.JSON_BODY_LIMIT;
      else process.env.JSON_BODY_LIMIT = original;
    }
  });
});

describe("CONTRACT_ID live config (#1006)", () => {
  const original = process.env.CONTRACT_ID;

  afterEach(() => {
    if (original === undefined) delete process.env.CONTRACT_ID;
    else process.env.CONTRACT_ID = original;
  });

  it("uses a value set after module import in /health", async () => {
    process.env.CONTRACT_ID = "  C-LIVE-AFTER-IMPORT  ";

    expect(config.contractId).toBe("C-LIVE-AFTER-IMPORT");
    const res = await request(createApp()).get("/health");
    expect(res.body.contract).toBe("C-LIVE-AFTER-IMPORT");
  });
});
