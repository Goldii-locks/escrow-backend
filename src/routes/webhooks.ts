import { Router } from "express";
import { sendSuccess, sendError } from "../utils/api-response.js";
import { requireApiKey } from "../middleware/apiKeyAuth.js";
import { getSubscriptionsForContract } from "../indexer/db.js";
import { requireAdmin } from "../middleware/adminAuth.js";
import { webhookLimiter } from "../middleware/rateLimiter.js";
import {
  dispatchSubscribe,
  dispatchUnsubscribe,
} from "../utils/webhook_dispatcher.js";

const router = Router();

function maskWebhookUrlQuery(webhookUrl: string): string {
  try {
    const url = new URL(webhookUrl);
    url.search = "";
    return url.toString();
  } catch {
    const queryIndex = webhookUrl.indexOf("?");
    return queryIndex === -1 ? webhookUrl : webhookUrl.slice(0, queryIndex);
  }
}

function parseEventTypes(eventTypes: string): unknown[] {
  if (eventTypes === "*") return ["*"];

  try {
    const parsed: unknown = JSON.parse(eventTypes);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

router.get("/subscriptions", requireApiKey, (req, res) => {
  const contractId = req.query.contract_id;
  if (typeof contractId !== "string" || contractId.trim().length === 0) {
    return sendError(res, 400, "contract_id is required");
  }

  const subscriptions = getSubscriptionsForContract(contractId).map((subscription) => ({
    id: subscription.id,
    webhook_url: maskWebhookUrlQuery(subscription.webhook_url),
    event_types: parseEventTypes(subscription.event_types),
    created_at: subscription.created_at,
  }));

  sendSuccess(res, { subscriptions });
});

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
  }, req.id);

  if (!result.ok) {
    return sendError(res, result.status, result.error);
  }

  sendSuccess(res, { subscription: result.subscription, traceId: result.traceId });
});

router.post("/unsubscribe", webhookLimiter, requireAdmin, (req, res) => {
  const result = dispatchUnsubscribe({
    contract_id: req.body?.contract_id,
    webhook_url: req.body?.webhook_url,
  }, req.id);

  if (!result.ok) {
    return sendError(res, result.status, result.error);
  }

  sendSuccess(res, {
    message: "Unsubscribed successfully",
    traceId: result.traceId,
  });
});

export default router;
