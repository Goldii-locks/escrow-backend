import type { Server } from "http";
import { stopPoller } from "./indexer/poller.js";
import { stopReconciliationJob } from "./indexer/reconciliation.js";
import { closeDb } from "./indexer/db.js";
import { config } from "./config.js";
import { formatError } from "./utils/format-error.js";
import logger from "./utils/logger.js";

// ---------------------------------------------------------------------------
// Graceful shutdown (#623)
// ---------------------------------------------------------------------------
// src/index.ts used to ignore SIGTERM/SIGINT: `docker compose up` sends
// SIGTERM, Node exited immediately, and in-flight SQLite transactions,
// /submit responses and webhook deliveries were cut mid-write.
//
// Order: stopPoller() (awaits the in-flight poll cycle, write and webhook
// queues, and stops the reconciliation and maintenance timers, #870) → server.close() (drains in-flight requests up to
// SHUTDOWN_TIMEOUT_MS) → closeDb() → process.exit(0). Force-exit after the
// timeout so a hung drain cannot block deploys forever.

export interface ShutdownDeps {
  /** Resolves once the in-flight poll cycle and its queues have settled. */
  stopPoller: () => void | Promise<void>;
  /** Resolves once in-flight connections have drained. */
  closeServer: () => Promise<void>;
  closeDb: () => void;
  exit: (code: number) => void;
  timeoutMs: number;
}

export async function shutdown(deps: ShutdownDeps, exitCode = 0): Promise<void> {
  await deps.stopPoller();
  await deps.closeServer();
  deps.closeDb();
  deps.exit(exitCode);
}

/** Set by registerShutdownHandlers so a crash can reuse the graceful drain. */
let triggerShutdown: ((reason: string, exitCode: number) => void) | null = null;

/**
 * Resuming after an uncaught exception is unsafe (#867): log it, run the
 * graceful shutdown and exit 1 so the supervisor restarts a clean process.
 * Before the server is up there is nothing to drain, so exit immediately.
 */
export function handleUncaughtException(
  err: unknown,
  exit: (code: number) => void = process.exit,
): void {
  logger.error("Uncaught exception – shutting down", {
    error: formatError(err),
  });
  if (triggerShutdown) triggerShutdown("uncaughtException", 1);
  else exit(1);
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

  const run = (signal: string, exitCode = 0): void => {
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
      stopPoller:
        overrides?.stopPoller ??
        (() => {
          stopReconciliationJob();
          return stopPoller();
        }),
      closeServer: overrides?.closeServer ?? closeHttpServer(server),
      closeDb: overrides?.closeDb ?? closeDb,
      exit: (code) => {
        clearTimeout(forceTimer);
        (overrides?.exit ?? process.exit)(code);
      },
      timeoutMs,
    }, exitCode).catch((err) => {
      clearTimeout(forceTimer);
      logger.error("Shutdown failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      (overrides?.exit ?? process.exit)(1);
    });
  };

  triggerShutdown = run;
  process.on("SIGTERM", () => run("SIGTERM"));
  process.on("SIGINT", () => run("SIGINT"));
}
