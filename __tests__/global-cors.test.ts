import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import request from "supertest";
import express from "express";
import { globalCors } from "../src/middleware/global-cors.js";
import webhookRoutes from "../src/routes/webhooks.js";

const ALLOWED = "https://milestonepay.app";
const DISALLOWED = "https://evil.example";

function buildApp() {
  const app = express();
  app.use(globalCors());
  app.use(express.json());
  app.use("/api/webhooks", webhookRoutes);
  return app;
}

describe("global CORS allowlist (#601)", () => {
  const original = process.env.ALLOWED_ORIGINS;

  beforeEach(() => {
    process.env.ALLOWED_ORIGINS = `${ALLOWED},http://localhost:3000`;
  });

  afterAll(() => {
    if (original === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = original;
  });

  it("does not send Access-Control-Allow-Origin to a disallowed origin on /api/webhooks/subscribe", async () => {
    const app = buildApp();

    const post = await request(app)
      .post("/api/webhooks/subscribe")
      .set("Origin", DISALLOWED)
      .send({});
    expect(post.headers["access-control-allow-origin"]).toBeUndefined();

    const preflight = await request(app)
      .options("/api/webhooks/subscribe")
      .set("Origin", DISALLOWED)
      .set("Access-Control-Request-Method", "POST");
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it.each([
    ["GET", "/api/jobs/CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH"],
    ["GET", "/api/jobs/by-wallet/GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX"],
    ["POST", "/api/jobs/build-tx"],
    ["POST", "/api/jobs/submit"],
    ["POST", "/api/v1/jobs/build-tx"],
    ["POST", "/api/webhooks/subscribe"],
  ])("allows a preflight from the frontend origin for %s %s", async (method, path) => {
    const res = await request(buildApp())
      .options(path)
      .set("Origin", ALLOWED)
      .set("Access-Control-Request-Method", method)
      .set("Access-Control-Request-Headers", "content-type,x-api-key");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("no source file mounts a bare cors() with no options", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        if (statSync(file).isDirectory()) walk(file);
        else if (file.endsWith(".ts") && /\bcors\(\s*\)/.test(readFileSync(file, "utf8"))) {
          offenders.push(file);
        }
      }
    };
    walk(join(process.cwd(), "src"));

    expect(offenders).toEqual([]);
  });
});
