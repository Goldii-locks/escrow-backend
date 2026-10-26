import { Router } from "express";
import { sendSuccess, sendError } from "../utils/api-response.js";
import { requireAdmin } from "../middleware/adminAuth.js";
import { webhookLimiter } from "../middleware/rateLimiter.js";
import {
  dispatchSubscribe,
  dispatchUnsubscribe,
} from "../utils/webhook_dispatcher.js";

const router = Router();

// Both mutation routes are credentialed and rate limited (#604). Without
// the admin key, anyone who could guess a contract_id + webhook_url pair
// could cut off another integrator's notifications (unsubscribe) or register
// unlimited callback URLs (subscribe). The limiter runs first so unbounded
// credential guessing cannot reach the auth check either.
router.post("/subscribe", webhookLimiter, requireAdmin, (req, res) => {
  const result = dispatchSubscribe({
    contract_id: req.body?.contract_id,
    webhook_url: req.body?.webhook_url,
    event_types: req.body?.event_types,
  });

  if (!result.ok) {
    return sendError(res, result.status, result.error);
  }

  sendSuccess(res, { subscription: result.subscription, traceId: result.traceId });
});

router.post("/unsubscribe", webhookLimiter, requireAdmin, (req, res) => {
  const result = dispatchUnsubscribe({
    contract_id: req.body?.contract_id,
    webhook_url: req.body?.webhook_url,
  });

  if (!result.ok) {
    return sendError(res, result.status, result.error);
  }

  sendSuccess(res, {
    message: "Unsubscribed successfully",
    traceId: result.traceId,
  });
});

export default router;
