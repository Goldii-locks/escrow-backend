import { randomUUID } from "crypto";
import { getDb, getSubscriptions, EventDbRow } from "./db.js";
import logger from "../utils/logger.js";

const MAX_RETRIES = 3;
const BACKOFF_MS = [500, 1500, 4500];

/**
 * Number of ledgers scanned per query inside deliverWebhooks (#690). Paging
 * the range keeps peak memory bounded even after long downtime, when the
 * range to deliver can span thousands of ledgers.
 */
const WEBHOOK_DELIVERY_LEDGER_PAGE_SIZE =
  parseInt(process.env.WEBHOOK_DELIVERY_PAGE_SIZE || "500", 10) || 500;

/**
 * Webhook payload envelope version. Bump this integer whenever the shape of
 * the delivered payload changes in a breaking way so subscribers can tell
 * which schema they received (see `docs/webhooks.md`).
 *
 * v1: initial versioned envelope
 * (`{ version, event_type, contract_id, ledger_sequence, timestamp, data }`).
 * `event_id` was added later as an additive, non-breaking field (#676).
 */
export const WEBHOOK_PAYLOAD_VERSION = 1;

/** Idempotency headers attached to every webhook POST (#676). */
export const WEBHOOK_EVENT_ID_HEADER = "X-Milesto-Event-Id";
export const WEBHOOK_DELIVERY_ID_HEADER = "X-Milesto-Delivery-Id";
export const WEBHOOK_DELIVERY_ATTEMPT_HEADER = "X-Milesto-Delivery-Attempt";

/**
 * Stable identifier for an on-chain event, derived from the events table's
 * natural key `(contract_id, ledger_sequence, event_type)`. Unlike the
 * autoincrement row id it survives a re-index, so subscribers can dedupe on
 * it across redeliveries.
 */
export function webhookEventId(event: EventDbRow): string {
  return `${event.contract_id}:${event.ledger_sequence}:${event.event_type}`;
}

/** Identifies one attempt within a logical delivery (event → subscriber). */
export interface DeliveryAttempt {
  /** Constant across every retry of the same logical delivery. */
  deliveryId: string;
  /** 1-based attempt number. */
  attempt: number;
}

interface DeliveryResult {
  subscriptionId: number;
  webhookUrl: string;
  eventId: number;
  /** Delivery id sent in `X-Milesto-Delivery-Id` on every attempt. */
  deliveryId: string;
  success: boolean;
  attempts: number;
  error?: string;
  /** HTTP status of the last attempt, when the request reached the server. */
  status?: number;
  /** Machine-readable failure cause (e.g. HTTP status or `fetch` error code). */
  errorCode?: string;
  /** Wall-clock duration of the last attempt in milliseconds. */
  durationMs?: number;
}

/**
 * Outcome of a single webhook POST attempt, including the details the
 * retrier and operators need: HTTP status, a machine-readable error code,
 * and how long the attempt took.
 */
export interface DeliveryOutcome {
  ok: boolean;
  status?: number;
  errorCode?: string;
  durationMs: number;
}

/**
 * Extract a machine-readable failure code from a `fetch` rejection.
 *
 * Undici surfaces transport failures as an `Error` whose `.cause` is the
 * underlying system error (e.g. `{ code: "ENOTFOUND" }` for DNS, `"code":
 * "ECONNREFUSED"` for a refused connection, `"code": "UND_ERR_CONNECT_TIMEOUT"`
 * for timeouts). Prefer that code; otherwise fall back to the error name.
 */
export function getFetchErrorCode(err: unknown): string {
  if (err !== null && typeof err === "object") {
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== null && typeof cause === "object") {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === "string" && code.length > 0) {
        return code;
      }
      if (cause instanceof Error && cause.name) {
        return cause.name;
      }
    }
  }
  if (err instanceof Error && err.name) {
    return err.name;
  }
  return "UNKNOWN_ERROR";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POSTs one event to one URL. Callers retrying a delivery must pass the same
 * `deliveryId` with an incremented `attempt`; a standalone call is treated
 * as attempt 1 of a new delivery.
 */
