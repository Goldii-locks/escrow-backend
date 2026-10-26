import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";

const { default: jobRoutes } = await import("../src/routes/jobs.js");
const { requestIdMiddleware, requestLogger } = await import(
  "../src/middleware/request-id.js"
);
const { default: logger } = await import("../src/utils/logger.js");

const VALID_BODY = {
  client: "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
  freelancer: "GB5CRPXUGXZCG6BESL4CM4F3VUAGQGFNYNBHPBRJAGLXXSRYJSEGZHUV",
  arbiter: "GABNCQRZNTG6MMITD33VHFITKJZ5PSYW2XVEXMP52BSMTPLU7WORDQNT",
  token: "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH",
  autoReleaseDays: 7,
  milestones: [{ amount: "10000000" }],
};

function buildApp() {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use(requestLogger);
  app.use("/api/jobs", jobRoutes);
  return app;
}

describe("request IDs", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("echoes a valid supplied ID and shares it between handler and access logs", async () => {
    const info = jest.spyOn(logger, "info");
    const requestId = "proxy_request-123.test";

    const response = await request(buildApp())
      .post("/api/jobs/create-job-draft")
      .set("X-Request-Id", requestId)
      .send(VALID_BODY)
      .expect(200);

    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(info).toHaveBeenCalledWith(
      "Job draft created",
      expect.objectContaining({ traceId: requestId }),
    );
    expect(info).toHaveBeenCalledWith(
      "HTTP request",
      expect.objectContaining({ requestId }),
    );
  });

  it("replaces an invalid supplied ID with a generated UUID", async () => {
    const response = await request(buildApp())
      .get("/not-found")
      .set("X-Request-Id", "invalid:id")
      .expect(404);

    expect(response.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
