import { Server } from "@stellar/stellar-sdk/rpc";
import { scValToNative } from "@stellar/stellar-sdk";
import { getLastIndexedLedger, setLastIndexedLedger, insertEvent } from "./db.js";
import { deliverWebhooks } from "./webhook-delivery.js";

const RPC_URL = "https://soroban-testnet.stellar.org";
const server = new Server(RPC_URL);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "15000", 10);

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
    const currentLedger = (await server.getLatestLedger()).sequence;
    if (currentLedger <= lastLedger) return;

    const startLedger = lastLedger + 1;

    console.log(
      `Polling events from ledger ${startLedger} to ${currentLedger}`
    );

    const events = await server.getEvents({
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

    // Build the batch to be written atomically (#84)
    const batch: EventRow[] = events.events.map((event) => ({
      contractId: event.contractId ?? contractIds[0],
      eventType: scValToNative(event.topic[0]) as string,
      ledgerSequence: event.ledger,
      timestamp: event.ledgerClosedAt
        ? Math.floor(new Date(event.ledgerClosedAt).getTime() / 1000)
        : Math.floor(Date.now() / 1000),
      dataJson: JSON.stringify(event.value),
    }));

    setLastIndexedLedger(currentLedger);
    console.log(
      `Successfully processed ${events.events.length} events, up to ledger ${currentLedger}`
    );

    deliverWebhooks(startLedger, currentLedger).catch((err) =>
      console.error("Error delivering webhooks:", err)
    );
  } catch (err) {
    logger.error("Error polling events", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

let pollerInterval: NodeJS.Timeout | null = null;

export function startPoller() {
  if (pollerInterval) return;
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
