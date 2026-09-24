import request from "supertest";
import express from "express";
import router from "../src/routes/jobs.js";
import { resetCreateJobDraftRateLimitBuckets } from "../src/middleware/job-contract-rate-limit.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A single verified-valid Stellar G-address reused for all role fields.
// The schema validates format only; it does not enforce uniqueness between roles.
const VALID_G_ADDRESS =
  "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";

/** A valid create-job-draft payload. */
const validDraftBody = () => ({
  clientAddress: VALID_G_ADDRESS,
  freelancerAddress: VALID_G_ADDRESS,
  arbiterAddress: VALID_G_ADDRESS,
  tokenAddress: "CDMLFMKMMD7MWZP3FKUBZPVHTUEDLSX4BYGYKH4GCESYXKKNDHQ",
  milestones: [{ amount: "500000000" }],
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", router);
  return app;
}

// ---------------------------------------------------------------------------
// Rate-limit tests
// ---------------------------------------------------------------------------

describe("POST /api/jobs/create-job-draft – rate limiting", () => {
  const originalMax = process.env.CREATE_JOB_DRAFT_RATE_MAX;
  const originalWindow = process.env.CREATE_JOB_DRAFT_RATE_WINDOW_MS;

  beforeEach(() => {
    resetCreateJobDraftRateLimitBuckets();
    process.env.CREATE_JOB_DRAFT_RATE_MAX = "3";
    process.env.CREATE_JOB_DRAFT_RATE_WINDOW_MS = "60000";
  });

  afterEach(() => {
    resetCreateJobDraftRateLimitBuckets();
    if (originalMax === undefined) {
      delete process.env.CREATE_JOB_DRAFT_RATE_MAX;
    } else {
      process.env.CREATE_JOB_DRAFT_RATE_MAX = originalMax;
    }
    if (originalWindow === undefined) {
      delete process.env.CREATE_JOB_DRAFT_RATE_WINDOW_MS;
    } else {
      process.env.CREATE_JOB_DRAFT_RATE_WINDOW_MS = originalWindow;
    }
  });

  it("allows requests up to the configured threshold and sets rate-limit headers", async () => {
    const app = buildApp();
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post("/api/jobs/create-job-draft")
        .send(validDraftBody());
      expect(res.status).not.toBe(429);
      expect(res.headers["x-ratelimit-limit"]).toBe("3");
    }
  });

  it("returns 429 once the threshold is exceeded", async () => {
    const app = buildApp();
    for (let i = 0; i < 3; i++) {
      await request(app).post("/api/jobs/create-job-draft").send(validDraftBody());
    }

    const res = await request(app)
      .post("/api/jobs/create-job-draft")
      .send(validDraftBody())
      .expect(429);

    expect(res.body).toEqual({
      success: false,
      error: "Too many requests, please try again later",
    });
  });

  it("sets x-ratelimit-remaining to 0 on the 429 response", async () => {
    const app = buildApp();
    for (let i = 0; i < 3; i++) {
      await request(app).post("/api/jobs/create-job-draft").send(validDraftBody());
    }

    const res = await request(app)
      .post("/api/jobs/create-job-draft")
      .send(validDraftBody())
      .expect(429);

    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
  });

  it("sets x-ratelimit-reset header on rate-limited response", async () => {
    const app = buildApp();
    for (let i = 0; i < 3; i++) {
      await request(app).post("/api/jobs/create-job-draft").send(validDraftBody());
    }

    const res = await request(app)
      .post("/api/jobs/create-job-draft")
      .send(validDraftBody())
      .expect(429);

    expect(res.headers["x-ratelimit-reset"]).toBeDefined();
    expect(Number(res.headers["x-ratelimit-reset"])).toBeGreaterThan(0);
  });

  it("rate-limit counter decrements x-ratelimit-remaining with each request", async () => {
    const app = buildApp();

    const first = await request(app)
      .post("/api/jobs/create-job-draft")
      .send(validDraftBody());
    expect(first.headers["x-ratelimit-remaining"]).toBe("2");

    const second = await request(app)
      .post("/api/jobs/create-job-draft")
      .send(validDraftBody());
    expect(second.headers["x-ratelimit-remaining"]).toBe("1");

    const third = await request(app)
      .post("/api/jobs/create-job-draft")
      .send(validDraftBody());
    expect(third.headers["x-ratelimit-remaining"]).toBe("0");
  });

  it("does not rate-limit unrelated routes", async () => {
    process.env.CREATE_JOB_DRAFT_RATE_MAX = "1";
    const app = buildApp();

    // Exhaust the create-job-draft limit
    await request(app).post("/api/jobs/create-job-draft").send(validDraftBody());
    const blocked = await request(app)
      .post("/api/jobs/create-job-draft")
      .send(validDraftBody());
    expect(blocked.status).toBe(429);

    // Unrelated route must not be affected
    const byWallet = await request(app).get("/api/jobs/by-wallet/GTESTWALLET");
    expect(byWallet.status).not.toBe(429);
  });

  it("resets the bucket after window expiry", async () => {
    process.env.CREATE_JOB_DRAFT_RATE_MAX = "1";
    // Use a 1 ms window so it expires immediately
    process.env.CREATE_JOB_DRAFT_RATE_WINDOW_MS = "1";
    const app = buildApp();

    // First request consumes the only slot
    await request(app).post("/api/jobs/create-job-draft").send(validDraftBody());

    // Wait for the window to expire
    await new Promise((resolve) => setTimeout(resolve, 10));

    // After the window the bucket should reset; request should succeed
    const res = await request(app)
      .post("/api/jobs/create-job-draft")
      .send(validDraftBody());
    expect(res.status).not.toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Successful response shape
// ---------------------------------------------------------------------------

describe("POST /api/jobs/create-job-draft – successful response", () => {
  beforeEach(() => {
    resetCreateJobDraftRateLimitBuckets();
    process.env.CREATE_JOB_DRAFT_RATE_MAX = "100";
  });

  afterEach(() => {
    resetCreateJobDraftRateLimitBuckets();
    delete process.env.CREATE_JOB_DRAFT_RATE_MAX;
  });

  it("returns 200 with the draft payload echoed back", async () => {
    const app = buildApp();
    const body = validDraftBody();

    const res = await request(app)
      .post("/api/jobs/create-job-draft")
      .send(body)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.draft).toMatchObject({
      clientAddress: body.clientAddress,
      freelancerAddress: body.freelancerAddress,
      arbiterAddress: body.arbiterAddress,
      tokenAddress: body.tokenAddress,
    });
    expect(res.body.data.draft.milestones).toHaveLength(1);
  });

  it("accepts multiple milestones", async () => {
    const app = buildApp();
    const body = {
      ...validDraftBody(),
      milestones: [{ amount: "100000000" }, { amount: "200000000" }, { amount: "300000000" }],
    };

    const res = await request(app)
      .post("/api/jobs/create-job-draft")
      .send(body)
      .expect(200);

    expect(res.body.data.draft.milestones).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Validation rejection tests
// ---------------------------------------------------------------------------

describe("POST /api/jobs/create-job-draft – validation", () => {
  beforeEach(() => {
    resetCreateJobDraftRateLimitBuckets();
    process.env.CREATE_JOB_DRAFT_RATE_MAX = "100";
  });

  afterEach(() => {
    resetCreateJobDraftRateLimitBuckets();
    delete process.env.CREATE_JOB_DRAFT_RATE_MAX;
  });

  it("returns 400 when clientAddress is missing", async () => {
    const { clientAddress: _omit, ...body } = validDraftBody();
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .send(body)
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 when clientAddress is not a valid Stellar address", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .send({ ...validDraftBody(), clientAddress: "NOT_VALID" })
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 when milestones array is empty", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .send({ ...validDraftBody(), milestones: [] })
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 when milestones is missing", async () => {
    const { milestones: _omit, ...body } = validDraftBody();
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .send(body)
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 when a milestone amount is zero", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .send({ ...validDraftBody(), milestones: [{ amount: "0" }] })
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 when tokenAddress is missing", async () => {
    const { tokenAddress: _omit, ...body } = validDraftBody();
    const res = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .send(body)
      .expect(400);
    expect(res.body.success).toBe(false);
  });
});
