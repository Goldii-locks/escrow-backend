import { getDb, getSubscriptions, EventDbRow } from "./db.js";
import logger from "../utils/logger.js";
import { assertDeliveryTargetAllowed } from "../utils/webhook-url-guard.js";

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
 */
export const WEBHOOK_PAYLOAD_VERSION = 1;

interface DeliveryResult {
  subscriptionId: number;
  webhookUrl: string;
  eventId: number;
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

export async function deliverToUrl(
  webhookUrl: string,
  event: EventDbRow
): Promise<DeliveryOutcome> {
  const startedAt = Date.now();

  // Re-check the target before every attempt (#605). The subscribe-time
  // validation is not enough: DNS can be re-pointed at an internal address
  // after the subscription exists.
  const targetCheck = await assertDeliveryTargetAllowed(webhookUrl);
  if (!targetCheck.ok) {
    logger.warn("Webhook delivery blocked by URL guard", {
      webhookUrl,
      eventId: event.id,
      reason: targetCheck.error,
    });
    return {
      ok: false,
      errorCode: "BLOCKED_URL",
      durationMs: Date.now() - startedAt,
    };
  }

  const payload = {
    version: WEBHOOK_PAYLOAD_VERSION,
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
      // A public URL must not be able to bounce the request to an internal
      // one: any 3xx is a failed attempt, never followed (#605).
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        status: response.status,
        errorCode: `REDIRECT_${response.status}`,
        durationMs: Date.now() - startedAt,
      };
    }

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

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    attemptsMade = attempt;
    const outcome = await deliverToUrl(webhookUrl, event);
    lastOutcome = outcome;
    success = outcome.ok;
    if (success) break;

    lastError = `Attempt ${attempt}/${MAX_RETRIES} failed`;
    logger.warn("Webhook delivery failed", {
      webhookUrl,
      eventId: event.id,
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
            webhookUrl: sub.webhook_url,
            status: result.status,
            durationMs: result.durationMs,
          });
        } else {
          logger.error("Webhook delivery failed after all attempts", {
            subscriptionId: sub.id,
            eventId: event.id,
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
