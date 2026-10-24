import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { createHash } from "crypto";

/**
 * #680: validation failures must never write request bodies or signed XDRs
 * to the logs, only their shape (keys, byte size, Zod issue paths) and an
 * XDR fingerprint (length + SHA-256 prefix).
 */

const VALID_CONTRACT = "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";
const VALID_ADDRESS = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";
const SECRET = "SBSECRETSEEDTHATMUSTNEVERAPPEARINLOGS0000000000000000000";
// Valid-looking base64 envelope; the trailing whitespace makes it invalid.
const SIGNED_XDR = "AAAAAgAAAABzdXBlcnNlY3JldHNpZ25lZGVudmVsb3Bl";

const mockSendTransaction = jest.fn<() => Promise<unknown>>();
const mockFromXDR = jest.fn<() => unknown>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    sendTransaction = mockSendTransaction;
  },
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: router } = await import("../src/routes/jobs.js");
const { default: logger } = await import("../src/utils/logger.js");
const {
  resetSubmitRateLimitBuckets,
  resetBuildTxRateLimitBuckets,
  resetPartialReleaseRateLimitBuckets,
  resetCreateJobDraftRateLimitBuckets,
  resetClaimAutoReleaseRateLimitBuckets,
  resetWhitelistUpdateRateLimitBuckets,
} = await import("../src/middleware/job-contract-rate-limit.js");
const { describeRejectedBody, xdrLogMeta } = await import("../src/utils/log-redaction.js");

const app = express();
app.use(express.json());
app.use("/api/jobs", router);

const loggerFns = () =>
  [logger.info, logger.warn, logger.error, logger.debug] as unknown as ReturnType<typeof jest.fn>[];

/** Everything logged so far, serialised. */
function allLogOutput(): string {
  return JSON.stringify(loggerFns().flatMap((fn) => fn.mock.calls));
}

function warnMeta(message: string): Record<string, unknown> {
  const call = (logger.warn as unknown as ReturnType<typeof jest.fn>).mock.calls.find(
    ([m]) => m === message,
  );
  expect(call).toBeDefined();
  return call![1] as Record<string, unknown>;
}

beforeEach(() => {
  for (const fn of loggerFns()) fn.mockClear();
  resetSubmitRateLimitBuckets();
  resetBuildTxRateLimitBuckets();
  resetPartialReleaseRateLimitBuckets();
  resetCreateJobDraftRateLimitBuckets();
  resetClaimAutoReleaseRateLimitBuckets();
  resetWhitelistUpdateRateLimitBuckets();
  mockSendTransaction.mockReset();
  mockFromXDR.mockReset();
});

describe("submit validation logging (#680)", () => {
  it("never logs the signed XDR or the raw body of a rejected submission", async () => {
    const badXdr = `${SIGNED_XDR} `;
    await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: badXdr, sourceAddress: "not-an-address", note: SECRET })
      .expect(400);

    const output = allLogOutput();
    expect(output).not.toContain(SIGNED_XDR);
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain("not-an-address");

    const meta = warnMeta("Invalid submit request body");
    expect(meta).not.toHaveProperty("body");
    expect(meta.bodyKeys).toEqual(["signedXdr", "sourceAddress", "note"]);
    expect(meta.bodyBytes).toBeGreaterThan(0);
    expect(meta.issuePaths).toEqual(expect.arrayContaining(["signedXdr", "sourceAddress"]));
    expect(meta.xdrLength).toBe(badXdr.length);
    expect(meta.xdrSha256Prefix).toBe(
      createHash("sha256").update(badXdr).digest("hex").slice(0, 12),
    );
  });

  it("logs only an XDR fingerprint for an accepted submission", async () => {
    mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: "abc" });

    await request(app).post("/api/jobs/submit").send({ signedXdr: SIGNED_XDR });

    expect(allLogOutput()).not.toContain(SIGNED_XDR);
  });
});

describe.each([
  {
    name: "build-tx",
    path: "/api/jobs/build-tx",
    message: "Invalid build-tx request body",
    body: { contractId: VALID_CONTRACT, method: "transfer", sourceAddress: VALID_ADDRESS, secret: SECRET },
  },
  {
    name: "partial-release",
    path: `/api/jobs/${VALID_CONTRACT}/milestones/0/partial-release`,
    message: "Invalid body for partial-release",
    body: { amount: "-1", sourceAddress: VALID_ADDRESS, secret: SECRET },
  },
  {
    name: "claim-auto-release",
    path: `/api/jobs/${VALID_CONTRACT}/milestones/0/claim-auto-release`,
    message: "Invalid body for claim-auto-release",
    body: { sourceAddress: VALID_ADDRESS, secret: SECRET },
  },
  {
    name: "create-job-draft",
    path: "/api/jobs/create-job-draft",
    message: "Invalid create-job-draft request body",
    body: { freelancer: VALID_ADDRESS, milestones: [], secret: SECRET },
  },
  {
    name: "whitelist update",
    path: `/api/jobs/${VALID_CONTRACT}/whitelist/update`,
    message: "Invalid body provided for whitelist update",
    body: { token: "bad", action: "add", adminAddress: VALID_ADDRESS, secret: SECRET },
  },
])("$name validation logging (#680)", ({ path, message, body }) => {
  it("logs body keys, byte size and issue paths but no values", async () => {
    const res = await request(app).post(path).send(body);
    expect(res.status).toBe(400);

    const output = allLogOutput();
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(VALID_ADDRESS);

    const meta = warnMeta(message);
    expect(meta).not.toHaveProperty("body");
    expect(meta.bodyKeys).toEqual(Object.keys(body));
    expect(meta.bodyBytes).toBe(Buffer.byteLength(JSON.stringify(body)));
    expect(Array.isArray(meta.issuePaths)).toBe(true);
    expect((meta.issuePaths as string[]).length).toBeGreaterThan(0);
  });
});

describe("log-redaction helpers", () => {
  it("describes a body by shape only", () => {
    expect(describeRejectedBody({ a: 1, b: "secret" })).toEqual({
      bodyKeys: ["a", "b"],
      bodyBytes: Buffer.byteLength('{"a":1,"b":"secret"}'),
      issuePaths: [],
    });
    expect(describeRejectedBody(undefined)).toEqual({ bodyKeys: [], bodyBytes: 0, issuePaths: [] });
  });

  it("fingerprints an XDR without including it", () => {
    const meta = xdrLogMeta(SIGNED_XDR);
    expect(meta.xdrLength).toBe(SIGNED_XDR.length);
    expect(meta.xdrSha256Prefix).toHaveLength(12);
    expect(JSON.stringify(meta)).not.toContain(SIGNED_XDR);
    expect(xdrLogMeta(42)).toEqual({});
  });
});
