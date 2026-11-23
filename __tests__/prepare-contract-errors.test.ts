import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";

const VALID_CONTRACT = "CARZQMYKDGA4TTIE2XBDJ42EX27VYLLJGGG4WGUIXXWIVHPDTX3UCLJA";
const VALID_ADDRESS = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";

const mockGetAccount = jest.fn<() => Promise<unknown>>();
const mockPrepareTransaction = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getAccount = mockGetAccount;
    prepareTransaction = mockPrepareTransaction;
  },
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: router, resetClaimAutoReleaseCache, resetBuildTxCache, resetPartialReleaseCache } =
  await import("../src/routes/jobs.js");
const { default: mockLogger } = await import("../src/utils/logger.js");
const rateLimits = await import("../src/middleware/job-contract-rate-limit.js");

const MOCK_ACCOUNT = {
  accountId: () => VALID_ADDRESS,
  sequenceNumber: () => "1",
  incrementSequenceNumber: () => {},
};
const PREPARED = { toXDR: () => "AAAAAQ==", hash: () => Buffer.alloc(32, 0xaa), fee: "100" };

const app = express();
app.use(express.json());
app.use("/api/jobs", router);

const CLAIM = `/api/jobs/${VALID_CONTRACT}/milestones/0/claim-auto-release`;
const PARTIAL = `/api/jobs/${VALID_CONTRACT}/milestones/0/partial-release`;
const BUILD = "/api/jobs/build-tx";
const BUILD_BODY = { contractId: VALID_CONTRACT, method: "approve_milestone", args: [], sourceAddress: VALID_ADDRESS };

const spy = (fn: unknown) => fn as ReturnType<typeof jest.fn>;

beforeEach(() => {
  delete process.env.API_KEY;
  resetClaimAutoReleaseCache();
  resetBuildTxCache();
  resetPartialReleaseCache();
  rateLimits.resetClaimAutoReleaseRateLimitBuckets();
  rateLimits.resetBuildTxRateLimitBuckets();
  rateLimits.resetPartialReleaseRateLimitBuckets();
  mockGetAccount.mockReset().mockResolvedValue(MOCK_ACCOUNT);
  mockPrepareTransaction.mockReset();
  for (const f of [mockLogger.info, mockLogger.warn, mockLogger.error, mockLogger.debug]) spy(f).mockClear();
});

const contractRejection = () => new Error("HostError: simulation failed: contract error #11");

describe.each([
  ["claim-auto-release", CLAIM, { sourceAddress: VALID_ADDRESS }],
  ["build-tx", BUILD, BUILD_BODY],
])("%s – contract rejections during simulation (#877)", (_name, url, body) => {
  it("returns the 4xx classifySimError maps a contract error to, not 500", async () => {
    mockPrepareTransaction.mockRejectedValue(contractRejection());

    const res = await request(app).post(url).send(body);

    expect(res.status).toBe(422);
    expect(res.body.error ?? res.body.message).toContain("Contract execution reverted (error code 11)");
  });

  it("logs the rejection at warn, not error", async () => {
    mockPrepareTransaction.mockRejectedValue(contractRejection());

    await request(app).post(url).send(body);

    expect(spy(mockLogger.warn).mock.calls.length).toBeGreaterThan(0);
    expect(spy(mockLogger.error)).not.toHaveBeenCalled();
  });

  it("still answers a network error with 500 and logs it at error", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("network down"));

    const res = await request(app).post(url).send(body);

    expect(res.status).toBe(500);
    expect(spy(mockLogger.error)).toHaveBeenCalled();
  });

  it("does not cache a rejected build, so a retry reaches the contract again", async () => {
    mockPrepareTransaction.mockRejectedValueOnce(contractRejection()).mockResolvedValueOnce(PREPARED);

    const first = await request(app).post(url).send(body);
    const second = await request(app).post(url).send(body);

    expect(first.status).toBe(422);
    expect(second.status).toBe(200);
  });
});

describe("partial-release – contract rejections keep their mapped status", () => {
  it("returns the mapped 4xx and logs at warn", async () => {
    mockPrepareTransaction.mockRejectedValue(contractRejection());

    const res = await request(app).post(PARTIAL).send({ amount: "100", sourceAddress: VALID_ADDRESS });

    expect(res.status).toBe(422);
    expect(spy(mockLogger.error)).not.toHaveBeenCalled();
  });
});

describe("partial-release – getAccount runs only after the cache check (#878)", () => {
  const body = { amount: "100", sourceAddress: VALID_ADDRESS };

  it("two identical requests within the TTL cause exactly one getAccount call", async () => {
    mockPrepareTransaction.mockResolvedValue(PREPARED);

    await request(app).post(PARTIAL).send(body).expect(200);
    await request(app).post(PARTIAL).send(body).expect(200);

    expect(mockGetAccount).toHaveBeenCalledTimes(1);
    expect(mockPrepareTransaction).toHaveBeenCalledTimes(1);
  });

  it("concurrent identical requests share one getAccount call", async () => {
    mockPrepareTransaction.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(PREPARED), 20)),
    );

    const [a, b] = await Promise.all([
      request(app).post(PARTIAL).send(body),
      request(app).post(PARTIAL).send(body),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(mockGetAccount).toHaveBeenCalledTimes(1);
  });

  it("serves cached requests even when the RPC account lookup now fails", async () => {
    mockPrepareTransaction.mockResolvedValue(PREPARED);
    await request(app).post(PARTIAL).send(body).expect(200);

    mockGetAccount.mockRejectedValue(new Error("rate limited"));
    await request(app).post(PARTIAL).send(body).expect(200);
  });

  it("keeps the 404 mapping when the source account is missing", async () => {
    mockGetAccount.mockRejectedValue(new Error("Account not found: GAODBH..."));

    const res = await request(app).post(PARTIAL).send(body);

    expect(res.status).toBe(404);
    expect(mockPrepareTransaction).not.toHaveBeenCalled();
  });
});
