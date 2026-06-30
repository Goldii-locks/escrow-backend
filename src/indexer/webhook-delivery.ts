import { getDb, getSubscriptions, EventRow } from "./db.js";
import logger from "../utils/logger.js";

const MAX_RETRIES = 3;
const BACKOFF_MS = [500, 1500, 4500];

interface DeliveryResult {
  subscriptionId: number;
  webhookUrl: string;
  eventId: number;
  success: boolean;
  attempts: number;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliverToUrl(
  webhookUrl: string,
  event: EventRow
): Promise<boolean> {
  const payload = {
    event_type: event.event_type,
    contract_id: event.contract_id,
    ledger_sequence: event.ledger_sequence,
    timestamp: event.timestamp,
    data: JSON.parse(event.data_json),
  };

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function deliverEventToSubscriber(
  webhookUrl: string,
  event: EventRow,
  subscriptionId: number
): Promise<DeliveryResult> {
  let success = false;
  let lastError: string | undefined;
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    attemptsMade = attempt;
    success = await deliverToUrl(webhookUrl, event);
    if (success) break;

    lastError = `Attempt ${attempt}/${MAX_RETRIES} failed`;
    logger.warn(`Webhook delivery failed`, {
      webhookUrl,
      eventId: event.id,
      attempt,
    });

    if (attempt < MAX_RETRIES) {
      await sleep(BACKOFF_MS[attempt - 1] || BACKOFF_MS[0]);
    }
  }

  return {
    subscriptionId,
    webhookUrl,
    eventId: event.id,
    success,
    attempts: attemptsMade,
    error: success ? undefined : lastError,
  };
}

function subscriptionsMatchEvent(
  eventTypes: string,
  eventType: string
): boolean {
  if (eventTypes === "*") return true;
  try {
    const types = JSON.parse(eventTypes) as string[];
    return types.includes(eventType);
  } catch {
    return eventTypes === eventType;
  }
}

export async function deliverWebhooks(
  startLedger: number,
  endLedger: number
): Promise<DeliveryResult[]> {
  const db = getDb();
  const subscriptions = getSubscriptions();
  if (subscriptions.length === 0) return [];

  const events = db
    .prepare(
      `SELECT * FROM events
       WHERE ledger_sequence >= ? AND ledger_sequence <= ?
       ORDER BY ledger_sequence ASC`
    )
    .all(startLedger, endLedger) as EventRow[];

  if (events.length === 0) return [];

  const results: DeliveryResult[] = [];

  for (const event of events) {
    for (const sub of subscriptions) {
      if (
        sub.contract_id !== event.contract_id ||
        !subscriptionsMatchEvent(sub.event_types, event.event_type)
      ) {
        continue;
      }

      const result = await deliverEventToSubscriber(
        sub.webhook_url,
        event,
        sub.id
      );
      results.push(result);

      if (result.success) {
        logger.info(`Webhook delivered`, {
          subscriptionId: sub.id,
          eventId: event.id,
          webhookUrl: sub.webhook_url,
        });
      } else {
        logger.error(`Webhook delivery failed after ${MAX_RETRIES} attempts`, {
          subscriptionId: sub.id,
          eventId: event.id,
          webhookUrl: sub.webhook_url,
        });
      }
    }
  }

  return results;
}
