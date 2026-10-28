/**
 * Jest globalSetup for the Soroban E2E suite (#684): bring up (or reuse) a
 * local quickstart network, deploy the native token SAC and an escrow
 * contract initialised through its constructor, have the freelancer and
 * arbiter accept the job, and persist the resulting ids/keys for the spec.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  STATE_FILE,
  deployEscrowContract,
  ensureNativeTokenContract,
  ensureQuickstart,
  fundedKeypair,
  invokeContract,
  loadConfig,
  rpcServer,
  type E2EState,
} from "./soroban-network.ts";

const MILESTONE_AMOUNTS = ["1000", "2500"];
const AUTO_RELEASE_SECONDS = 7 * 86_400;
const DISPUTE_TIMEOUT_SECONDS = 30 * 86_400;

const address = (account: string) => new Address(account).toScVal();

/** `EscrowSettings` as the contract expects it: a map with sorted keys. */
function escrowSettings(): xdr.ScVal {
  const field = (key: string, val: xdr.ScVal) =>
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
  return xdr.ScVal.scvMap([
    field("arbiter_fee_bps", nativeToScVal(0, { type: "u32" })),
    field("dispute_timeout_seconds", nativeToScVal(DISPUTE_TIMEOUT_SECONDS, { type: "u64" })),
    field("funding_mode", xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Upfront")])),
  ]);
}

export default async function globalSetup(): Promise<void> {
  const config = loadConfig();
  const startedContainer = await ensureQuickstart(config);
  const server = rpcServer(config.rpcUrl);

  // Every party signs something (deploy, accept, fund), so each needs a
  // funded account. The client pays `fund` in native XLM.
  const [admin, client, freelancer, arbiter] = await Promise.all(
    Array.from({ length: 4 }, () => fundedKeypair(config)),
  );
  const tokenContractId = await ensureNativeTokenContract(server, config, admin);

  const specHashes = MILESTONE_AMOUNTS.map((_, i) =>
    createHash("sha256").update(`e2e milestone ${i}`).digest(),
  );
  // The constructor emits `init` before the backend starts, so the spec has
  // the indexer backfill from this ledger.
  const deployLedger = (await server.getLatestLedger()).sequence;
  const contractId = await deployEscrowContract(server, config, admin, [
    address(admin.publicKey()),
    address(client.publicKey()),
    address(freelancer.publicKey()),
    address(arbiter.publicKey()),
    address(tokenContractId),
    nativeToScVal(AUTO_RELEASE_SECONDS, { type: "u64" }),
    xdr.ScVal.scvVec(MILESTONE_AMOUNTS.map((a) => nativeToScVal(BigInt(a), { type: "i128" }))),
    xdr.ScVal.scvVec(specHashes.map((h) => xdr.ScVal.scvBytes(h))),
    escrowSettings(),
  ]);

  // Work on the job is gated on both acceptances.
  await invokeContract(server, config, freelancer, contractId, "accept_job", [
    address(freelancer.publicKey()),
  ]);
  await invokeContract(server, config, arbiter, contractId, "accept_arbiter", [
    address(arbiter.publicKey()),
  ]);

  const state: E2EState = {
    rpcUrl: config.rpcUrl,
    networkPassphrase: config.networkPassphrase,
    contractId,
    tokenContractId,
    adminSecret: admin.secret(),
    clientSecret: client.secret(),
    client: client.publicKey(),
    freelancer: freelancer.publicKey(),
    arbiter: arbiter.publicKey(),
    milestoneAmounts: MILESTONE_AMOUNTS,
    deployLedger,
    startedContainer,
    containerName: config.containerName,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
