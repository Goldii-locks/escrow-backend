/**
 * Local Stellar/Soroban network helpers for the opt-in E2E suite (#684).
 *
 * Everything here talks to a `stellar/quickstart --local --enable-soroban-rpc`
 * container. Contract deployment goes through the JS SDK rather than
 * stellar-cli, so the only host prerequisites are Docker and a compiled
 * escrow Wasm.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
  type xdr,
} from "@stellar/stellar-sdk";
import { Server, Api } from "@stellar/stellar-sdk/rpc";

export interface E2EConfig {
  rpcUrl: string;
  friendbotUrl: string;
  networkPassphrase: string;
  wasmPath: string;
  containerName: string;
  image: string;
  keepNetwork: boolean;
}

/** Everything global-setup hands to the spec, persisted as JSON. */
export interface E2EState {
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string;
  tokenContractId: string;
  adminSecret: string;
  client: string;
  freelancer: string;
  arbiter: string;
  /** True when global-setup started the container and teardown owns it. */
  startedContainer: boolean;
  containerName: string;
}

export const STATE_FILE = path.join(os.tmpdir(), "escrow-backend-e2e-state.json");

export function loadConfig(): E2EConfig {
  return {
    rpcUrl: process.env.E2E_RPC_URL ?? "http://localhost:8000/soroban/rpc",
    friendbotUrl: process.env.E2E_FRIENDBOT_URL ?? "http://localhost:8000/friendbot",
    networkPassphrase: process.env.E2E_NETWORK_PASSPHRASE ?? Networks.STANDALONE,
    wasmPath: path.resolve(
      process.env.ESCROW_WASM_PATH ??
        "../escrow-contract/target/wasm32v1-none/release/milestone_escrow.wasm",
    ),
    containerName: process.env.E2E_DOCKER_CONTAINER ?? "escrow-backend-e2e-quickstart",
    image: process.env.E2E_QUICKSTART_IMAGE ?? "stellar/quickstart:latest",
    keepNetwork: process.env.E2E_KEEP_NETWORK === "1",
  };
}

export function rpcServer(rpcUrl: string): Server {
  return new Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `check` until it returns a value, or throw after `timeoutMs`. */
export async function waitFor<T>(
  description: string,
  check: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}${detail}`);
}

async function rpcIsHealthy(server: Server): Promise<boolean> {
  try {
    const health = await server.getHealth();
    return health.status === "healthy";
  } catch {
    return false;
  }
}

/**
 * Reuse a quickstart that is already answering on `rpcUrl`; otherwise start
 * one in Docker. Returns whether this call started the container.
 */
export async function ensureQuickstart(config: E2EConfig): Promise<boolean> {
  const server = rpcServer(config.rpcUrl);
  if (await rpcIsHealthy(server)) return false;

  const running = execFileSync(
    "docker",
    ["ps", "--filter", `name=^${config.containerName}$`, "--format", "{{.Names}}"],
    { encoding: "utf8" },
  ).trim();

  let started = false;
  if (!running) {
    execFileSync(
      "docker",
      [
        "run", "-d", "--rm",
        "--name", config.containerName,
        "-p", "8000:8000",
        config.image,
        "--local",
        "--enable-soroban-rpc",
      ],
      { stdio: "inherit" },
    );
    started = true;
  }

  // Quickstart has to bring up core, horizon, RPC and friendbot; a cold start
  // takes a minute or two.
  await waitFor(
    "Soroban RPC to report healthy",
    async () => ((await rpcIsHealthy(server)) ? true : undefined),
    300_000,
    2_000,
  );
  return started;
}

export function stopQuickstart(containerName: string): void {
  execFileSync("docker", ["stop", containerName], { stdio: "inherit" });
}

/** Create and fund a fresh account through the quickstart friendbot. */
export async function fundedKeypair(config: E2EConfig): Promise<Keypair> {
  const keypair = Keypair.random();
  await waitFor(
    `friendbot to fund ${keypair.publicKey()}`,
    async () => {
      const res = await fetch(`${config.friendbotUrl}?addr=${keypair.publicKey()}`);
      return res.ok ? true : undefined;
    },
    120_000,
    2_000,
  );
  return keypair;
}

/** Prepare, sign, submit and wait for a single-operation transaction. */
async function invoke(
  server: Server,
  config: E2EConfig,
  signer: Keypair,
  operation: xdr.Operation,
): Promise<xdr.ScVal | undefined> {
  const account = await server.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(signer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`sendTransaction failed: ${JSON.stringify(sent.errorResult)}`);
  }

  const result = await server.pollTransaction(sent.hash, { attempts: 60 });
  if (result.status !== Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Transaction ${sent.hash} finished with status ${result.status}`);
  }
  return result.returnValue;
}

/** Upload the escrow Wasm and instantiate one contract from it. */
export async function deployEscrowContract(
  server: Server,
  config: E2EConfig,
  deployer: Keypair,
): Promise<string> {
  if (!fs.existsSync(config.wasmPath)) {
    throw new Error(
      `Escrow Wasm not found at ${config.wasmPath}. Build escrow-contract ` +
        "(stellar contract build) or set ESCROW_WASM_PATH.",
    );
  }

  const wasmHash = await invoke(
    server,
    config,
    deployer,
    Operation.uploadContractWasm({ wasm: fs.readFileSync(config.wasmPath) }),
  );
  if (!wasmHash) throw new Error("uploadContractWasm returned no wasm hash");

  const contractAddress = await invoke(
    server,
    config,
    deployer,
    Operation.createCustomContract({
      address: Address.fromString(deployer.publicKey()),
      wasmHash: wasmHash.bytes(),
      salt: randomBytes(32),
    }),
  );
  if (!contractAddress) throw new Error("createCustomContract returned no address");
  return Address.fromScVal(contractAddress).toString();
}

/**
 * Deploy the native XLM Stellar Asset Contract to use as the escrow token.
 * The SAC may already exist on a reused network, which is fine.
 */
export async function ensureNativeTokenContract(
  server: Server,
  config: E2EConfig,
  deployer: Keypair,
): Promise<string> {
  try {
    await invoke(
      server,
      config,
      deployer,
      Operation.createStellarAssetContract({ asset: Asset.native() }),
    );
  } catch (err) {
    // An existing SAC fails simulation; anything else is a real problem.
    if (!/exist/i.test(err instanceof Error ? err.message : String(err))) throw err;
  }
  return Asset.native().contractId(config.networkPassphrase);
}
