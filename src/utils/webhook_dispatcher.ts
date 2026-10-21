/**
 * webhook_dispatcher – Webhook event notification service.
 *
 * Orchestrates subscription mutations and outbound delivery with Winston
 * debug telemetry so pipeline flows can be traced end-to-end via traceId.
 */

import { randomUUID } from "crypto";
import {
  addSubscription,
  removeSubscription,
  getSubscriptions,
  type WebhookSubscription,
} from "../indexer/db.js";
import { deliverWebhooks } from "../indexer/webhook-delivery.js";
import { EVENT_TYPES } from "../indexer/event_type_filter.js";
import logger from "./logger.js";

export const WEBHOOK_DISPATCHER_ROUTE_PREFIX = "/api/webhooks";
const EVENT_TYPE_SET = new Set<string>(EVENT_TYPES);

export type SubscribeInput = {
  contract_id: string;
  webhook_url: string;
  event_types?: string[] | "*";
};

export type UnsubscribeInput = {
  contract_id: string;
  webhook_url: string;
};

export type DispatchFailure = {
  ok: false;
  status: number;
  error: string;
  traceId: string;
};

export type SubscribeResult =
  | { ok: true; subscription: WebhookSubscription; traceId: string }
  | DispatchFailure;

export type UnsubscribeResult =
  | { ok: true; traceId: string }
  | DispatchFailure;

function normalizeEventTypes(
  eventTypes: unknown,
): { ok: true; types: string[] } | { ok: false; error: string } {
  if (eventTypes === undefined || eventTypes === "*") {
    return { ok: true, types: ["*"] };
  }
  if (!Array.isArray(eventTypes)) {
    return {
      ok: false,
      error: "event_types must be a non-empty array of event names or '*'",
    };
  }
  if (eventTypes.length === 0) {
    return { ok: false, error: "event_types must be a non-empty array" };
  }

  const nonStrings = eventTypes.filter(
    (type: unknown) => typeof type !== "string",
  );
  if (nonStrings.length > 0) {
    return {
      ok: false,
      error: `event_types must contain only strings; invalid values: ${JSON.stringify(nonStrings)}`,
    };
  }

  const types = eventTypes.filter(
    (type: unknown): type is string => typeof type === "string",
  );
  const invalidLength = types.filter((type) => type.length < 1 || type.length > 9);
  if (invalidLength.length > 0) {
    return {
      ok: false,
      error: `event_types must be between 1 and 9 characters; invalid values: ${invalidLength.join(", ")}`,
    };
  }

  const duplicates = types.filter(
    (type, index) => types.indexOf(type) !== index,
  );
  if (duplicates.length > 0) {
    return {
      ok: false,
      error: `event_types must not contain duplicates: ${[...new Set(duplicates)].join(", ")}`,
    };
  }

  const unknownTypes = types.filter((type) => !EVENT_TYPE_SET.has(type));
  if (unknownTypes.length > 0) {
    return {
      ok: false,
      error: `Unknown event_types: ${unknownTypes.join(", ")}`,
    };
  }

  return { ok: true, types };
}

/**
 * Subscribe a webhook URL to contract events. Emits pipeline telemetry.
 */
