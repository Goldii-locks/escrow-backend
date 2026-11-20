/**
 * One-shot contract deployment for docker-compose.dev.yml's `deploy` service
 * (#963). Reuses the E2E global setup against an already running quickstart
 * (E2E_RPC_URL / E2E_FRIENDBOT_URL): deploys the native token SAC, an escrow
 * through its constructor and an escrow factory that allows the token, has
 * the freelancer and arbiter accept the job, then writes the ids to
 * DEV_ENV_FILE (default `.env.dev`) for the backend service.
 *
 * Runs on Node's built-in type stripping, no build step:
 *
 *   node test/e2e/dev-deploy.ts
 */
import fs from "node:fs";
import path from "node:path";
import globalSetup from "./global-setup.ts";
import { STATE_FILE, rpcServer, type E2EState } from "./soroban-network.ts";

const target = path.resolve(process.env.DEV_ENV_FILE ?? ".env.dev");

await globalSetup();
const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as E2EState;
fs.rmSync(STATE_FILE, { force: true });

const chainHead = (await rpcServer(state.rpcUrl).getLatestLedger()).sequence;

const contents = [
  "# Written by the docker-compose.dev.yml deploy service (#963).",
  "# Local standalone network only; recreate the backend to pick it up:",
  "#   docker compose -f docker-compose.dev.yml up -d --force-recreate backend",
  `CONTRACT_ID=${state.contractId}`,
  `FACTORY_CONTRACT_ID=${state.factoryContractId}`,
  // The escrow constructor's init event predates the backend's next start;
  // import it once through the startup historical backfill.
  `LEDGER_RANGE_START=${state.deployLedger}`,
  `LEDGER_RANGE_END=${chainHead}`,
  "",
  "# Throwaway standalone accounts from the deploy, for signing by hand:",
  `# token (native XLM SAC): ${state.tokenContractId}`,
  `# client: ${state.client} (secret ${state.clientSecret})`,
  `# freelancer: ${state.freelancer}`,
  `# arbiter: ${state.arbiter}`,
  `# admin secret: ${state.adminSecret}`,
  "",
].join("\n");

fs.writeFileSync(target, contents);
console.log(
  `Deployed escrow ${state.contractId} and factory ${state.factoryContractId}; wrote ${target}`,
);
