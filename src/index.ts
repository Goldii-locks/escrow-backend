import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { validateConfigAtStartup } from "./config.js";
import jobRoutes, { assertRpcNetworkMatches } from "./routes/jobs.js";
import adminRoutes from "./routes/admin.js";
import webhookRoutes from "./routes/webhooks.js";
import { runMigrations } from "./indexer/db.js";
import { generalLimiter } from "./middleware/rateLimiter.js";
import { readinessHandler } from "./readiness.js";
import { legacyApiDeprecation } from "./middleware/api-version.js";
import { startPoller } from "./indexer/poller.js";
import { startReconciliationJob } from "./indexer/reconciliation.js";
import { markIndexerStarted } from "./indexer/status.js";
import { registerShutdownHandlers } from "./shutdown.js";
import logger from "./utils/logger.js";

dotenv.config();

// Fail fast on malformed numeric env vars (RATE_LIMIT_MAX=100r, empty values,
// NaN TTLs). Names the offending variable instead of booting into a hot
// poll loop or a broken rate limiter.
validateConfigAtStartup();

// Fail fast in production rather than booting into a silently insecure or
// misdirected state. Without this the server starts happily and passes
// /health while serving job endpoints unauthenticated (API_KEY unset),
// rejecting the real frontend origin (ALLOWED_ORIGINS defaulting to
// localhost:3000), or indexing nothing against testnet (CONTRACT_ID unset).
if (process.env.NODE_ENV === "production") {
  const required = [
    { name: "API_KEYS", alternatives: ["API_KEYS", "API_KEY"] },
    { name: "ADMIN_API_KEYS", alternatives: ["ADMIN_API_KEYS", "ADMIN_API_KEY"] },
    { name: "ALLOWED_ORIGINS", alternatives: ["ALLOWED_ORIGINS"] },
    { name: "CONTRACT_ID", alternatives: ["CONTRACT_ID"] },
    // #692: both RPC variables must be set explicitly in production; falling
    // back to testnet defaults against a mainnet RPC (or vice-versa) would
    // cause every transaction to fail at signature time.
    { name: "SOROBAN_RPC_URL", alternatives: ["SOROBAN_RPC_URL"] },
    { name: "SOROBAN_NETWORK_PASSPHRASE", alternatives: ["SOROBAN_NETWORK_PASSPHRASE"] },
  ] as const;
  const missing = required
    .filter(({ alternatives }) => !alternatives.some((key) => process.env[key]))
    .map(({ name }) => name);
  if (missing.length > 0) {
    throw new Error(
      `Missing required production environment variables: ${missing.join(", ")}`,
    );
  }
}

// Initialize Express backend for Milesto Escrow Platform
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(helmet());
app.use(express.json());

// Structured HTTP request logging (#86)
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on("finish", () => {
    logger.info("HTTP request", {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - start,
      ip: req.ip ?? req.socket?.remoteAddress,
    });
  });
  next();
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", contract: process.env.CONTRACT_ID });
});

// Readiness reflects the database and the poller; /health stays pure liveness.
app.get("/ready", readinessHandler);

app.use("/api", legacyApiDeprecation);
app.use("/api", generalLimiter);
app.use("/api/v1/jobs", jobRoutes);
app.use("/api/v1/admin", adminRoutes);
app.use("/api/v1/webhooks", webhookRoutes);
app.use("/api/jobs", jobRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/webhooks", webhookRoutes);

// Global error handler – prevents stack trace leakage
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error("Unhandled error", { error: message, path: req.path });
  res.status(500).json({ success: false, error: "Internal server error" });
});

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
