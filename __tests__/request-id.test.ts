import { jest } from "@jest/globals";
import http from "node:http";
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
  token: "CARZQMYKDGA4TTIE2XBDJ42EX27VYLLJGGG4WGUIXXWIVHPDTX3UCLJA",
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
    const httpLogs = (info.mock.calls as unknown as Array<[unknown, unknown]>)
      .filter(([message]) => message === "HTTP request");
    expect(httpLogs).toHaveLength(1);
  });

  it("logs an aborted request once at warn level with aborted: true", async () => {
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => logger);
    const info = jest.spyOn(logger, "info").mockImplementation(() => logger);
    let markClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    let markReceived: () => void = () => {};
    const received = new Promise<void>((resolve) => {
      markReceived = resolve;
    });

    const app = express();
    app.use(requestIdMiddleware);
    app.use(requestLogger);
    app.get("/hang", (_req, res) => {
      markReceived();
      res.on("close", () => markClosed());
    });

    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server port");

    const client = http.request({
      port: address.port,
      path: "/hang",
      method: "GET",
      headers: { connection: "close" },
    });
    client.on("error", () => {});
    client.end();
    await received;
    client.destroy();

    await closed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "HTTP request",
      expect.objectContaining({ aborted: true, url: "/hang" }),
    );
    expect(info).not.toHaveBeenCalled();
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
