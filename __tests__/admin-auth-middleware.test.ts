import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: mockLogger,
}));

const { requireAdmin } = await import("../src/middleware/adminAuth.js");
const { assertDisjointApiKeyLists } = await import("../src/utils/api-keys.js");

const KEY = "s3cret-admin-key";

function buildApp() {
  const app = express();
  app.get("/admin/ping", requireAdmin, (_req, res) => {
    res.status(200).json({ success: true, data: "pong" });
  });
  return app;
}

describe("requireAdmin", () => {
  const originalKey = process.env.ADMIN_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalKey;
    jest.clearAllMocks();
  });

  describe("when ADMIN_API_KEY is configured", () => {
    beforeEach(() => {
      process.env.ADMIN_API_KEY = KEY;
    });

    it("allows a request carrying the key in x-admin-key without a warning", async () => {
      const res = await request(buildApp())
        .get("/admin/ping")
        .set("x-admin-key", KEY);

      expect(res.status).toBe(200);
      expect(res.body.data).toBe("pong");
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("allows a request carrying the key as a Bearer token without a warning", async () => {
      const res = await request(buildApp())
        .get("/admin/ping")
        .set("authorization", `Bearer ${KEY}`);

      expect(res.status).toBe(200);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("still accepts the deprecated x-api-key header but logs a warning", async () => {
      const res = await request(buildApp())
        .get("/admin/ping")
        .set("x-api-key", KEY);

      expect(res.status).toBe(200);
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("deprecated x-api-key"),
        expect.objectContaining({ path: "/admin/ping" }),
      );
    });

    it("does not log the deprecation warning for a rejected x-api-key", async () => {
      const res = await request(buildApp())
        .get("/admin/ping")
        .set("x-api-key", "not-the-key");

      expect(res.status).toBe(401);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("prefers x-admin-key over the other headers", async () => {
      const res = await request(buildApp())
        .get("/admin/ping")
        .set("x-admin-key", KEY)
        .set("authorization", "Bearer wrong-key")
        .set("x-api-key", "wrong-key");

      expect(res.status).toBe(200);
    });

    it("prefers a Bearer token over x-api-key", async () => {
      const res = await request(buildApp())
        .get("/admin/ping")
        .set("authorization", `Bearer ${KEY}`)
        .set("x-api-key", "a-public-key");

      expect(res.status).toBe(200);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("rejects a request with no credentials", async () => {
      const res = await request(buildApp()).get("/admin/ping");

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ success: false, error: "Unauthorized" });
    });

    it("rejects a wrong key", async () => {
      const res = await request(buildApp())
        .get("/admin/ping")
        .set("x-api-key", "not-the-key");

      expect(res.status).toBe(401);
    });

    it("rejects a bare token without the Bearer scheme", async () => {
      const res = await request(buildApp())
        .get("/admin/ping")
        .set("authorization", KEY);

      expect(res.status).toBe(401);
    });

    it("does not treat a key that merely starts with the secret as valid", async () => {
      const res = await request(buildApp())
        .get("/admin/ping")
        .set("x-api-key", `${KEY}-extra`);

      expect(res.status).toBe(401);
    });

    it("is case-sensitive about the key", async () => {
      const res = await request(buildApp())
        .get("/admin/ping")
        .set("x-api-key", KEY.toUpperCase());

      expect(res.status).toBe(401);
    });
  });

  describe("when ADMIN_API_KEY is not configured", () => {
    beforeEach(() => {
      delete process.env.ADMIN_API_KEY;
    });

    // Fail closed: an unset secret must lock the route, never open it.
    it("rejects even a request that supplies a key", async () => {
      const res = await request(buildApp())
        .get("/admin/ping")
        .set("x-api-key", KEY);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ success: false, error: "Unauthorized" });
    });

    it("rejects a request with no credentials", async () => {
      const res = await request(buildApp()).get("/admin/ping");
      expect(res.status).toBe(401);
    });

    it("rejects when the key is set to an empty string", async () => {
      process.env.ADMIN_API_KEY = "";
      const res = await request(buildApp())
        .get("/admin/ping")
        .set("x-api-key", "");

      expect(res.status).toBe(401);
    });
  });
});

describe("assertDisjointApiKeyLists (#970)", () => {
  it("passes when the public and admin key lists are distinct", () => {
    expect(() =>
      assertDisjointApiKeyLists({ API_KEYS: "a,b", ADMIN_API_KEYS: "c" }),
    ).not.toThrow();
  });

  it("passes when either list is unset", () => {
    expect(() => assertDisjointApiKeyLists({ API_KEYS: "a" })).not.toThrow();
    expect(() => assertDisjointApiKeyLists({ ADMIN_API_KEYS: "a" })).not.toThrow();
  });

  it("fails startup when a key appears in both lists", () => {
    expect(() =>
      assertDisjointApiKeyLists({ API_KEYS: "a, shared", ADMIN_API_KEYS: "shared ,c" }),
    ).toThrow(/both API_KEYS and ADMIN_API_KEYS/);
  });

  it("checks the singular API_KEY / ADMIN_API_KEY fallbacks too", () => {
    expect(() =>
      assertDisjointApiKeyLists({ API_KEY: "same", ADMIN_API_KEY: "same" }),
    ).toThrow(/both API_KEYS and ADMIN_API_KEYS/);
  });

  it("does not include the overlapping key in the error message", () => {
    let message = "";
    try {
      assertDisjointApiKeyLists({ API_KEYS: "top-secret", ADMIN_API_KEYS: "top-secret" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/both API_KEYS and ADMIN_API_KEYS/);
    expect(message).not.toContain("top-secret");
  });
});

describe("startup with overlapping key lists (src/index.ts)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("refuses to start when a value is in both API_KEYS and ADMIN_API_KEYS", async () => {
    process.env.NODE_ENV = "test";
    process.env.API_KEYS = "public-1,shared-key";
    process.env.ADMIN_API_KEYS = "shared-key";

    await expect(import("../src/index.js")).rejects.toThrow(
      /both API_KEYS and ADMIN_API_KEYS/,
    );
  });
});