export function dispatchSubscribe(input: SubscribeInput): SubscribeResult {
  const traceId = randomUUID();
  const route = `${WEBHOOK_DISPATCHER_ROUTE_PREFIX}/subscribe`;

  logger.debug("webhook_dispatcher subscribe handler entered", {
    traceId,
    route,
    bodyKeys: Object.keys(input),
    contractId: input.contract_id,
  });

  if (!input.contract_id || !input.webhook_url) {
    const error = "contract_id and webhook_url are required";
    logger.debug("webhook_dispatcher subscribe response sent", {
      traceId,
      route,
      status: 400,
      success: false,
      error,
    });
    return { ok: false, status: 400, error, traceId };
  }

  if (
    typeof input.contract_id !== "string" ||
    typeof input.webhook_url !== "string"
  ) {
    const error = "contract_id and webhook_url must be strings";
    logger.debug("webhook_dispatcher subscribe response sent", {
      traceId,
      route,
      status: 400,
      success: false,
      error,
    });
    return { ok: false, status: 400, error, traceId };
  }

  const normalized = normalizeEventTypes(input.event_types);
  if (!normalized.ok) {
    logger.debug("webhook_dispatcher subscribe response sent", {
      traceId,
      route,
      status: 400,
      success: false,
      error: normalized.error,
    });
    return { ok: false, status: 400, error: normalized.error, traceId };
  }

  try {
    const subscription = addSubscription(
      input.contract_id,
      input.webhook_url,
      normalized.types
    );

    logger.info("webhook_dispatcher subscription created", {
      traceId,
      route,
      subscriptionId: subscription.id,
      contractId: input.contract_id,
    });

    logger.debug("webhook_dispatcher subscribe response sent", {
      traceId,
      route,
      status: 200,
      success: true,
      subscriptionId: subscription.id,
    });

    return { ok: true, subscription, traceId };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("webhook_dispatcher subscribe failed", {
      traceId,
      route,
      contractId: input.contract_id,
      webhookUrl: input.webhook_url,
      error,
    });
    logger.debug("webhook_dispatcher subscribe response sent", {
      traceId,
      route,
      status: 500,
      success: false,
      error: "Internal server error",
    });
    return { ok: false, status: 500, error: "Internal server error", traceId };
  }
}

/**
 * Unsubscribe a webhook URL. Emits pipeline telemetry.
 */
export function dispatchUnsubscribe(input: UnsubscribeInput): UnsubscribeResult {
  const traceId = randomUUID();
  const route = `${WEBHOOK_DISPATCHER_ROUTE_PREFIX}/unsubscribe`;

  logger.debug("webhook_dispatcher unsubscribe handler entered", {
    traceId,
    route,
    bodyKeys: Object.keys(input),
    contractId: input.contract_id,
  });

  if (!input.contract_id || !input.webhook_url) {
    const error = "contract_id and webhook_url are required";
    logger.debug("webhook_dispatcher unsubscribe response sent", {
      traceId,
      route,
      status: 400,
      success: false,
      error,
    });
    return { ok: false, status: 400, error, traceId };
  }

  try {
    const removed = removeSubscription(input.contract_id, input.webhook_url);
    if (!removed) {
      const error = "Subscription not found";
      logger.debug("webhook_dispatcher unsubscribe response sent", {
        traceId,
        route,
        status: 404,
        success: false,
        error,
      });
      return { ok: false, status: 404, error, traceId };
    }

    logger.info("webhook_dispatcher subscription removed", {
      traceId,
      route,
      contractId: input.contract_id,
    });

    logger.debug("webhook_dispatcher unsubscribe response sent", {
      traceId,
      route,
      status: 200,
      success: true,
    });

    return { ok: true, traceId };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("webhook_dispatcher unsubscribe failed", {
      traceId,
      route,
      contractId: input.contract_id,
      webhookUrl: input.webhook_url,
      error,
    });
    logger.debug("webhook_dispatcher unsubscribe response sent", {
      traceId,
      route,
      status: 500,
      success: false,
      error: "Internal server error",
    });
    return { ok: false, status: 500, error: "Internal server error", traceId };
  }
}

/**
 * Dispatch stored events in a ledger range to matching subscribers.
 * Emits pipeline-start / pipeline-complete telemetry.
 */
export async function dispatchLedgerRange(
  startLedger: number,
  endLedger: number
): Promise<{
  traceId: string;
  results: Awaited<ReturnType<typeof deliverWebhooks>>;
  subscriptionCount: number;
}> {
  const traceId = randomUUID();
  const subscriptions = getSubscriptions();

  logger.debug("webhook_dispatcher delivery pipeline started", {
    traceId,
    startLedger,
    endLedger,
    subscriptionCount: subscriptions.length,
  });

  const results = await deliverWebhooks(startLedger, endLedger);

  const delivered = results.filter((r) => r.success).length;
  const failed = results.length - delivered;

  logger.debug("webhook_dispatcher delivery pipeline completed", {
    traceId,
    startLedger,
    endLedger,
    total: results.length,
    delivered,
    failed,
  });

  return { traceId, results, subscriptionCount: subscriptions.length };
}
