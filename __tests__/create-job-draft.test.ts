import request from "supertest";
import express from "express";

const VALID_CLIENT =
  "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";
const VALID_FREELANCER =
  "GB5CRPXUGXZCG6BESL4CM4F3VUAGQGFNYNBHPBRJAGLXXSRYJSEGZHUV";
const VALID_ARBITER =
  "GABNCQRZNTG6MMITD33VHFITKJZ5PSYW2XVEXMP52BSMTPLU7WORDQNT";
const VALID_TOKEN =
  "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";

const VALID_BODY = {
  client: VALID_CLIENT,
  freelancer: VALID_FREELANCER,
  arbiter: VALID_ARBITER,
  token: VALID_TOKEN,
  autoReleaseDays: 7,
  milestones: [{ amount: "10000000" }],
};

const { default: router } = await import("../src/routes/jobs.js");
const { resetCreateJobDraftRateLimitBuckets } = await import(
  "../src/middleware/job-contract-rate-limit.js"
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", router);
  return app;
}

describe("POST /api/jobs/create-job-draft – schema validation", () => {
  beforeEach(() => {
    resetCreateJobDraftRateLimitBuckets();
  });

  it("returns 200 with a draft payload for a valid body", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .send(VALID_BODY)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      status: "draft",
      freelancer: VALID_FREELANCER,
      arbiter: VALID_ARBITER,
      token: VALID_TOKEN,
      autoReleaseDays: 7,
      milestones: [{ amount: "10000000" }],
    });
    expect(typeof res.body.data.id).toBe("string");
    expect(typeof res.body.data.createdAt).toBe("string");
  });

  it("returns 400 when body is missing required freelancer", async () => {
    const { freelancer: _f, ...rest } = VALID_BODY;
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .send(rest)
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/freelancer/i);
  });

  it("returns 400 when milestones is not an array", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .send({ ...VALID_BODY, milestones: "not-an-array" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/milestones/i);
  });

  it("returns 400 when milestones is an empty array", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .send({ ...VALID_BODY, milestones: [] })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/milestones/i);
  });

  it("returns 400 when autoReleaseDays has an invalid type", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .send({ ...VALID_BODY, autoReleaseDays: { days: 7 } })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/autoReleaseDays/i);
  });

  it("returns 400 when autoReleaseDays is out of range", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .send({ ...VALID_BODY, autoReleaseDays: 0 })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/autoReleaseDays/i);
  });

  it("returns 400 when milestone amount is not a positive integer", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .send({ ...VALID_BODY, milestones: [{ amount: "-5" }] })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/amount/i);
  });

  it("error body has ValidationError format on schema failure", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .send({})
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(Array.isArray(res.body.details)).toBe(true);
  });
});

describe("POST /api/jobs/create-job-draft – Stellar address validation", () => {
  beforeEach(() => {
    resetCreateJobDraftRateLimitBuckets();
  });

  it("returns 400 for an invalid freelancer address", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .send({ ...VALID_BODY, freelancer: "not-a-stellar-key" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/freelancer/i);
    expect(res.body.details[0].message).toMatch(/valid Stellar account address/i);
  });

  it("returns 400 for an invalid arbiter address", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .send({ ...VALID_BODY, arbiter: "GSHORT" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/arbiter/i);
    expect(res.body.details[0].message).toMatch(/valid Stellar account address/i);
  });

  it("returns 400 when freelancer is a contract address (C…)", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .send({ ...VALID_BODY, freelancer: VALID_TOKEN })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/freelancer/i);
  });

  it("returns 400 for an invalid token contract address", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .send({ ...VALID_BODY, token: VALID_CLIENT })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/token/i);
    expect(res.body.details[0].message).toMatch(/valid Stellar contract address/i);
  });

  it("returns 400 for an invalid optional client address", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .send({ ...VALID_BODY, client: "bad-client" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details[0].message).toMatch(/client/i);
  });

  it("accepts a body without client when other addresses are valid", async () => {
    const { client: _c, ...rest } = VALID_BODY;
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .send(rest)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.freelancer).toBe(VALID_FREELANCER);
  });
});

describe("POST /api/jobs/create-job-draft – CORS and security headers", () => {
  beforeEach(() => {
    resetCreateJobDraftRateLimitBuckets();
  });

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
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .set("Origin", "https://evil.example.com")
      .send(VALID_BODY)
      .expect(403);

    expect(res.body).toEqual({
      success: false,
      error: "Origin not allowed by CORS policy",
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows trusted origins and sets CORS response headers", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .set("Origin", "https://trusted.example.com")
      .send(VALID_BODY)
      .expect(200);

    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://trusted.example.com",
    );
    expect(res.headers.vary).toContain("Origin");
    expect(res.headers["access-control-allow-methods"]).toMatch(/POST/i);
  });

  it("rejects unauthorized OPTIONS preflight with 403", async () => {
    const res = await request(buildApp())
      .options("/api/jobs/create-job-draft")
      .set("Origin", "https://evil.example.com")
      .expect(403);

    expect(res.body).toEqual({
      success: false,
      error: "Origin not allowed by CORS policy",
    });
  });

  it("allows trusted OPTIONS preflight with 204", async () => {
    const res = await request(buildApp())
      .options("/api/jobs/create-job-draft")
      .set("Origin", "https://trusted.example.com")
      .expect(204);

    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://trusted.example.com",
    );
    expect(res.headers["access-control-allow-methods"]).toMatch(/POST/i);
  });

  it("applies security headers on create-job-draft responses", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .send(VALID_BODY)
      .expect(200);

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'");
    expect(res.headers["permissions-policy"]).toContain("camera=()");
  });

  it("still rejects unauthorized origins before schema validation", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .set("Origin", "https://evil.example.com")
      .send({})
      .expect(403);

    expect(res.body.error).toBe("Origin not allowed by CORS policy");
  });
});
