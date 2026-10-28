/**
 * Jest globalTeardown for the Soroban E2E suite (#684). Stops the quickstart
 * container only if global-setup started it, unless E2E_KEEP_NETWORK=1.
 */
import fs from "node:fs";
import { STATE_FILE, loadConfig, stopQuickstart, type E2EState } from "./soroban-network.ts";

export default async function globalTeardown(): Promise<void> {
  if (!fs.existsSync(STATE_FILE)) return;
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as E2EState;
  fs.rmSync(STATE_FILE, { force: true });

  if (state.startedContainer && !loadConfig().keepNetwork) {
    stopQuickstart(state.containerName);
  }
}
