import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

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

const { default: router, resetBuildTxCache } = await import("../src/routes/jobs.js");
const { resetBuildTxRateLimitBuckets } = await import(
  "../src/middleware/job-contract-rate-limit.js"
);

const app = express();
app.use(express.json());
app.use("/api/jobs", router);

const VALID_BODY = {
  contractId: "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH",
  method: "fund",
  args: [],
  sourceAddress: "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
};

describe("POST /api/jobs/build-tx — response metadata (#962)", () => {
  beforeEach(() => {
    resetBuildTxRateLimitBuckets();
    resetBuildTxCache();
    mockGetAccount.mockReset();
    mockPrepareTransaction.mockReset();
  });

  it("returns hash matching the XDR and validUntil matching the tx time bounds", async () => {
    const source = Keypair.random().publicKey();
    const account = new Account(source, "1");
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "1",
        }),
      )
      .setTimeout(180)
      .build();

    mockGetAccount.mockResolvedValue({
      accountId: () => source,
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    });
    mockPrepareTransaction.mockResolvedValue({
      toXDR: () => tx.toXDR(),
      hash: () => tx.hash(),
      fee: "250",
    });

    const res = await request(app).post("/api/jobs/build-tx").send({
      ...VALID_BODY,
      sourceAddress: source,
    }).expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.xdr).toBe(tx.toXDR());
    expect(res.body.data.hash).toBe(
      TransactionBuilder.fromXDR(tx.toXDR(), Networks.TESTNET).hash().toString("hex"),
    );
    expect(res.body.data.validUntil).toBe(Number(tx.timeBounds?.maxTime));
    expect(res.body.data.fee).toEqual({
      total: "250",
      inclusion: "100",
      resource: "150",
    });
  });
});
