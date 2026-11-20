import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import Database from "better-sqlite3";
import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";

// POST /api/jobs/sponsor (#966): fee-bump sponsorship of escrow calls.

const mockSendTransaction = jest.fn<(tx: unknown) => Promise<unknown>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    sendTransaction = mockSendTransaction;
  },
}));

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: router, resetSubmitCache, resetSponsorState, getSponsorBudgetSpent } =
  await import("../src/routes/jobs.js");
const { setDb, initSchema, registerContract, closeDb } = await import("../src/indexer/db.js");

const ESCROW = StrKey.encodeContract(Buffer.alloc(32, 1));
const FACTORY = StrKey.encodeContract(Buffer.alloc(32, 2));
const CHILD_ESCROW = StrKey.encodeContract(Buffer.alloc(32, 3));
const UNKNOWN_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 4));

const sponsor = Keypair.random();
const user = Keypair.random();

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", router);
  return app;
}

let sequence = 1;

/** A signed single-call transaction from `signer`; each call has a fresh sequence. */
function signedCall(
  contract: string,
  method: string,
  signer: Keypair = user,
  extraOps = 0,
): string {
  const account = new Account(signer.publicKey(), String(sequence++));
  const builder = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  });
  const op = Operation.invokeContractFunction({
    contract,
    function: method,
    args: [nativeToScVal(0, { type: "u32" })],
  });
  for (let i = 0; i <= extraOps; i++) builder.addOperation(op);
  const tx = builder.setTimeout(60).build();
  tx.sign(signer);
  return tx.toXDR();
}

const SPONSOR_ENV = [
  "SPONSOR_SECRET_KEY",
  "SPONSOR_MAX_FEE",
  "SPONSOR_DAILY_BUDGET_STROOPS",
  "SPONSOR_RATE_MAX",
  "SPONSOR_ACCOUNT_RATE_MAX",
  "CONTRACT_ID",
  "FACTORY_CONTRACT_ID",
];

beforeAll(() => {
  setDb(new Database(":memory:"));
  initSchema();
  registerContract(CHILD_ESCROW, "escrow_child");
});

afterAll(() => {
  closeDb();
});

beforeEach(() => {
  mockSendTransaction.mockReset();
  mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: "abc123" });
  resetSubmitCache();
  resetSponsorState();
  process.env.SPONSOR_SECRET_KEY = sponsor.secret();
  process.env.SPONSOR_RATE_MAX = "1000";
  process.env.SPONSOR_ACCOUNT_RATE_MAX = "1000";
  process.env.CONTRACT_ID = ESCROW;
  process.env.FACTORY_CONTRACT_ID = FACTORY;
});

afterEach(() => {
  for (const name of SPONSOR_ENV) delete process.env[name];
});

describe("POST /api/jobs/sponsor – allowed calls", () => {
  it("fee-bumps an allowlisted escrow call with the sponsor key and submits it", async () => {
    const signedXdr = signedCall(ESCROW, "mark_delivered");

    const res = await request(buildApp())
      .post("/api/jobs/sponsor")
      .send({ signedXdr })
      .expect(200);

    expect(res.body).toEqual({ success: true, data: { status: "PENDING", hash: "abc123" } });
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);

    const submitted = mockSendTransaction.mock.calls[0][0] as FeeBumpTransaction;
    expect(submitted).toBeInstanceOf(FeeBumpTransaction);
    expect(submitted.feeSource).toBe(sponsor.publicKey());
    expect(submitted.innerTransaction.source).toBe(user.publicKey());
    expect(submitted.innerTransaction.toXDR()).toBe(signedXdr);
    // Inner inclusion fee 100, no resource fee: 100 * (1 op + 1).
    expect(submitted.fee).toBe("200");
    expect(submitted.signatures).toHaveLength(1);
    expect(
      sponsor.verify(submitted.hash(), submitted.signatures[0].signature()),
    ).toBe(true);
    expect(getSponsorBudgetSpent(user.publicKey())).toBe(200n);
  });

  it("sponsors factory calls and indexer-monitored escrows", async () => {
    await request(buildApp())
      .post("/api/jobs/sponsor")
      .send({ signedXdr: signedCall(FACTORY, "create_escrow") })
      .expect(200);
    await request(buildApp())
      .post("/api/jobs/sponsor")
      .send({ signedXdr: signedCall(CHILD_ESCROW, "fund") })
      .expect(200);
    expect(mockSendTransaction).toHaveBeenCalledTimes(2);
  });

  it("does not charge the budget when the network rejects the transaction", async () => {
    mockSendTransaction.mockResolvedValue({ status: "ERROR", errorResult: "BAD_SEQ" });

    await request(buildApp())
      .post("/api/jobs/sponsor")
      .send({ signedXdr: signedCall(ESCROW, "fund") })
      .expect(422);
    expect(getSponsorBudgetSpent(user.publicKey())).toBe(0n);
  });
});

