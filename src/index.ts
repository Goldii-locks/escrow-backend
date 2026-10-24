import dotenv from "dotenv";
import { createApp, assertProductionEnv } from "./app.js";
import { runMigrations } from "./indexer/db.js";
import { startPoller } from "./indexer/poller.js";
import { startReconciliationJob } from "./indexer/reconciliation.js";
import { markIndexerStarted } from "./indexer/status.js";
import { assertRpcNetworkMatches } from "./routes/jobs.js";
import logger from "./utils/logger.js";

dotenv.config();

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

app.listen(PORT, () => {
  logger.info("Escrow backend started", { port: PORT });
});

export default app;
