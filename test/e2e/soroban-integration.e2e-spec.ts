/**
 * Soroban E2E integration suite (#684).
 *
 * Drives the real backend process against a local quickstart network with the
 * compiled escrow contract deployed (see global-setup.ts). Unlike the unit
 * suites under __tests__/, nothing here is mocked: build-tx, submit, the
 * indexer poller and the get_job simulation all hit real RPC and real SDK
 * shapes.
 *
 * Run with `npm run test:e2e`; see CONTRIBUTING.md for prerequisites.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { Api } from "@stellar/stellar-sdk/rpc";
import { STATE_FILE, rpcServer, waitFor, type E2EState } from "./soroban-network.js";

const PORT = Number(process.env.E2E_BACKEND_PORT ?? "3101");
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_API_KEY = "e2e-admin-key";

const MILESTONE_AMOUNTS = ["1000", "2500"];
const AUTO_RELEASE_DAYS = 7;

const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as E2EState;
const admin = Keypair.fromSecret(state.adminSecret);
const server = rpcServer(state.rpcUrl);

type ApiResult = { status: number; body: any };

async function api(
  method: "GET" | "POST",
  route: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResult> {
  const res = await fetch(`${BASE_URL}${route}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let backend: ChildProcess;
let backendLog = "";
let dataDir: string;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow-e2e-db-"));

  backend = spawn(process.execPath, ["--loader", "ts-node/esm", "src/index.ts"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      NODE_ENV: "development",
      TS_NODE_TRANSPILE_ONLY: "true",
      PORT: String(PORT),
      DB_PATH: path.join(dataDir, "escrow.db"),
      CONTRACT_ID: state.contractId,
      DEPLOYER_ADDRESS: admin.publicKey(),
      SOROBAN_RPC_URL: state.rpcUrl,
      SOROBAN_NETWORK_PASSPHRASE: state.networkPassphrase,
      ADMIN_API_KEY,
      // Index quickly, and never serve a stale empty by-wallet page.
      POLL_INTERVAL_MS: "1000",
      JOBS_BY_WALLET_CACHE_TTL_S: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  backend.stdout?.on("data", (chunk) => (backendLog += chunk));
  backend.stderr?.on("data", (chunk) => (backendLog += chunk));

  try {
    await waitFor(
      "backend /health",
      async () => ((await fetch(`${BASE_URL}/health`)).ok ? true : undefined),
      60_000,
    );
  } catch (err) {
    throw new Error(`${(err as Error).message}\n--- backend output ---\n${backendLog}`);
  }
});

afterAll(() => {
  backend?.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("Soroban quickstart E2E: draft → build-tx → sign → submit → index → read", () => {
  let unsignedXdr: string;
  let signedXdr: string;
  let txHash: string;

  it("POST /api/jobs/create-job-draft validates and echoes the draft", async () => {
    const { status, body } = await api("POST", "/api/jobs/create-job-draft", {
      client: state.client,
      freelancer: state.freelancer,
      arbiter: state.arbiter,
      token: state.tokenContractId,
      autoReleaseDays: AUTO_RELEASE_DAYS,
      milestones: MILESTONE_AMOUNTS.map((amount) => ({ amount })),
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      status: "draft",
      client: state.client,
      freelancer: state.freelancer,
      arbiter: state.arbiter,
      token: state.tokenContractId,
    });
  });

  it("POST /api/jobs/build-tx returns an initialize XDR in the data envelope", async () => {
    const specHashes = MILESTONE_AMOUNTS.map((_, i) =>
      createHash("sha256").update(`e2e milestone ${i}`).digest("hex"),
    );

    const { status, body } = await api("POST", "/api/jobs/build-tx", {
      contractId: state.contractId,
      method: "initialize",
      sourceAddress: admin.publicKey(),
      args: [
        { type: "address", value: admin.publicKey() },
        { type: "address", value: state.client },
        { type: "address", value: state.freelancer },
        { type: "address", value: state.arbiter },
        { type: "address", value: state.tokenContractId },
        { type: "u64", value: String(AUTO_RELEASE_DAYS * 86_400) },
        { type: "vec", value: MILESTONE_AMOUNTS.map((value) => ({ type: "i128", value })) },
        { type: "vec", value: specHashes.map((value) => ({ type: "bytes", value })) },
      ],
    });

    expect(status).toBe(200);
    expect(body).toEqual({ success: true, data: { xdr: expect.any(String) } });
    unsignedXdr = body.data.xdr;
  });

  it("signs the transaction XDR with the admin test keypair", () => {
    const tx = TransactionBuilder.fromXDR(unsignedXdr, state.networkPassphrase) as Transaction;
    expect(tx.source).toBe(admin.publicKey());
    tx.sign(admin);
    signedXdr = tx.toXDR();
    expect(tx.signatures).toHaveLength(1);
  });

  it("POST /api/jobs/submit relays the signed transaction", async () => {
    const { status, body } = await api("POST", "/api/jobs/submit", {
      signedXdr,
      sourceAddress: admin.publicKey(),
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).not.toBe("ERROR");
    expect(typeof body.data.hash).toBe("string");
    txHash = body.data.hash;
  });

  it("the transaction is applied on-chain", async () => {
    const result = await server.pollTransaction(txHash, { attempts: 60 });
    expect(result.status).toBe(Api.GetTransactionStatus.SUCCESS);
  });

  it("the poller indexes the initialization event and GET /by-wallet returns the job", async () => {
    const job = await waitFor(
      "indexer to surface the job for the client wallet",
      async () => {
        const { body } = await api("GET", `/api/jobs/by-wallet/${state.client}`);
        return body?.data?.jobs?.find(
          (j: { contract_id: string }) => j.contract_id === state.contractId,
        );
      },
      90_000,
      2_000,
    );

    expect(job).toMatchObject({ contract_id: state.contractId, role: "client" });

    const { status, body } = await api("GET", "/api/admin/indexer-status", undefined, {
      "x-api-key": ADMIN_API_KEY,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.totalEvents).toBeGreaterThan(0);
  });

  it("GET /api/jobs/:contractId returns the on-chain parties, milestones and state", async () => {
    const { status, body } = await api("GET", `/api/jobs/${state.contractId}`);

    expect(status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        id: state.contractId,
        client: state.client,
        freelancer: state.freelancer,
        arbiter: state.arbiter,
        token: state.tokenContractId,
        funded: false,
        milestones: MILESTONE_AMOUNTS.map((amount, index) => ({
          index,
          amount,
          status: "Pending",
        })),
      },
    });
  });
});
