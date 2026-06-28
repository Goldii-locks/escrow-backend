import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import jobRoutes from "./routes/jobs.js";
import adminRoutes from "./routes/admin.js";
import { initSchema } from "./indexer/db.js";
import { generalLimiter } from "./middleware/rateLimiter.js";
import { startPoller } from "./indexer/poller.js";
import { markIndexerStarted } from "./indexer/status.js";
import logger from "./utils/logger.js";

dotenv.config();

// Initialize Express backend for Milesto Escrow Platform
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", contract: process.env.CONTRACT_ID });
});

app.use("/api", generalLimiter);
app.use("/api/jobs", jobRoutes);
app.use("/api/admin", adminRoutes);

// Global error handler - prevents stack trace leakage
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error("Unhandled error", { error: message, path: req.path });
  res.status(500).json({ success: false, error: "Internal server error" });
});

// Initialize indexer schema and start polling
initSchema();
markIndexerStarted();
startPoller();

app.listen(PORT, () => {
  console.log(`Escrow backend running on port ${PORT}`);
});

export default app;