export async function deliverToUrl(
  webhookUrl: string,
  event: EventDbRow,
  delivery: DeliveryAttempt = { deliveryId: randomUUID(), attempt: 1 }
): Promise<DeliveryOutcome> {
  const startedAt = Date.now();
  const eventId = webhookEventId(event);
  const payload = {
    version: WEBHOOK_PAYLOAD_VERSION,
    event_id: eventId,
    event_type: event.event_type,
    contract_id: event.contract_id,
    ledger_sequence: event.ledger_sequence,
    timestamp: event.timestamp,
    data: JSON.parse(event.data_json),
  };

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [WEBHOOK_EVENT_ID_HEADER]: eventId,
        [WEBHOOK_DELIVERY_ID_HEADER]: delivery.deliveryId,
        [WEBHOOK_DELIVERY_ATTEMPT_HEADER]: String(delivery.attempt),
      },
      body: JSON.stringify(payload),
    });
    return {
      ok: response.ok,
      status: response.status,
      errorCode: response.ok ? undefined : `HTTP_${response.status}`,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      errorCode: getFetchErrorCode(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function deliverEventToSubscriber(
  webhookUrl: string,
  event: EventDbRow,
  subscriptionId: number
): Promise<DeliveryResult> {
  let success = false;
  let lastError: string | undefined;
  let attemptsMade = 0;

  let lastOutcome: DeliveryOutcome | undefined;
  // One logical delivery: every retry carries the same delivery id.
  const deliveryId = randomUUID();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    attemptsMade = attempt;
    const outcome = await deliverToUrl(webhookUrl, event, { deliveryId, attempt });
    lastOutcome = outcome;
    success = outcome.ok;
    if (success) break;

    lastError = `Attempt ${attempt}/${MAX_RETRIES} failed`;
    logger.warn("Webhook delivery failed", {
      webhookUrl,
      eventId: event.id,
      deliveryId,
      attempt,
      status: outcome.status,
      errorCode: outcome.errorCode,
      durationMs: outcome.durationMs,
    });

    if (attempt < MAX_RETRIES) {
      await sleep(BACKOFF_MS[attempt - 1] || BACKOFF_MS[0]);
    }
  }

  return {
    subscriptionId,
    webhookUrl,
    eventId: event.id,
    deliveryId,
    success,
    attempts: attemptsMade,
    error: success ? undefined : lastError,
    status: lastOutcome?.status,
    errorCode: lastOutcome?.errorCode,
    durationMs: lastOutcome?.durationMs,
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

  // Subscriptions are few; load them once and group by contract so each
  // event only meets the subscriptions for its own contract (#690).
  const subscriptionsByContract = new Map<string, ReturnType<typeof getSubscriptions>>();
  for (const sub of getSubscriptions()) {
    const list = subscriptionsByContract.get(sub.contract_id) ?? [];
    list.push(sub);
    subscriptionsByContract.set(sub.contract_id, list);
  }
  if (subscriptionsByContract.size === 0) return [];

  // Only events for subscribed contracts are read, so the SQL engine skips
  // every other contract's rows before they reach application memory.
  const contractIds = [...subscriptionsByContract.keys()];
  const placeholders = contractIds.map(() => "?").join(", ");
  const pageQuery = db.prepare(
    `SELECT * FROM events
     WHERE ledger_sequence >= ? AND ledger_sequence <= ?
       AND contract_id IN (${placeholders})
     ORDER BY ledger_sequence ASC, id ASC`
  );

  const results: DeliveryResult[] = [];

  for (
    let pageStart = startLedger;
    pageStart <= endLedger;
    pageStart += WEBHOOK_DELIVERY_LEDGER_PAGE_SIZE
  ) {
    const pageEnd = Math.min(pageStart + WEBHOOK_DELIVERY_LEDGER_PAGE_SIZE - 1, endLedger);
    const events = pageQuery.all(pageStart, pageEnd, ...contractIds) as EventDbRow[];

    for (const event of events) {
      for (const sub of subscriptionsByContract.get(event.contract_id) ?? []) {
        if (!subscriptionsMatchEvent(sub.event_types, event.event_type)) {
          continue;
        }

        const result = await deliverEventToSubscriber(
          sub.webhook_url,
          event,
          sub.id
        );
        results.push(result);

        if (result.success) {
          logger.info("Webhook delivered", {
            subscriptionId: sub.id,
            eventId: event.id,
            deliveryId: result.deliveryId,
            webhookUrl: sub.webhook_url,
            status: result.status,
            durationMs: result.durationMs,
          });
        } else {
          logger.error("Webhook delivery failed after all attempts", {
            subscriptionId: sub.id,
            eventId: event.id,
            deliveryId: result.deliveryId,
            webhookUrl: sub.webhook_url,
            status: result.status,
            errorCode: result.errorCode,
            durationMs: result.durationMs,
          });
        }
      }
    }
  }

  return results;
}
