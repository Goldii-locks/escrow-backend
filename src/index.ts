import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import jobRoutes from "./routes/jobs.js";
import adminRoutes from "./routes/admin.js";
import webhookRoutes from "./routes/webhooks.js";
import estimateRoutes from "./routes/estimate.js";
import { runMigrations } from "./indexer/db.js";
import { generalLimiter } from "./middleware/rateLimiter.js";
import { startPoller } from "./indexer/poller.js";
import { markIndexerStarted } from "./indexer/status.js";
import logger from "./utils/logger.js";

dotenv.config();

// Fail fast in production rather than booting into a silently insecure or
// misdirected state. Without this the server starts happily and passes
// /health while serving job endpoints unauthenticated (API_KEY unset),
// rejecting the real frontend origin (ALLOWED_ORIGINS defaulting to
// localhost:3000), or indexing nothing against testnet (CONTRACT_ID unset).
if (process.env.NODE_ENV === "production") {
  const required = [
    "API_KEY",
    "ADMIN_API_KEY",
    "ALLOWED_ORIGINS",
    "CONTRACT_ID",
  ] as const;
  const missing = required.filter((key) => !process.env[key]);
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

app.use("/api", generalLimiter);
app.use("/api/jobs", jobRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/estimate", estimateRoutes);

// Global error handler – prevents stack trace leakage
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error("Unhandled error", { error: message, path: req.path });
  res.status(500).json({ success: false, error: "Internal server error" });
});

// Run DB migrations then start the indexer poller
runMigrations();
markIndexerStarted();
startPoller();

app.listen(PORT, () => {
  logger.info("Escrow backend started", { port: PORT });
});

export default app;
