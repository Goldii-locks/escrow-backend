import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import {
  Account,
  Networks,
  TransactionBuilder,
  scValToNative,
  type Transaction,
} from "@stellar/stellar-sdk";
import { autoAuth } from "./helpers/api-key-helper.js";

/**
 * #678: on-chain amounts must arrive as decimal strings. JSON numbers lose
 * precision above 2^53 before validation ever sees them, so they are
 * rejected, and accepted strings must reach the XDR unchanged.
 */

const VALID_CONTRACT = "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";
const VALID_ADDRESS = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";
const ARBITER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const I128_MAX = "170141183460469231731687303715884105727";
const I128_MAX_PLUS_ONE = "170141183460469231731687303715884105728";
// Above 2^53: a JSON number here would already have been rounded.
const BIG_AMOUNT = "12345678901234567891";

const mockGetAccount = jest.fn<() => Promise<unknown>>();
// Return the built transaction itself so the response carries a real XDR.
const mockPrepareTransaction = jest.fn(async (tx: Transaction) => tx);

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getAccount = mockGetAccount;
    prepareTransaction = mockPrepareTransaction;
  },
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: router, resetBuildTxCache, resetPartialReleaseCache } = await import(
  "../src/routes/jobs.js"
);
const {
  resetBuildTxRateLimitBuckets,
  resetPartialReleaseRateLimitBuckets,
  resetCreateJobDraftRateLimitBuckets,
} = await import("../src/middleware/job-contract-rate-limit.js");

const app = express();
app.use(express.json());
app.use(autoAuth);
app.use("/api/jobs", router);

const PARTIAL_RELEASE = `/api/jobs/${VALID_CONTRACT}/milestones/0/partial-release`;

/** Decodes the contract-call arguments from a returned XDR as native values. */
function decodeInvokeArgs(envelope: string): unknown[] {
  const tx = TransactionBuilder.fromXDR(envelope, Networks.TESTNET) as Transaction;
  const op = tx.operations[0] as any;
  return op.func
    .invokeContract()
    .args()
    .map((arg: any) => scValToNative(arg));
}

beforeEach(() => {
  resetBuildTxRateLimitBuckets();
  resetPartialReleaseRateLimitBuckets();
  resetCreateJobDraftRateLimitBuckets();
  resetBuildTxCache();
  resetPartialReleaseCache();
  mockGetAccount.mockReset();
  mockPrepareTransaction.mockClear();
  mockGetAccount.mockImplementation(async () => new Account(VALID_ADDRESS, "1"));
});

