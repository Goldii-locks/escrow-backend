import type { Server } from "http";
import { stopPoller } from "./indexer/poller.js";
import { closeDb } from "./indexer/db.js";
import { config } from "./config.js";
import logger from "./utils/logger.js";

// ---------------------------------------------------------------------------
// Graceful shutdown (#623)
// ---------------------------------------------------------------------------
// src/index.ts used to ignore SIGTERM/SIGINT: `docker compose up` sends
// SIGTERM, Node exited immediately, and in-flight SQLite transactions,
// /submit responses and webhook deliveries were cut mid-write.
//
// Order: stopPoller() → server.close() (drains in-flight requests up to
// SHUTDOWN_TIMEOUT_MS) → closeDb() → process.exit(0). Force-exit after the
// timeout so a hung drain cannot block deploys forever.

export interface ShutdownDeps {
  stopPoller: () => void;
  /** Resolves once in-flight connections have drained. */
  closeServer: () => Promise<void>;
  closeDb: () => void;
  exit: (code: number) => void;
  timeoutMs: number;
}

export async function shutdown(deps: ShutdownDeps): Promise<void> {
  deps.stopPoller();
  await deps.closeServer();
  deps.closeDb();
  deps.exit(0);
}

/** server.close() wrapped as a promise; waits for in-flight requests. */
export function closeHttpServer(server: Server): () => Promise<void> {
  return () =>
    new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });
}

export function registerShutdownHandlers(
  server: Server,
  overrides?: Partial<ShutdownDeps>,
): void {
  let shuttingDown = false;

  const run = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutdown signal received – draining", { signal });

    const timeoutMs = overrides?.timeoutMs ?? config.shutdownTimeoutMs;
    const forceTimer = setTimeout(() => {
      logger.error("Shutdown timed out – force-exiting", { timeoutMs });
      (overrides?.exit ?? process.exit)(1);
    }, timeoutMs);
    // Don't hold the event loop open for the force timer alone.
    forceTimer.unref?.();

    shutdown({
      stopPoller: overrides?.stopPoller ?? stopPoller,
      closeServer: overrides?.closeServer ?? closeHttpServer(server),
      closeDb: overrides?.closeDb ?? closeDb,
      exit: (code) => {
        clearTimeout(forceTimer);
        (overrides?.exit ?? process.exit)(code);
      },
      timeoutMs,
    }).catch((err) => {
      clearTimeout(forceTimer);
      logger.error("Shutdown failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      (overrides?.exit ?? process.exit)(1);
    });
  };

  process.on("SIGTERM", () => run("SIGTERM"));
  process.on("SIGINT", () => run("SIGINT"));
}
