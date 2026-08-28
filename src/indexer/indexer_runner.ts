import logger from "../utils/logger.js";

/**
 * Indexer runner – diagnostics helpers for the main indexer event poller (#252).
 *
 * High-frequency debug logs track poll speeds (elapsedMs) and payload sizes so
 * operators can spot slow RPC rounds or unexpectedly large event batches.
 */

export interface IndexerRunnerPollDiagnostics {
  operation: string;
  status: "started" | "success" | "failure";
  elapsedMs: number;
  payloadSizeBytes?: number;
  eventCount?: number;
  startLedger?: number;
  currentLedger?: number;
  error?: string;
}

export function payloadSizeBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

/**
 * Emit an indexer_runner poll diagnostics debug log. Always includes elapsedMs
 * so validation can assert timing fields are present (#252).
 */
export function logIndexerRunnerPollDiagnostics(
  diagnostics: IndexerRunnerPollDiagnostics,
): void {
  logger.debug("indexer_runner poll diagnostics", diagnostics);
}
