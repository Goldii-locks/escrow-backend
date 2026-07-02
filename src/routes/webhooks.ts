import { Router } from "express";
import { addSubscription, removeSubscription } from "../indexer/db.js";
import { sendSuccess, sendError } from "../utils/api-response.js";

const router = Router();

router.post("/subscribe", (req, res) => {
  const { contract_id, webhook_url, event_types } = req.body;

  if (!contract_id || !webhook_url) {
    return sendError(res, 400, "contract_id and webhook_url are required");
  }

  if (typeof contract_id !== "string" || typeof webhook_url !== "string") {
    return sendError(res, 400, "contract_id and webhook_url must be strings");
  }

  let types: string[];
  if (!event_types || event_types === "*") {
    types = ["*"];
  } else if (Array.isArray(event_types)) {
    types = event_types;
  } else {
    return sendError(res, 400, "event_types must be an array of strings or '*'");
  }

  const subscription = addSubscription(contract_id, webhook_url, types);
  sendSuccess(res, { subscription });
});

router.post("/unsubscribe", (req, res) => {
  const { contract_id, webhook_url } = req.body;

  if (!contract_id || !webhook_url) {
    return sendError(res, 400, "contract_id and webhook_url are required");
  }

  const removed = removeSubscription(contract_id, webhook_url);
  if (!removed) {
    return sendError(res, 404, "Subscription not found");
  }

  sendSuccess(res, { message: "Unsubscribed successfully" });
});

export default router;
