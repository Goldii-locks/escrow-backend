import express from "express";
import type { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import jobRoutes from "./routes/jobs.js";
import adminRoutes from "./routes/admin.js";
import webhookRoutes from "./routes/webhooks.js";
import { generalLimiter } from "./middleware/rateLimiter.js";
import { legacyApiDeprecation } from "./middleware/api-version.js";
import { readinessHandler } from "./readiness.js";
import logger from "./utils/logger.js";
import { globalCors } from "./middleware/global-cors.js";
import { globalErrorHandler } from "./middleware/error-handler.js";
import { resolveTrustProxy } from "./utils/trust-proxy.js";

// Fail fast in production rather than booting into a silently insecure or
// misdirected state. Without this the server starts happily and passes
// /health while serving job endpoints unauthenticated (API_KEY unset),
// rejecting the real frontend origin (ALLOWED_ORIGINS defaulting to
// localhost:3000), or indexing nothing against testnet (CONTRACT_ID unset).
const REQUIRED_PRODUCTION_ENV = [
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

/**
 * Throw when a required production environment variable is missing.
 * Skipped entirely outside production. Accepts an explicit env mapping so it
 * can be unit tested without mutating process.env.
 */
export function assertProductionEnv(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV !== "production") {
    return;
  }
  const missing = REQUIRED_PRODUCTION_ENV.filter(
    ({ alternatives }) => !alternatives.some((key) => env[key]),
  ).map(({ name }) => name);
  if (missing.length > 0) {
    throw new Error(
      `Missing required production environment variables: ${missing.join(", ")}`,
    );
  }
}

/**
 * Global error handler (#603): body-parser errors (malformed JSON, oversized
 * payloads) keep their 4xx status; anything else is a 500 with no detail.
 */
export { globalErrorHandler } from "./middleware/error-handler.js";

/**
 * Build the configured Express app. Pure: no DB, poller, or listener side
 * effects, so tests can import it freely with supertest.
 */
export function createApp(): express.Express {
  const app = express();

  // #600: key req.ip (and so every rate limiter) on the real client behind nginx.
  app.set("trust proxy", resolveTrustProxy());

  app.use(globalCors());
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

  app.use(globalErrorHandler);

  return app;
}
