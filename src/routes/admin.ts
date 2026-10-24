import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { getIndexerStatusData } from "../indexer/db.js";
import { getIndexerUptimeSeconds } from "../indexer/status.js";
import { getLatestReconciliationResults } from "../indexer/reconciliation.js";
import {
  getDeadDeliveries,
  getFailedDeliveryCount,
} from "../indexer/webhook-delivery.js";

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
    failedDeliveries: getFailedDeliveryCount(),
    deadDeliveries: getDeadDeliveries(),
  });
});

export default router;
