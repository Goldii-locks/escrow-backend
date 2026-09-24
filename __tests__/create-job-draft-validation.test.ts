import request from "supertest";
import express from "express";
import { createJobDraftValidation } from "../src/middleware/create-job-draft-validation.js";

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

const VALID_LEGACY_BODY = {
  clientAddress: VALID_CLIENT,
  freelancerAddress: VALID_FREELANCER,
  arbiterAddress: VALID_ARBITER,
  tokenAddress: VALID_TOKEN,
  milestones: [{ amount: "10000000" }],
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post("/create-job-draft", createJobDraftValidation, (req, res) => {
    res.status(200).json({ success: true, data: req.body });
  });
  return app;
}

describe("createJobDraftValidation middleware – reusable Zod handler", () => {
  it("passes a valid modern-naming body through to the handler", async () => {
    const res = await request(buildApp())
      .post("/create-job-draft")
      .send(VALID_BODY)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.freelancer).toBe(VALID_FREELANCER);
  });

  it("passes a valid legacy *Address body through to the handler", async () => {
    const res = await request(buildApp())
      .post("/create-job-draft")
      .send(VALID_LEGACY_BODY)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.freelancerAddress).toBe(VALID_FREELANCER);
  });

  it("rejects a missing freelancer with a field validation error", async () => {
    const { freelancer: _f, ...rest } = VALID_BODY;
    const res = await request(buildApp())
      .post("/create-job-draft")
      .send(rest)
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "freelancer",
          message: expect.stringMatching(/freelancer/i),
        }),
      ]),
    );
  });

  it("rejects a malformed milestone amount as a field validation error", async () => {
    const res = await request(buildApp())
      .post("/create-job-draft")
      .send({ ...VALID_BODY, milestones: [{ amount: "not-a-number" }] })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "milestones",
          message: expect.stringMatching(/amount/i),
        }),
      ]),
    );
  });

  it("rejects an invalid token contract address in the modern variant", async () => {
    const res = await request(buildApp())
      .post("/create-job-draft")
      .send({ ...VALID_BODY, token: "not-a-contract-id" })
      .expect(400);

    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "token",
          message: expect.stringMatching(/contract address/i),
        }),
      ]),
    );
  });

  it("rejects an invalid arbiter address in the legacy variant", async () => {
    const res = await request(buildApp())
      .post("/create-job-draft")
      .send({ ...VALID_LEGACY_BODY, arbiterAddress: "GSHORT" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "arbiterAddress",
          message: expect.stringMatching(/valid Stellar account address/i),
        }),
      ]),
    );
  });

  it("rejects a missing tokenAddress in the legacy variant", async () => {
    const { tokenAddress: _t, ...rest } = VALID_LEGACY_BODY;
    const res = await request(buildApp())
      .post("/create-job-draft")
      .send(rest)
      .expect(400);

    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "tokenAddress",
          message: expect.stringMatching(/tokenAddress/i),
        }),
      ]),
    );
  });
});
