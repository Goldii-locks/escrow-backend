import { scValToNative } from "@stellar/stellar-sdk";
import {
  getLastIndexedLedger,
  insertEventBatch,
  getActiveContractIds,
  registerContract,
  adjustPollerInterval,
  getCurrentPollIntervalMs,
  verifySchemaUpToDate,
  type EventRow,
} from "./db.js";
import { deliverWebhooks } from "./webhook-delivery.js";
import { RpcPollerClient } from "./rpc-poller-client.js";
import logger from "../utils/logger.js";

const RPC_URL =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";

// ---------------------------------------------------------------------------
// RPC exponential backoff retry (#249)
// ---------------------------------------------------------------------------
// All RPC calls in the indexer poll loop go through RpcPollerClient, which
// retries transient failures (timeouts, connection resets, rate limits, 5xx)
// with a doubling backoff up to maxRetries, then resets on success.
const rpcRetryConfig = {
  maxRetries: parseInt(process.env.INDEXER_RPC_MAX_RETRIES || "5", 10),
  initialBackoffMs: parseInt(
    process.env.INDEXER_RPC_INITIAL_BACKOFF_MS || "1000",
    10,
  ),
  backoffMultiplier: parseInt(
    process.env.INDEXER_RPC_BACKOFF_MULTIPLIER || "2",
    10,
  ),
  maxBackoffMs: parseInt(
    process.env.INDEXER_RPC_MAX_BACKOFF_MS || "30000",
    10,
  ),
};

const rpcClient = new RpcPollerClient(RPC_URL, rpcRetryConfig);

// ---------------------------------------------------------------------------
// Alerting thresholds (#271)
// ---------------------------------------------------------------------------
const CONSECUTIVE_FAILURE_THRESHOLD = parseInt(
  process.env.POLLER_FAILURE_THRESHOLD || "3",
  10,
);

function getStallThresholdMs(): number {
  return parseInt(process.env.POLLER_STALL_THRESHOLD_MS || "120000", 10);
}

let consecutiveFailures = 0;
let lastSuccessfulPollAt: number | null = null;

export function getConsecutiveFailures(): number {
  return consecutiveFailures;
}

export function getLastSuccessfulPollAt(): number | null {
  return lastSuccessfulPollAt;
}

export function resetFailureState(): void {
  consecutiveFailures = 0;
  lastSuccessfulPollAt = null;
}

const EVENT_TYPES = [
  "initialized",
  "funded",
  "delivered",
  "approved",
  "dispute_raised",
  "dispute_resolved",
  "partial_release",
  "auto_release_claimed",
  "token_whitelisted",
  "token_removed",
];

/**
 * Poll events for all active contract IDs stored in monitored_contracts (#85).
 * All events fetched in a single poll are written atomically together with the
 * ledger pointer update (#84) – so a mid-poll crash cannot advance the pointer
 * without committing the accompanying events.
 *
 * Returns whether the ledger actually advanced, so startPoller() can throttle
 * its polling frequency up or down based on ledger processing load (#274).
 */
