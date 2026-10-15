import { jest } from "@jest/globals";
import request from "supertest";

const mockGetIndexerStatusData = jest.fn<() => unknown>();

const actualDb = await import("../src/indexer/db.js");

jest.unstable_mockModule("../src/indexer/db.js", () => ({
  ...actualDb,
  runMigrations: jest.fn(),
  getIndexerStatusData: mockGetIndexerStatusData,
}));

jest.unstable_mockModule("../src/indexer/poller.js", () => ({
  startPoller: jest.fn(),
}));

jest.unstable_mockModule("../src/indexer/status.js", () => ({
  markIndexerStarted: jest.fn(),
  getIndexerUptimeSeconds: jest.fn(() => 0),
}));

jest.unstable_mockModule("../src/middleware/adminAuth.js", () => ({
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

jest.unstable_mockModule("../src/middleware/rateLimiter.js", () => ({
  strictLimiter: (_req: any, _res: any, next: any) => next(),
  generalLimiter: (_req: any, _res: any, next: any) => next(),
  walletLookupLimiter: (_req: any, _res: any, next: any) => next(),
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { default: app } = await import("../src/index.js");
const { default: mockLogger } = await import("../src/utils/logger.js");

describe("Global error handler in src/index.ts (#603)", () => {
  beforeEach(() => {
    (mockLogger.info as ReturnType<typeof jest.fn>).mockClear();
    (mockLogger.warn as ReturnType<typeof jest.fn>).mockClear();
    (mockLogger.error as ReturnType<typeof jest.fn>).mockClear();
    (mockLogger.debug as ReturnType<typeof jest.fn>).mockClear();
    mockGetIndexerStatusData.mockReset();
  });

  it('returns 400 { success: false, error: "Malformed JSON body" } for truncated JSON on POST /api/jobs/build-tx and logs at warn', async () => {
    const res = await request(app)
      .post("/api/jobs/build-tx")
      .set("Content-Type", "application/json")
      .send('{"contractId":')
      .expect(400);

    expect(res.body).toEqual({
      success: false,
      error: "Malformed JSON body",
    });
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('returns 413 { success: false, error: "Payload too large" } for a 200kb body and logs at warn', async () => {
    const oversizedPayload = JSON.stringify({
      contractId: "C".repeat(200 * 1024),
    });

    const res = await request(app)
      .post("/api/jobs/build-tx")
      .set("Content-Type", "application/json")
      .send(oversizedPayload)
      .expect(413);

    expect(res.body).toEqual({
      success: false,
      error: "Payload too large",
    });
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("still returns 500 and logs at error when a route throws a genuine Error", async () => {
    process.env.ADMIN_API_KEY = "test-admin-key";
    mockGetIndexerStatusData.mockImplementation(() => {
      throw new Error("unexpected database failure");
    });

    const res = await request(app)
      .get("/api/admin/indexer-status")
      .set("x-admin-api-key", "test-admin-key")
      .expect(500);

    expect(res.body).toEqual({
      success: false,
      error: "Internal server error",
    });
    expect(JSON.stringify(res.body)).not.toContain("unexpected database failure");
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("does not treat a non-entity 4xx error as a body-parser error", async () => {
    process.env.ADMIN_API_KEY = "test-admin-key";
    mockGetIndexerStatusData.mockImplementation(() => {
      const customErr = Object.assign(new Error("upstream 400 error"), {
        status: 400,
        type: "custom.domain.error",
      });
      throw customErr;
    });

    const res = await request(app)
      .get("/api/admin/indexer-status")
      .set("x-admin-api-key", "test-admin-key")
      .expect(500);

    expect(res.body).toEqual({
      success: false,
      error: "Internal server error",
    });
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("supports statusCode when status is absent on an entity.* error", async () => {
    process.env.ADMIN_API_KEY = "test-admin-key";
    mockGetIndexerStatusData.mockImplementation(() => {
      const entityErr = Object.assign(new SyntaxError("bad json"), {
        statusCode: 400,
        type: "entity.parse.failed",
      });
      throw entityErr;
    });

    const res = await request(app)
      .get("/api/admin/indexer-status")
      .set("x-admin-api-key", "test-admin-key")
      .expect(400);

    expect(res.body).toEqual({
      success: false,
      error: "Malformed JSON body",
    });
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
