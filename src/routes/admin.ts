import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { getIndexerStatusData } from "../indexer/db.js";
import { getIndexerUptimeSeconds } from "../indexer/status.js";
import { getLatestReconciliationResults } from "../indexer/reconciliation.js";
import {
  getChainHeadSequence,
  getConsecutiveFailures,
  getCurrentPollIntervalMs,
  getLastSuccessfulPollAt,
} from "../indexer/poller.js";
import { sendSuccess } from "../utils/api-response.js";

const router = Router();

router.use(requireAdmin);

router.get("/indexer-status", async (_req, res) => {
  const status = getIndexerStatusData();

  // The chain head is read over RPC. When it cannot be reached the lag is
  // reported as null rather than a misleading zero — "no data" and "fully
  // caught up" are different states for an operator watching the indexer.
  const chainHead = await getChainHeadSequence();
  const ledgerLag =
    chainHead === null || status.lastIndexedLedger === null
      ? null
      : chainHead - status.lastIndexedLedger;

  sendSuccess(res, {
    lastIndexedLedger: status.lastIndexedLedger,
    totalEvents: status.totalEvents,
    uptimeSeconds: getIndexerUptimeSeconds(),
    lastEventAt: status.lastEventAt,
    eventsByType: status.eventsByType,
    reconciliation: getLatestReconciliationResults(),
    // Poll-loop health: how many polls failed back to back, when the last
    // poll succeeded, and how long the loop is currently waiting between
    // cycles. All three come straight from the poll loop's own state.
    consecutiveFailures: getConsecutiveFailures(),
    lastSuccessfulPollAt: getLastSuccessfulPollAt(),
    pollIntervalMs: getCurrentPollIntervalMs(),
    // How far behind the chain head the indexer is. null when the head is
    // unknown.
    ledgerLag,
  });
});

export default router;
