import { createHash, randomUUID } from "crypto";
import {
  getDb,
  getActiveSubscriptions,
  recordSubscriptionFailure,
  recordSubscriptionSuccess,
  EventDbRow,
} from "./db.js";
import logger from "../utils/logger.js";
import { assertDeliveryTargetAllowed } from "../utils/webhook-url-guard.js";

const MAX_RETRIES = 3;
const BACKOFF_MS = [500, 1500, 4500];

/**
 * Default per-attempt timeout for an outbound webhook POST (#606).
 *
 * Undici has no overall deadline of its own: a receiver that accepts the
 * connection and then never writes a response would pin the attempt forever.
 * Because delivery is sequential, one such subscriber would starve every
 * other subscriber behind it. Override with WEBHOOK_TIMEOUT_MS.
 */
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 5000;

/**
 * Read the timeout per attempt so a deployment (or a test) can change it
 * without reloading the module. Invalid or non-positive values fall back to
 * the default.
 */
function webhookTimeoutMs(): number {
  const configured = Number.parseInt(process.env.WEBHOOK_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_WEBHOOK_TIMEOUT_MS;
}

/**
 * Number of consecutive failed deliveries after which a subscription is
 * auto-disabled (#701). A permanently dead endpoint (expired domain, removed
 * route) used to be retried for every matching event, forever, delaying every
 * healthy subscriber behind it in the sequential delivery loop.
 */
export const WEBHOOK_DISABLE_AFTER = Math.max(
  1,
  parseInt(process.env.WEBHOOK_DISABLE_AFTER || "50", 10) || 50,
);

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
 * The transaction hash (`tx_hash` / `txHash`) was added the same way (#700),
 * so the envelope version is unchanged.
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
  // Prefer the stored RPC event id (#607); rows without one fall back to the
  // natural key.
  return (
    event.event_id ??
    `${event.contract_id}:${event.ledger_sequence}:${event.event_type}`
  );
}

/**
 * Delivery id for one event → subscriber pair (#676). Failed deliveries are
 * retried by later sweeps from the webhook_deliveries outbox (#611), so the
 * id is derived from that pair rather than drawn at random: every retry,
 * in-process or swept, carries the same id. Formatted as a version-4 UUID.
 */
export function webhookDeliveryId(subscriptionId: number, eventRowId: number): string {
  const hex = createHash("sha256")
    .update(`webhook-delivery:${subscriptionId}:${eventRowId}`)
    .digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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
      // AbortSignal.timeout aborts with a DOMException named "TimeoutError".
      // DOMException is not an Error instance, so accept the name from any
      // object before falling back.
      const causeName = (cause as { name?: unknown }).name;
      if (typeof causeName === "string" && causeName.length > 0) {
        return causeName;
      }
    }
    // Some rejections surface the DOMException directly (e.g. when the
    // timeout signal aborts the fetch itself) rather than as `cause`.
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0 && name !== "Error") {
      return name;
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

  // Parse inside the try: one malformed row must fail only its own delivery
  // instead of rejecting the whole deliverWebhooks call (#611).
  let payload: unknown;
  try {
    payload = {
      version: WEBHOOK_PAYLOAD_VERSION,
      event_id: eventId,
      // The transaction hash lets the subscriber link the event to a block
      // explorer; `txHash` is the camel-case alias of `tx_hash` (#700).
      tx_hash: event.tx_hash ?? null,
      txHash: event.tx_hash ?? null,
      event_type: event.event_type,
      contract_id: event.contract_id,
      ledger_sequence: event.ledger_sequence,
      timestamp: event.timestamp,
      data: JSON.parse(event.data_json),
    };
  } catch (err) {
    return {
      ok: false,
      errorCode: "PAYLOAD_PARSE_ERROR",
      durationMs: Date.now() - startedAt,
    };
  }

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
      // A public URL must not be able to bounce the request to an internal
      // one: any 3xx is a failed attempt, never followed (#605).
      redirect: "manual",
      // Hard per-attempt deadline: a receiver that never answers must fail
      // the attempt instead of stalling the sequential delivery loop (#606).
      signal: AbortSignal.timeout(webhookTimeoutMs()),
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

/**
 * Retry state for failed webhook deliveries (#611).
 *
 * Failures are recorded per (subscription, event) so a subscriber that is
 * down for more than the inline backoff window still receives the event on
 * a later sweep, and operators can list dead deliveries.
 */
export const WEBHOOK_RETRY_BASE_DELAY_MS = parseInt(
  process.env.WEBHOOK_RETRY_BASE_DELAY_MS || "60000",
  10
);
export const WEBHOOK_RETRY_MAX_AGE_MS =
  parseInt(process.env.WEBHOOK_RETRY_MAX_AGE_DAYS || "7", 10) *
  24 * 60 * 60 * 1000;
export const WEBHOOK_MAX_DELIVERY_ATTEMPTS = parseInt(
  process.env.WEBHOOK_MAX_DELIVERY_ATTEMPTS || "25",
  10
);

export interface DeadDelivery {
  id: number;
  subscription_id: number;
  event_id: number;
  attempts: number;
  last_error: string | null;
  next_attempt_at: number | null;
  status: string;
}

const CREATE_DELIVERIES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id INTEGER NOT NULL,
    event_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_attempt_at INTEGER,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(subscription_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry
    ON webhook_deliveries (status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event
    ON webhook_deliveries (event_id);
`;

/** Lazily create the table so in-memory test databases work without migrations. */
function ensureDeliveriesTable(): void {
  getDb().exec(CREATE_DELIVERIES_TABLE_SQL);
}

export function computeWebhookRetryDelayMs(attempts: number): number {
  return Math.min(
    WEBHOOK_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1),
    60 * 60 * 1000
  );
}

function recordDeliveryOutcome(
  subscriptionId: number,
  eventId: number,
  success: boolean,
  attempts: number,
  lastError?: string
): void {
  try {
    ensureDeliveriesTable();
    const db = getDb();
    const now = Date.now();
    if (success) {
      db.prepare(
        `INSERT INTO webhook_deliveries
           (subscription_id, event_id, status, attempts, last_error, next_attempt_at, updated_at)
         VALUES (?, ?, 'delivered', ?, NULL, NULL, CURRENT_TIMESTAMP)
         ON CONFLICT(subscription_id, event_id) DO UPDATE SET
           status = 'delivered', attempts = excluded.attempts,
           last_error = NULL, next_attempt_at = NULL,
           updated_at = CURRENT_TIMESTAMP`
      ).run(subscriptionId, eventId, attempts);
    } else {
      db.prepare(
        `INSERT INTO webhook_deliveries
           (subscription_id, event_id, status, attempts, last_error, next_attempt_at, updated_at)
         VALUES (?, ?, 'failed', ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(subscription_id, event_id) DO UPDATE SET
           status = 'failed', attempts = excluded.attempts,
           last_error = excluded.last_error,
           next_attempt_at = excluded.next_attempt_at,
           updated_at = CURRENT_TIMESTAMP`
      ).run(
        subscriptionId,
        eventId,
        attempts,
        lastError ?? "delivery failed",
        now + computeWebhookRetryDelayMs(attempts)
      );
    }
  } catch (err) {
    logger.warn("Failed to record webhook delivery outcome", {
      subscriptionId,
      eventId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Admin visibility into permanently failed deliveries (#611). */
export function getDeadDeliveries(limit = 100): DeadDelivery[] {
  try {
    ensureDeliveriesTable();
    return getDb()
      .prepare(
        `SELECT id, subscription_id, event_id, attempts, last_error,
                next_attempt_at, status
         FROM webhook_deliveries WHERE status = 'dead'
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit) as DeadDelivery[];
  } catch {
    return [];
  }
}

export function getFailedDeliveryCount(): number {
  try {
    ensureDeliveriesTable();
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS cnt FROM webhook_deliveries WHERE status IN ('failed', 'dead')`
      )
      .get() as { cnt: number };
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Periodic sweep: retry failed rows whose backoff has expired, with
 * exponential backoff up to a maximum age, then mark them dead (#611).
 * Called at the start of every deliverWebhooks cycle so a subscriber that
 * was down for one cycle receives the missed event on the next one.
 */
export async function retryFailedDeliveries(): Promise<number> {
  try {
    ensureDeliveriesTable();
  } catch {
    return 0;
  }
  const db = getDb();
  const now = Date.now();
  let rows: Array<{
    subscription_id: number;
    event_id: number;
    attempts: number;
    last_error: string | null;
  }>;
  try {
    rows = db
      .prepare(
        `SELECT subscription_id, event_id, attempts, last_error
         FROM webhook_deliveries
         WHERE status = 'failed' AND next_attempt_at IS NOT NULL
           AND next_attempt_at <= ?
         LIMIT 100`
      )
      .all(now) as Array<{
      subscription_id: number;
      event_id: number;
      attempts: number;
      last_error: string | null;
    }>;
  } catch {
    return 0;
  }
  if (rows.length === 0) return 0;

  let eventStmt;
  let subStmt;
  try {
    eventStmt = db.prepare(`SELECT * FROM events WHERE id = ?`);
    subStmt = db.prepare(`SELECT * FROM webhook_subscriptions WHERE id = ?`);
  } catch {
    return 0;
  }

  let redelivered = 0;
  for (const row of rows) {
    let event: EventDbRow | undefined;
    let sub: { webhook_url: string } | undefined;
    try {
      event = eventStmt.get(row.event_id) as EventDbRow | undefined;
      sub = subStmt.get(row.subscription_id) as
        | { webhook_url: string }
        | undefined;
    } catch {
      continue;
    }
    if (!event || !sub) {
      try {
        db.prepare(
          `UPDATE webhook_deliveries SET status = 'dead', last_error = 'event or subscription gone',
             updated_at = CURRENT_TIMESTAMP
           WHERE subscription_id = ? AND event_id = ?`
        ).run(row.subscription_id, row.event_id);
      } catch {
        /* ignore */
      }
      continue;
    }
    // Expire rows older than the max age instead of retrying forever.
    const eventAgeMs = Date.now() - new Date(event.created_at).getTime();
    if (
      row.attempts >= WEBHOOK_MAX_DELIVERY_ATTEMPTS ||
      (!Number.isNaN(eventAgeMs) && eventAgeMs > WEBHOOK_RETRY_MAX_AGE_MS)
    ) {
      try {
        db.prepare(
          `UPDATE webhook_deliveries SET status = 'dead', updated_at = CURRENT_TIMESTAMP
           WHERE subscription_id = ? AND event_id = ?`
        ).run(row.subscription_id, row.event_id);
      } catch {
        /* ignore */
      }
      continue;
    }
    const attempts = row.attempts + 1;
    const outcome = await deliverToUrl(sub.webhook_url, event, {
      deliveryId: webhookDeliveryId(row.subscription_id, event.id),
      attempt: attempts,
    });
    if (outcome.ok) {
      recordDeliveryOutcome(row.subscription_id, row.event_id, true, attempts);
      redelivered++;
    } else {
      recordDeliveryOutcome(
        row.subscription_id,
        row.event_id,
        false,
        attempts,
        outcome.errorCode ?? "retry failed"
      );
    }
  }
  return redelivered;
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
  const deliveryId = webhookDeliveryId(subscriptionId, event.id);

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

function recordResult(result: DeliveryResult): void {
  recordDeliveryOutcome(
    result.subscriptionId,
    result.eventId,
    result.success,
    result.attempts,
    result.error ?? result.errorCode
  );
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

  // Retry previously failed deliveries first, so a subscriber that was down
  // for one cycle receives the missed events on the next cycle (#611).
  try {
    await retryFailedDeliveries();
  } catch (err) {
    logger.warn("Webhook retry sweep failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Subscriptions are few; load them once and group by contract so each
  // event only meets the subscriptions for its own contract (#690).
  // Auto-disabled subscriptions are skipped: their endpoint is permanently
  // dead and retrying it would delay every healthy subscriber (#701).
  const subscriptionsByContract = new Map<
    string,
    ReturnType<typeof getActiveSubscriptions>
  >();
  for (const sub of getActiveSubscriptions()) {
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

        // One bad row or one throwing subscriber must not skip the rest of
        // the range for every subscriber (#611).
        let result: DeliveryResult;
        try {
          result = await deliverEventToSubscriber(
            sub.webhook_url,
            event,
            sub.id
          );
        } catch (err) {
          result = {
            subscriptionId: sub.id,
            webhookUrl: sub.webhook_url,
            eventId: event.id,
            deliveryId: webhookDeliveryId(sub.id, event.id),
            success: false,
            attempts: 0,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        results.push(result);
        recordResult(result);

        if (result.success) {
          // A successful delivery clears the failure history (#701).
          recordSubscriptionSuccess(sub.id);
          logger.info("Webhook delivered", {
            subscriptionId: sub.id,
            eventId: event.id,
            deliveryId: result.deliveryId,
            webhookUrl: sub.webhook_url,
            status: result.status,
            durationMs: result.durationMs,
          });
        } else {
          const failure = recordSubscriptionFailure(
            sub.id,
            result.error ?? result.errorCode ?? "delivery failed",
            WEBHOOK_DISABLE_AFTER,
          );
          logger.error("Webhook delivery failed after all attempts", {
            subscriptionId: sub.id,
            eventId: event.id,
            deliveryId: result.deliveryId,
            webhookUrl: sub.webhook_url,
            status: result.status,
            errorCode: result.errorCode,
            durationMs: result.durationMs,
            consecutiveFailures: failure.consecutiveFailures,
            disabled: failure.disabled,
          });
          if (failure.disabled) {
            logger.warn(
              "Webhook subscription auto-disabled after repeated delivery failures",
              {
                subscriptionId: sub.id,
                webhookUrl: sub.webhook_url,
                consecutiveFailures: failure.consecutiveFailures,
                disableAfter: WEBHOOK_DISABLE_AFTER,
              },
            );
          }
        }
      }
    }
  }

  return results;
}
