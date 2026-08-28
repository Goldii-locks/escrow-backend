import { Server } from "@stellar/stellar-sdk/rpc";
import { scValToNative } from "@stellar/stellar-sdk";
import {
  getLastIndexedLedger,
  insertEventBatch,
  getActiveContractIds,
  registerContract,
  validateSchemaOrThrow,
  type EventRow,
} from "./db.js";
import { deliverWebhooks } from "./webhook-delivery.js";
import { withRpcBackoff } from "../utils/backoff.js";
import logger from "../utils/logger.js";

const RPC_URL =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const server = new Server(RPC_URL);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "15000", 10);

// Consecutive poll-failure threshold alerting (#duplicate-prevention).
// If the RPC connection keeps timing out (even after backoff retries exhaust
// within a single poll), we track how many *poll cycles* in a row have
// failed and log a threshold warning once operations have stalled for too
// long, so an operator/alerting pipeline can pick it up.
const POLL_FAILURE_ALERT_THRESHOLD = parseInt(
  process.env.POLL_FAILURE_ALERT_THRESHOLD || "5",
  10
);

let consecutivePollFailures = 0;

export function getConsecutivePollFailures(): number {
  return consecutivePollFailures;
}

export function resetConsecutivePollFailures(): void {
  consecutivePollFailures = 0;
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
 */
export async function pollEvents() {
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
    return;
  }

  try {
    const lastLedger = getLastIndexedLedger();

    // Ledger range tracker: fetch the current chain tip with exponential
    // backoff so a transient RPC connection timeout doesn't fail the poll.
    const currentLedger = (
      await withRpcBackoff(() => server.getLatestLedger())
    ).sequence;
    if (currentLedger <= lastLedger) {
      consecutivePollFailures = 0;
      return;
    }

    const startLedger = lastLedger + 1;

    logger.info("Polling events", { startLedger, currentLedger });

    // Duplicate prevention: fetch the events to be deduped/inserted, also
    // protected by the same exponential backoff on RPC connection timeouts.
    const events = await withRpcBackoff(() =>
      server.getEvents({
        startLedger,
        filters: [
          {
            type: "contract",
            contractIds,
            topics: [[...EVENT_TYPES]],
          },
        ],
        limit: 100,
      })
    );

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
    logger.info("Processed indexer poll", {
      eventCount: events.events.length,
      upToLedger: currentLedger,
    });
    consecutivePollFailures = 0;

    deliverWebhooks(startLedger, currentLedger).catch((err) =>
      logger.error("Error delivering webhooks", {
        error: err instanceof Error ? err.message : String(err),
      })
    );
  } catch (err) {
    consecutivePollFailures++;
    logger.error("Error polling events", {
      error: err instanceof Error ? err.message : String(err),
      consecutiveFailures: consecutivePollFailures,
    });

    if (consecutivePollFailures >= POLL_FAILURE_ALERT_THRESHOLD) {
      logger.warn("Indexer poll failure threshold reached", {
        consecutiveFailures: consecutivePollFailures,
        threshold: POLL_FAILURE_ALERT_THRESHOLD,
      });
    }
  }
}

let pollerInterval: NodeJS.Timeout | null = null;

/**
 * Starts the poller. Validates the database schema first (duplicate
 * prevention's startup guard) and throws if the schema is out of sync,
 * aborting startup rather than polling against a broken schema.
 */
export function startPoller() {
  if (pollerInterval) return;
  validateSchemaOrThrow();
  logger.info("Starting event indexer poller", { intervalMs: POLL_INTERVAL_MS });
  pollEvents();
  pollerInterval = setInterval(pollEvents, POLL_INTERVAL_MS);
}

export function stopPoller() {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
  }
}
