import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { getIndexerStatusData } from "../indexer/db.js";
import { getIndexerUptimeSeconds } from "../indexer/status.js";
import { getLatestReconciliationResults } from "../indexer/reconciliation.js";
import { collectIndexerMetrics } from "../indexer/indexer_metrics_collector.js";
import logger from "../utils/logger.js";

const router = Router();

router.use(requireAdmin);

router.get("/indexer-status", (_req, res) => {
  const status = getIndexerStatusData();
  res.json({
    success: true,
    lastIndexedLedger: status.lastIndexedLedger,
    totalEvents: status.totalEvents,
    uptimeSeconds: getIndexerUptimeSeconds(),
    lastEventAt: status.lastEventAt,
    eventsByType: status.eventsByType,
    reconciliation: getLatestReconciliationResults(),
  });
});

router.get("/metrics", (_req, res) => {
  try {
    const metrics = collectIndexerMetrics();
    res.json({ success: true, metrics });
  } catch (err) {
    logger.error("admin metrics endpoint failed to collect metrics", {
      error: err instanceof Error ? err.message : String(err),

    });
    res
      .status(500)
      .json({ success: false, error: "Failed to collect indexer metrics" });
  }
});

export default router;