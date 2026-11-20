import type { Server } from "http";
import { stopPoller, waitForWebhookDeliveries } from "./indexer/poller.js";
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
// Order: stopPoller() → wait for the in-flight webhook delivery run (#850)
// → server.close() (drains in-flight requests) → closeDb() →
// process.exit(0), all bounded by SHUTDOWN_TIMEOUT_MS. Force-exit after the
// timeout so a hung drain cannot block deploys forever.
//
// A delivery run cut short by the timeout loses nothing: each subscription's
// delivery cursor is persisted per event, so the next process resumes from
// the first event not yet delivered.

export interface ShutdownDeps {
  stopPoller: () => void;
  /** Resolves once in-flight connections have drained. */
  closeServer: () => Promise<void>;
  closeDb: () => void;
  exit: (code: number) => void;
  timeoutMs: number;
  /** Resolves once the in-flight webhook delivery run has finished (#850). */
  waitForWebhookDeliveries?: () => Promise<void>;
}

/**
 * Wait for `promise`, but no longer than `timeoutMs`. Resolves `true` when
 * the promise settled in time.
 */
function waitWithTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

export async function shutdown(deps: ShutdownDeps): Promise<void> {
  deps.stopPoller();
  if (deps.waitForWebhookDeliveries) {
    const drained = await waitWithTimeout(deps.waitForWebhookDeliveries(), deps.timeoutMs);
    if (!drained) {
      logger.warn("Webhook delivery run still in flight at shutdown timeout", {
        timeoutMs: deps.timeoutMs,
      });
    }
  }
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
      waitForWebhookDeliveries:
        overrides?.waitForWebhookDeliveries ?? waitForWebhookDeliveries,
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