export async function pollEvents(): Promise<boolean> {
  // --- Resolve active contract IDs from the DB (#85) ---
  let contractIds: string[] = getActiveContractIds();

  // Fall back to the legacy single CONTRACT_ID env var so existing deployments
  // keep working without any DB seed step.
  if (contractIds.length === 0 && process.env.CONTRACT_ID) {
    registerContract(process.env.CONTRACT_ID, "default");
    contractIds = [process.env.CONTRACT_ID];
  }

  if (contractIds.length === 0) {
    logger.debug("No CONTRACT_IDs configured – skipping indexer poll");
    return false;
  }

  // --- Diagnostics: stall detection before polling (#270, #271) ---
  if (lastSuccessfulPollAt) {
    const stallThresholdMs = getStallThresholdMs();
    const elapsed = Date.now() - lastSuccessfulPollAt;
    if (elapsed > stallThresholdMs) {
      logger.warn("Poller stall detected – no successful poll for threshold period", {
        elapsedMs: elapsed,
        stallThresholdMs,
        consecutiveFailures,
      });
    }
    logger.debug("Poller stall diagnostics", {
      elapsedMsSinceLastSuccess: elapsed,
      stallThresholdMs,
    });
  }

  const pollStart = performance.now();

  try {
    // Validate the schema before matching events against EVENT_TYPES – a stale
    // schema must not silently pass through the topic filter (#282).
    verifySchemaUpToDate();

    const lastLedger = getLastIndexedLedger();
    const currentLedger = (await rpcClient.getLatestLedger()).sequence;
    if (currentLedger <= lastLedger) {
      // --- Dynamic throttling: idle cycle (#265) ---
      adjustPollerInterval(0);
      return false;
    }

    const startLedger = lastLedger + 1;

    logger.info("Polling events", { startLedger, currentLedger });

    const eventsStart = performance.now();
    const events: { events: any[] } = await rpcClient.getEvents({
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds,
          topics: [[...EVENT_TYPES]],
        },
      ],
      limit: 100,
    });
    const eventsElapsed = performance.now() - eventsStart;

    // --- Diagnostics: payload size and timing (#270) ---
    const payloadSizeBytes = JSON.stringify(events.events).length;
    logger.debug("RPC getEvents diagnostics", {
      elapsedMs: Math.round(eventsElapsed),
      payloadSizeBytes,
      eventCount: events.events.length,
      startLedger,
      currentLedger,
    });

    // Build the batch to be written atomically (#84)
    const batch: EventRow[] = events.events.map((event) => ({
      contractId: event.contractId?.contractId() ?? contractIds[0],
      eventType: scValToNative(event.topic[0]) as string,
      ledgerSequence: event.ledger,
      timestamp: event.ledgerClosedAt
        ? Math.floor(new Date(event.ledgerClosedAt).getTime() / 1000)
        : Math.floor(Date.now() / 1000),
      dataJson: JSON.stringify(event.value),
    }));

    // Persist the batch and advance the ledger pointer atomically (#84)
    insertEventBatch(batch, currentLedger);

    const totalElapsed = performance.now() - pollStart;
    consecutiveFailures = 0;
    lastSuccessfulPollAt = Date.now();

    // --- Dynamic poller throttling (#265) ---
    const throttleState = adjustPollerInterval(events.events.length);

    logger.info("Processed indexer poll", {
      eventCount: events.events.length,
      upToLedger: currentLedger,
      elapsedMs: Math.round(totalElapsed),
      pollIntervalMs: throttleState.currentIntervalMs,
    });

    deliverWebhooks(startLedger, currentLedger).catch((err) =>
      logger.error("Error delivering webhooks", {
        error: err instanceof Error ? err.message : String(err),
      })
    );

    return true;
  } catch (err) {
    const totalElapsed = performance.now() - pollStart;
    consecutiveFailures += 1;

    logger.error("Error polling events", {
      error: err instanceof Error ? err.message : String(err),
      consecutiveFailures,
      elapsedMs: Math.round(totalElapsed),
    });

    // --- Alerting: warn when consecutive failures hit threshold (#271) ---
    if (consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
      logger.error("Poller alert: consecutive failure threshold exceeded", {
        consecutiveFailures,
        threshold: CONSECUTIVE_FAILURE_THRESHOLD,
        lastSuccessAt: lastSuccessfulPollAt,
      });
    }
    return false;
  }
}

let pollerTimeout: NodeJS.Timeout | null = null;
let pollerRunning = false;

async function pollLoop() {
  if (!pollerRunning) return;
  await pollEvents();
  const interval = getCurrentPollIntervalMs();
  pollerTimeout = setTimeout(pollLoop, interval);
}

export function startPoller() {
  if (pollerRunning) return;
  pollerRunning = true;
  logger.info("Starting event indexer poller", {
    intervalMs: getCurrentPollIntervalMs(),
  });
  pollEvents();
  pollerTimeout = setTimeout(pollLoop, getCurrentPollIntervalMs());
}

export function stopPoller() {
  pollerRunning = false;
  if (pollerTimeout) {
    clearTimeout(pollerTimeout);
    pollerTimeout = null;
  }
}