describe("partial-release amount (#678)", () => {
  it.each([
    ["a small JSON number", 100],
    // Deliberately lossy: this is the precision loss the route must reject.
    // eslint-disable-next-line no-loss-of-precision
    ["a JSON number above 2^53", 12345678901234567891],
    ["a JSON float", 1.5],
  ])("rejects %s with 400", async (_label, amount) => {
    const res = await request(app)
      .post(PARTIAL_RELEASE)
      .send({ amount, sourceAddress: VALID_ADDRESS })
      .expect(400);
    expect(res.body.fields.amount).toBe("amount must be a string of digits");
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it.each([["0"], ["-1"], ["1e3"], [" 5"], ["0x10"], ["1.0"], [""]])(
    "rejects %j with 400",
    async (amount) => {
      const res = await request(app)
        .post(PARTIAL_RELEASE)
        .send({ amount, sourceAddress: VALID_ADDRESS })
        .expect(400);
      expect(res.body.fields.amount).toBe("amount must be a positive integer");
    },
  );

  it("rejects i128::MAX + 1 with 400", async () => {
    const res = await request(app)
      .post(PARTIAL_RELEASE)
      .send({ amount: I128_MAX_PLUS_ONE, sourceAddress: VALID_ADDRESS })
      .expect(400);
    expect(res.body.fields.amount).toMatch(/i128::MAX/);
  });

  it.each([["1"], [BIG_AMOUNT], [I128_MAX]])(
    "builds an XDR carrying exactly %s",
    async (amount) => {
      const res = await request(app)
        .post(PARTIAL_RELEASE)
        .send({ amount, sourceAddress: VALID_ADDRESS })
        .expect(200);

      const args = decodeInvokeArgs(res.body.data.xdr);
      // approve_partial(caller, index, amount)
      expect(args[1]).toBe(0);
      expect(args[2]).toBe(BigInt(amount));
    },
  );
});

describe("build-tx i128/u64 arguments (#678)", () => {
  const base = { contractId: VALID_CONTRACT, method: "fund", sourceAddress: VALID_ADDRESS };

  it("rejects an i128 argument sent as a JSON number", async () => {
    const res = await request(app)
      .post("/api/jobs/build-tx")
      .send({ ...base, args: [{ type: "i128", value: 1000 }] })
      .expect(400);
    expect(res.body.fields["args.0.value"]).toBe("amount must be a string of digits");
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it("rejects a u64 argument sent as a JSON number", async () => {
    const res = await request(app)
      .post("/api/jobs/build-tx")
      .send({ ...base, args: [{ type: "u64", value: 300 }] })
      .expect(400);
    expect(res.body.fields["args.0.value"]).toBe("u64 value must be a string of digits");
  });

  it("rejects an out-of-range i128 nested inside a vec", async () => {
    const res = await request(app)
      .post("/api/jobs/build-tx")
      .send({
        ...base,
        args: [{ type: "vec", value: [{ type: "i128", value: I128_MAX_PLUS_ONE }] }],
      })
      .expect(400);
    expect(res.body.fields["args.0.value.0.value"]).toMatch(/i128::MAX/);
  });

  it("rejects a zero i128 argument", async () => {
    await request(app)
      .post("/api/jobs/build-tx")
      .send({ ...base, args: [{ type: "i128", value: "0" }] })
      .expect(400);
  });

  it("rejects a u64 above u64::MAX", async () => {
    await request(app)
      .post("/api/jobs/build-tx")
      .send({ ...base, args: [{ type: "u64", value: "18446744073709551616" }] })
      .expect(400);
  });

  it("encodes decimal-string i128 and u64 arguments exactly", async () => {
    const res = await request(app)
      .post("/api/jobs/build-tx")
      .send({
        ...base,
        args: [
          { type: "i128", value: I128_MAX },
          { type: "u64", value: "18446744073709551615" },
          { type: "i128", value: BIG_AMOUNT },
        ],
      })
      .expect(200);

    expect(decodeInvokeArgs(res.body.data.xdr)).toEqual([
      BigInt(I128_MAX),
      18446744073709551615n,
      BigInt(BIG_AMOUNT),
    ]);
  });
});

describe("create-job-draft milestone amounts (#678)", () => {
  const draft = {
    freelancer: VALID_ADDRESS,
    arbiter: ARBITER,
    token: VALID_CONTRACT,
    autoReleaseDays: 7,
  };

  it("rejects a milestone amount sent as a JSON number", async () => {
    const res = await request(app)
      .post("/api/jobs/create-job-draft")
      .send({ ...draft, milestones: [{ amount: 10000000 }] })
      .expect(400);
    expect(res.body.details[0].message).toBe("amount must be a string of digits");
  });

  it("rejects a milestone amount above i128::MAX", async () => {
    const res = await request(app)
      .post("/api/jobs/create-job-draft")
      .send({ ...draft, milestones: [{ amount: I128_MAX_PLUS_ONE }] })
      .expect(400);
    expect(res.body.details[0].message).toMatch(/i128::MAX/);
  });

  it("accepts and echoes i128::MAX unchanged", async () => {
    const res = await request(app)
      .post("/api/jobs/create-job-draft")
      .send({ ...draft, milestones: [{ amount: I128_MAX }] })
      .expect(200);
    expect(JSON.stringify(res.body)).toContain(`"amount":"${I128_MAX}"`);
  });
});