describe("POST /api/jobs/sponsor – rejected calls", () => {
  it("rejects a contract that is not a monitored escrow or the factory", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/sponsor")
      .send({ signedXdr: signedCall(UNKNOWN_CONTRACT, "fund") })
      .expect(403);

    expect(res.body).toEqual({
      success: false,
      error: "Contract is not eligible for fee sponsorship",
    });
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it("rejects a method outside the build-tx allowlist", async () => {
    const res = await request(buildApp())
      .post("/api/jobs/sponsor")
      .send({ signedXdr: signedCall(ESCROW, "transfer") })
      .expect(403);

    expect(res.body.error).toBe("Method transfer is not eligible for fee sponsorship");
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it("rejects multi-operation transactions", async () => {
    await request(buildApp())
      .post("/api/jobs/sponsor")
      .send({ signedXdr: signedCall(ESCROW, "fund", user, 1) })
      .expect(400);
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it("rejects non-invocation operations", async () => {
    const account = new Account(user.publicKey(), String(sequence++));
    const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.bumpSequence({ bumpTo: "100" }))
      .setTimeout(60)
      .build();
    tx.sign(user);

    const res = await request(buildApp())
      .post("/api/jobs/sponsor")
      .send({ signedXdr: tx.toXDR() })
      .expect(400);
    expect(res.body.error).toBe("Only contract invocations can be sponsored");
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it("rejects a fee-bump above SPONSOR_MAX_FEE", async () => {
    process.env.SPONSOR_MAX_FEE = "150";

    await request(buildApp())
      .post("/api/jobs/sponsor")
      .send({ signedXdr: signedCall(ESCROW, "fund") })
      .expect(422);
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });
});

describe("POST /api/jobs/sponsor – limits", () => {
  it("enforces the daily budget per source account", async () => {
    // Each sponsorship costs 200 stroops: two fit, the third does not.
    process.env.SPONSOR_DAILY_BUDGET_STROOPS = "400";

    for (let i = 0; i < 2; i++) {
      await request(buildApp())
        .post("/api/jobs/sponsor")
        .send({ signedXdr: signedCall(ESCROW, "fund") })
        .expect(200);
    }
    const res = await request(buildApp())
      .post("/api/jobs/sponsor")
      .send({ signedXdr: signedCall(ESCROW, "fund") })
      .expect(429);

    expect(res.body.error).toBe("Daily fee sponsorship budget exhausted for this account");
    expect(mockSendTransaction).toHaveBeenCalledTimes(2);
    expect(getSponsorBudgetSpent(user.publicKey())).toBe(400n);

    // Another account has its own budget.
    await request(buildApp())
      .post("/api/jobs/sponsor")
      .send({ signedXdr: signedCall(ESCROW, "fund", Keypair.random()) })
      .expect(200);
  });

  it("rate limits per source account", async () => {
    process.env.SPONSOR_ACCOUNT_RATE_MAX = "1";

    await request(buildApp())
      .post("/api/jobs/sponsor")
      .send({ signedXdr: signedCall(ESCROW, "fund") })
      .expect(200);
    await request(buildApp())
      .post("/api/jobs/sponsor")
      .send({ signedXdr: signedCall(ESCROW, "fund") })
      .expect(429);
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });

  it("rate limits per IP", async () => {
    process.env.SPONSOR_RATE_MAX = "1";

    await request(buildApp())
      .post("/api/jobs/sponsor")
      .send({ signedXdr: signedCall(ESCROW, "fund") })
      .expect(200);
    await request(buildApp())
      .post("/api/jobs/sponsor")
      .send({ signedXdr: signedCall(ESCROW, "fund", Keypair.random()) })
      .expect(429);
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/jobs/sponsor – disabled", () => {
  it("never sponsors when SPONSOR_SECRET_KEY is unset", async () => {
    delete process.env.SPONSOR_SECRET_KEY;

    const res = await request(buildApp())
      .post("/api/jobs/sponsor")
      .send({ signedXdr: signedCall(ESCROW, "fund") })
      .expect(404);

    expect(res.body).toEqual({ success: false, error: "Fee sponsorship is not enabled" });
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });
});
