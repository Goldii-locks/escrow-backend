/**
 * Jest globalSetup for the Soroban E2E suite (#684): bring up (or reuse) a
 * local quickstart network, deploy the escrow contract plus the native token
 * SAC, and persist the resulting ids/keys for the spec to read.
 */
import fs from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import {
  STATE_FILE,
  deployEscrowContract,
  ensureNativeTokenContract,
  ensureQuickstart,
  fundedKeypair,
  loadConfig,
  rpcServer,
  type E2EState,
} from "./soroban-network.js";

export default async function globalSetup(): Promise<void> {
  const config = loadConfig();
  const startedContainer = await ensureQuickstart(config);
  const server = rpcServer(config.rpcUrl);

  // Only the admin pays for transactions; the other parties just need
  // distinct, valid addresses for initialize's party-distinctness check.
  const admin = await fundedKeypair(config);
  const contractId = await deployEscrowContract(server, config, admin);
  const tokenContractId = await ensureNativeTokenContract(server, config, admin);

  const state: E2EState = {
    rpcUrl: config.rpcUrl,
    networkPassphrase: config.networkPassphrase,
    contractId,
    tokenContractId,
    adminSecret: admin.secret(),
    client: Keypair.random().publicKey(),
    freelancer: Keypair.random().publicKey(),
    arbiter: Keypair.random().publicKey(),
    startedContainer,
    containerName: config.containerName,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
