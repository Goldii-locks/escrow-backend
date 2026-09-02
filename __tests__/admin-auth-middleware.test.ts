import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";

const { requireAdmin } = await import("../src/middleware/adminAuth.js");

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

    it("allows a request carrying the key in x-api-key", async () => {
      const res = await request(buildApp())
        .get("/admin/ping")
        .set("x-api-key", KEY);

      expect(res.status).toBe(200);
      expect(res.body.data).toBe("pong");
    });

    it("allows a request carrying the key as a Bearer token", async () => {
      const res = await request(buildApp())
        .get("/admin/ping")
        .set("authorization", `Bearer ${KEY}`);

      expect(res.status).toBe(200);
    });

    it("prefers x-api-key when both headers are present", async () => {
      const res = await request(buildApp())
        .get("/admin/ping")
        .set("x-api-key", KEY)
        .set("authorization", "Bearer wrong-key");

      expect(res.status).toBe(200);
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
