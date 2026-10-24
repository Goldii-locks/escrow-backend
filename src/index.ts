import dotenv from "dotenv";
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

// Keep the process alive through unexpected async failures instead of
// crash-looping under Docker (#689). The poll loop records its own
// failures, so these handlers only log before the deliberate shutdown.
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", {
    error: formatError(reason),
  });
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", {
    error: formatError(err),
  });
});

dotenv.config();

// Fail fast on malformed numeric env vars (RATE_LIMIT_MAX=100r, empty values,
// NaN TTLs). Names the offending variable instead of booting into a hot
// poll loop or a broken rate limiter.
validateConfigAtStartup();

// Fail fast when required production env vars are missing.
assertProductionEnv();

// Initialize Express backend for Milesto Escrow Platform (pure, no side effects).
const app = createApp();
const PORT = process.env.PORT || 3001;

// Run DB migrations then start the indexer poller
runMigrations();
markIndexerStarted();

// #692: Verify the RPC's reported network passphrase matches our config
// before accepting any traffic. Mismatches would cause silent signature
// failures; fail loud at startup instead.
assertRpcNetworkMatches()
  .then(() => {
    startPoller();
    startReconciliationJob();
  })
  .catch((err) => {
    logger.error("Startup network check failed – shutting down", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });

const server = app.listen(PORT, () => {
  logger.info("Escrow backend started", { port: PORT });
});

// #623: drain in-flight work (poller, HTTP, SQLite) on SIGTERM/SIGINT
// instead of exiting mid-transaction.
registerShutdownHandlers(server);

export default app;
