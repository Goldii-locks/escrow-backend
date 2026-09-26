import { Router } from "express";
import { sendSuccess, sendError } from "../utils/api-response.js";
import {
  dispatchSubscribe,
  dispatchUnsubscribe,
} from "../utils/webhook_dispatcher.js";

const router = Router();

router.post("/subscribe", (req, res) => {
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

router.post("/unsubscribe", (req, res) => {
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
