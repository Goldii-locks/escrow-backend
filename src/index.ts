// #602: must be the first import. ES imports are evaluated before this
// module's body, and several modules read process.env at top level.
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Express } from "express";
import type { Server } from "http";
import { createApp, assertProductionEnv } from "./app.js";
import { validateConfigAtStartup } from "./config.js";
import { runMigrations } from "./indexer/db.js";
import { startPoller } from "./indexer/poller.js";
import { startReconciliationJob } from "./indexer/reconciliation.js";
import { markIndexerStarted } from "./indexer/status.js";
import { assertRpcNetworkMatches } from "./routes/jobs.js";
import { registerShutdownHandlers } from "./shutdown.js";
import { formatError } from "./utils/format-error.js";
import logger from "./utils/logger.js";
import { captureError, initErrorReporting } from "./utils/error-reporting.js";

// Keep the process alive through unexpected async failures instead of
// crash-looping under Docker (#689). The poll loop records its own
// failures, so these handlers only log before the deliberate shutdown.
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", {
    error: formatError(reason),
  });
  captureError(reason, { tags: { source: "unhandledRejection" } });
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", {
    error: formatError(err),
  });
  captureError(err, { tags: { source: "uncaughtException" } });
});

// Fail fast on malformed numeric env vars (RATE_LIMIT_MAX=100r, empty values,
// NaN TTLs). Names the offending variable instead of booting into a hot
// poll loop or a broken rate limiter.
validateConfigAtStartup();

// Fail fast when required production env vars are missing.
assertProductionEnv();

// #895: opt-in error reporting, enabled only when SENTRY_DSN is set.
initErrorReporting();

// Initialize Express backend for Milesto Escrow Platform (pure, no side effects).
const app = createApp();
const PORT = process.env.PORT || 3001;

export interface StartupDeps {
  /** Override the app instance (tests inject a fresh Express app). */
  createApp?: () => Express;
  runMigrations?: () => void;
  markIndexerStarted?: () => void;
  assertRpcNetworkMatches?: () => Promise<void>;
  startPoller?: () => void;
  startReconciliationJob?: () => void;
  registerShutdownHandlers?: (server: Server) => void;
  listen?: (target: Express, port: string | number, onListening?: () => void) => Server;
  exit?: (code: number) => void;
  port?: string | number;
}

/**
 * Boot the backend. Every side effect that used to live in the module body is
 * injectable so the startup sequence can be tested (#950): a failed RPC
 * network check must exit(1) without starting the poller or reconciler.
 */
export async function main(deps: StartupDeps = {}): Promise<void> {
  const targetApp = deps.createApp ? deps.createApp() : app;
  const port = deps.port ?? PORT;

  (deps.runMigrations ?? runMigrations)();
  (deps.markIndexerStarted ?? markIndexerStarted)();

  // #692: Verify the RPC's reported network passphrase matches our config
  // before accepting any traffic. Mismatches would cause silent signature
  // failures; fail loud at startup instead.
  try {
    await (deps.assertRpcNetworkMatches ?? assertRpcNetworkMatches)();
  } catch (err) {
    logger.error("Startup network check failed – shutting down", {
      error: err instanceof Error ? err.message : String(err),
    });
    (deps.exit ?? process.exit)(1);
    return;
  }

  (deps.startPoller ?? startPoller)();
  (deps.startReconciliationJob ?? startReconciliationJob)();

  const listen = deps.listen ?? ((a: Express, p: string | number, cb?: () => void) => a.listen(p, cb));
  const server = listen(targetApp, port, () => {
    logger.info("Escrow backend started", { port });
  });

  // #623: drain in-flight work (poller, HTTP, SQLite) on SIGTERM/SIGINT
  // instead of exiting mid-transaction.
  (deps.registerShutdownHandlers ?? registerShutdownHandlers)(server);
}

// Run only when this module is the process entry point. Importing index.ts in
// a test must not bind a port or touch the database; the production assertion
// above still runs on import so the existing fail-fast tests keep working.
const invokedDirectly =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  void main();
}

export default app;
