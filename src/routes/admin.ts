import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import {
  getIndexerStatusData,
  getSubscriptions,
  getActiveSubscriptions,
  getDisabledSubscriptions,
} from "../indexer/db.js";
import { getIndexerUptimeSeconds } from "../indexer/status.js";
import { getLatestReconciliationResults } from "../indexer/reconciliation.js";

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

// GET /api/admin/webhook-subscriptions – every webhook subscription,
// including the ones that were auto-disabled after repeated delivery
// failures (#701).
router.get("/webhook-subscriptions", (_req, res) => {
  res.json({
    success: true,
    subscriptions: getSubscriptions(),
    active: getActiveSubscriptions(),
    disabled: getDisabledSubscriptions(),
  });
});

export default router;
