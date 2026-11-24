import { randomUUID } from "crypto";
import { Router } from "express";
import { sendSuccess, sendError } from "../utils/api-response.js";
import { requireApiKey } from "../middleware/apiKeyAuth.js";
import { getSubscriptionsForContract, type EventDbRow } from "../indexer/db.js";
import { requireAdmin } from "../middleware/adminAuth.js";
import { webhookLimiter } from "../middleware/rateLimiter.js";
import { deliverToUrl } from "../indexer/webhook-delivery.js";
import {
  dispatchSubscribe,
  dispatchUnsubscribe,
} from "../utils/webhook_dispatcher.js";
// NOTE: src/utils/webhook_dispatcher.ts is the single live webhook dispatcher.
// The unreachable src/indexer/webhook_dispatcher.ts was removed as part of this fix.

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

// Lets an integrator verify their endpoint/TLS before a real on-chain event
// happens (#858), without creating a webhook_deliveries row or touching the
// subscription's failure counters — a failed ping must not auto-disable a
// subscription or appear in dead-letter listings.
router.post("/test", webhookLimiter, requireAdmin, async (req, res) => {
  const contractId = req.body?.contract_id;
  const webhookUrl = req.body?.webhook_url;
  if (typeof contractId !== "string" || contractId.trim().length === 0) {
    return sendError(res, 400, "contract_id is required");
  }
  if (typeof webhookUrl !== "string" || webhookUrl.trim().length === 0) {
    return sendError(res, 400, "webhook_url is required");
  }

  const subscription = getSubscriptionsForContract(contractId).find(
    (sub) => sub.webhook_url === webhookUrl,
  );
  if (!subscription) {
    return sendError(
      res,
      404,
      "No webhook subscription matches that contract_id and webhook_url",
    );
  }

  const pingEvent: EventDbRow = {
    id: -1,
    contract_id: contractId,
    event_type: "ping",
    event_id: `ping:${randomUUID()}`,
    ledger_sequence: 0,
    timestamp: Math.floor(Date.now() / 1000),
    data_json: "{}",
    created_at: new Date().toISOString(),
  };

  const outcome = await deliverToUrl(webhookUrl, pingEvent);
  sendSuccess(res, {
    ok: outcome.ok,
    status: outcome.status,
    errorCode: outcome.errorCode,
    durationMs: outcome.durationMs,
  });
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
