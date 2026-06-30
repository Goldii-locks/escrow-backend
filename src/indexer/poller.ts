import { Server } from "@stellar/stellar-sdk/rpc";
import { scValToNative } from "@stellar/stellar-sdk";
import { getLastIndexedLedger, setLastIndexedLedger, insertEvent } from "./db.js";

const RPC_URL =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const server = new Server(RPC_URL);
const CONTRACT_ID = process.env.CONTRACT_ID || "";
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

export async function pollEvents() {
  if (!CONTRACT_ID) {
    console.log("No CONTRACT_ID set, skipping indexer polling");
    return;
  }

  try {
    const lastLedger = getLastIndexedLedger();
    const currentLedger = (await server.getLatestLedger()).sequence;
    if (currentLedger <= lastLedger) return;

    console.log(
      `Polling events from ledger ${lastLedger + 1} to ${currentLedger}`
    );

    const events = await server.getEvents({
      startLedger: lastLedger + 1,
      filters: [
        {
          type: "contract",
          contractIds: [CONTRACT_ID],
          topics: [[...EVENT_TYPES]],
        },
      ],
      limit: 100,
    });

    for (const event of events.events) {
      const eventType = scValToNative(event.topic[0]) as string;
      const ledgerSequence = event.ledger;
      const timestamp = event.ledgerClosedAt
        ? Math.floor(new Date(event.ledgerClosedAt).getTime() / 1000)
        : Math.floor(Date.now() / 1000);
      const dataJson = JSON.stringify(event.value);
      insertEvent(
        CONTRACT_ID,
        eventType,
        ledgerSequence,
        timestamp,
        dataJson
      );
    }

    setLastIndexedLedger(currentLedger);
    console.log(
      `Successfully processed ${events.events.length} events, up to ledger ${currentLedger}`
    );
  } catch (err) {
    console.error("Error polling events:", err);
  }
}

let pollerInterval: NodeJS.Timeout | null = null;

export function startPoller() {
  if (pollerInterval) return;
  console.log("Starting event indexer poller");
  pollEvents();
  pollerInterval = setInterval(pollEvents, POLL_INTERVAL_MS);
}

export function stopPoller() {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
  }
}
