import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { getIndexerStatusData } from "../indexer/db.js";
import { getIndexerUptimeSeconds } from "../indexer/status.js";
import { getLatestReconciliationResults } from "../indexer/reconciliation.js";
import {
  getConsecutiveFailures,
  getLastSuccessfulPollAt,
  getCurrentPollIntervalMs,
  rpcClient,
} from "../indexer/poller.js";
import { sendSuccess } from "../utils/api-response.js";

const router = Router();

router.use(requireAdmin);

/**
 * ledgerLag (chain head − lastIndexedLedger) requires an RPC call, so cache it
 * for a few seconds to avoid hitting the RPC on every status refresh.
 */
const LEDGER_LAG_CACHE_TTL_MS = 5000;
let ledgerLagCache: { value: number; at: number } | null = null;

async function getLedgerLagCached(lastIndexedLedger: number): Promise<number> {
  const now = Date.now();
  if (ledgerLagCache && now - ledgerLagCache.at < LEDGER_LAG_CACHE_TTL_MS) {
    return ledgerLagCache.value;
  }
  const head = (await rpcClient.getLatestLedger()).sequence;
  const lag = head - lastIndexedLedger;
  ledgerLagCache = { value: lag, at: now };
  return lag;
}

router.get("/indexer-status", async (_req, res) => {
  const status = getIndexerStatusData();
  const ledgerLag = await getLedgerLagCached(status.lastIndexedLedger);
  sendSuccess(res, {
    lastIndexedLedger: status.lastIndexedLedger,
    totalEvents: status.totalEvents,
    uptimeSeconds: getIndexerUptimeSeconds(),
    lastEventAt: status.lastEventAt,
    eventsByType: status.eventsByType,
    reconciliation: getLatestReconciliationResults(),
    consecutiveFailures: getConsecutiveFailures(),
    lastSuccessfulPollAt: getLastSuccessfulPollAt(),
    pollIntervalMs: getCurrentPollIntervalMs(),
    ledgerLag,
  });
});

export default router;
