import { createHash, randomUUID } from "crypto";
import {
  getDb,
  getActiveSubscriptionsForDelivery,
  advanceSubscriptionCursor,
  recordSubscriptionFailure,
  recordSubscriptionSuccess,
  EventDbRow,
} from "./db.js";
import logger from "../utils/logger.js";
import { assertDeliveryTargetAllowed } from "../utils/webhook-url-guard.js";
import { signPayload } from "../utils/webhook_signature_verifier.js";

/**
 * Default number of subscriptions delivered to at the same time (#851).
 * Each subscription has its own ordered queue, so one unreachable receiver
 * only occupies one slot instead of delaying every other subscriber.
 * Override with WEBHOOK_DELIVERY_CONCURRENCY.
 */
export const DEFAULT_WEBHOOK_DELIVERY_CONCURRENCY = 4;

/** Read per call so a deployment (or a test) can change it at runtime. */
function webhookDeliveryConcurrency(): number {
  const configured = Number.parseInt(process.env.WEBHOOK_DELIVERY_CONCURRENCY ?? "", 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_WEBHOOK_DELIVERY_CONCURRENCY;
}

/**
 * Default per-attempt timeout for an outbound webhook POST (#606).
 *
 * Undici has no overall deadline of its own: a receiver that accepts the
 * connection and then never writes a response would pin the attempt forever.
 * Each subscription's queue is sequential, so such a receiver would hold its
 * queue and a delivery slot forever. Override with WEBHOOK_TIMEOUT_MS.
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
 * Number of events read per query for one subscription inside
 * deliverWebhooks (#690, #850). Paging keeps peak memory bounded even after
 * long downtime, when the backlog behind a cursor can be large.
 */
const WEBHOOK_DELIVERY_PAGE_SIZE =
  parseInt(process.env.WEBHOOK_DELIVERY_PAGE_SIZE || "500", 10) || 500;

/**
 * Subscription opt-out is not yet supported by the live delivery path. The
 * unreachable `src/indexer/webhook_dispatcher.ts` module that claimed this
 * feature has been removed; this constant documents that there is exactly
 * one webhook dispatcher (this module plus `src/utils/webhook_dispatcher.ts`
 * for subscription management).
 */
export const WEBHOOK_DISPATCHER_MODULE = "webhook-delivery";

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

/**
 * POSTs one event to one URL. Callers retrying a delivery must pass the same
 * `deliveryId` with an incremented `attempt`; a standalone call is treated
 * as attempt 1 of a new delivery.
 *
 * When `signingSecret` is given, the exact body string sent is signed with
 * HMAC-SHA256 (`signPayload`) and the `X-Webhook-Timestamp` /
 * `X-Webhook-Signature` headers are attached (#849). The timestamp is taken
 * per call, so every retry is signed again with a fresh timestamp.
 */
export async function deliverToUrl(
  webhookUrl: string,
  event: EventDbRow,
  delivery: DeliveryAttempt = { deliveryId: randomUUID(), attempt: 1 },
  signingSecret?: string | null
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
  } catch {
    return {
      ok: false,
      errorCode: "PAYLOAD_PARSE_ERROR",
      durationMs: Date.now() - startedAt,
    };
  }

  // Sign the exact string that is sent: any re-serialization on the way
  // would break the receiver's verification (#849).
  const body = JSON.stringify(payload);
  let signatureHeaders: Record<string, string> = {};
  if (signingSecret) {
    try {
      signatureHeaders = signPayload(body, signingSecret).headers;
    } catch {
      // Never include the secret or the error detail in logs (#849).
      logger.error("Webhook delivery could not be signed", {
        webhookUrl,
        eventId: event.id,
      });
      return {
        ok: false,
        errorCode: "SIGNING_ERROR",
        durationMs: Date.now() - startedAt,
      };
    }
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [WEBHOOK_EVENT_ID_HEADER]: eventId,
        [WEBHOOK_DELIVERY_ID_HEADER]: delivery.deliveryId,
        [WEBHOOK_DELIVERY_ATTEMPT_HEADER]: String(delivery.attempt),
        ...signatureHeaders,
      },
      body,
      // A public URL must not be able to bounce the request to an internal
      // one: any 3xx is a failed attempt, never followed (#605).
      redirect: "manual",
      // Hard per-attempt deadline: a receiver that never answers must fail
      // the attempt instead of holding its subscription's queue (#606).
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
 * Run `worker` over `items` with at most `limit` running at once (#851).
 * A worker that throws is logged and does not stop the others.
 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const runners = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      while (next < items.length) {
        const item = items[next++];
        try {
          await worker(item);
        } catch (err) {
          logger.error("Webhook delivery worker failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  );
  await Promise.all(runners);
}

/** The subscription fields the delivery loop needs. */
interface DeliverySubscription {
  id: number;
  webhook_url: string;
  signing_secret?: string | null;
}

/**
 * Update the subscription's failure counter after an attempt (#701) and log
 * the outcome. The signing secret is never logged (#849).
 */
function recordSubscriptionOutcome(
  sub: DeliverySubscription,
  result: DeliveryResult
): void {
  if (result.success) {
    // A successful delivery clears the failure history (#701).
    recordSubscriptionSuccess(sub.id);
    logger.info("Webhook delivered", {
      subscriptionId: sub.id,
      eventId: result.eventId,
      deliveryId: result.deliveryId,
      webhookUrl: sub.webhook_url,
      attempt: result.attempts,
      status: result.status,
      durationMs: result.durationMs,
    });
    return;
  }

  const failure = recordSubscriptionFailure(
    sub.id,
    result.error ?? result.errorCode ?? "delivery failed",
    WEBHOOK_DISABLE_AFTER,
  );
  logger.warn("Webhook delivery failed; queued for retry", {
    subscriptionId: sub.id,
    eventId: result.eventId,
    deliveryId: result.deliveryId,
    webhookUrl: sub.webhook_url,
    attempt: result.attempts,
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

/**
 * Make one signed attempt to deliver `event` to `sub`. There are no inline
 * retries (#851): a failed attempt is persisted as a `failed` outbox row and
 * retried by `retryFailedDeliveries` after its backoff.
 *
 * With `advanceCursor`, the outbox row and the subscription's delivery
 * cursor are written in one transaction (#850), so after a restart the
 * event is neither lost nor handed to the receiver twice.
 */
async function attemptDelivery(
  sub: DeliverySubscription,
  event: EventDbRow,
  attempt: number,
  advanceCursor: boolean
): Promise<DeliveryResult> {
  // One logical delivery: every attempt carries the same delivery id.
  const deliveryId = webhookDeliveryId(sub.id, event.id);

  let result: DeliveryResult;
  try {
    const outcome = await deliverToUrl(
      sub.webhook_url,
      event,
      { deliveryId, attempt },
      sub.signing_secret
    );
    result = {
      subscriptionId: sub.id,
      webhookUrl: sub.webhook_url,
      eventId: event.id,
      deliveryId,
      success: outcome.ok,
      attempts: attempt,
      error: outcome.ok ? undefined : `Attempt ${attempt} failed`,
      status: outcome.status,
      errorCode: outcome.errorCode,
      durationMs: outcome.durationMs,
    };
  } catch (err) {
    // One throwing subscriber must not skip the rest of the queue (#611).
    result = {
      subscriptionId: sub.id,
      webhookUrl: sub.webhook_url,
      eventId: event.id,
      deliveryId,
      success: false,
      attempts: attempt,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const db = getDb();
  db.transaction(() => {
    recordDeliveryOutcome(
      sub.id,
      event.id,
      result.success,
      result.attempts,
      result.success ? undefined : (result.errorCode ?? result.error)
    );
    if (advanceCursor) {
      advanceSubscriptionCursor(sub.id, event.id);
    }
  })();

  recordSubscriptionOutcome(sub, result);
  return result;
}

/**
 * Periodic sweep: retry failed rows whose backoff has expired, with
 * exponential backoff up to a maximum age, then mark them dead (#611).
 * Called at the start of every deliverWebhooks cycle so a subscriber that
 * was down for one cycle receives the missed event on the next one.
 *
 * Rows are grouped per subscription and retried in event order; a
 * subscription stops at its first failure so later events never overtake
 * an earlier one. Subscriptions are retried in parallel, bounded by
 * WEBHOOK_DELIVERY_CONCURRENCY (#851). Every retry is signed again with a
 * fresh timestamp (#849).
 */
export async function retryFailedDeliveries(): Promise<number> {
  try {
    ensureDeliveriesTable();
  } catch {
    return 0;
  }
  const db = getDb();
  const now = Date.now();
  type RetryRow = {
    subscription_id: number;
    event_id: number;
    attempts: number;
    last_error: string | null;
  };
  let rows: RetryRow[];
  try {
    rows = db
      .prepare(
        `SELECT subscription_id, event_id, attempts, last_error
         FROM webhook_deliveries
         WHERE status = 'failed' AND next_attempt_at IS NOT NULL
           AND next_attempt_at <= ?
         ORDER BY subscription_id ASC, event_id ASC
         LIMIT 100`
      )
      .all(now) as RetryRow[];
  } catch {
    return 0;
  }
  if (rows.length === 0) return 0;

  // Typed explicitly: both are captured by the per-subscription workers.
  let eventStmt: ReturnType<typeof db.prepare>;
  let subStmt: ReturnType<typeof db.prepare>;
  try {
    eventStmt = db.prepare(`SELECT * FROM events WHERE id = ?`);
    subStmt = db.prepare(`SELECT * FROM webhook_subscriptions WHERE id = ?`);
  } catch {
    return 0;
  }

  const markDead = (row: RetryRow, reason?: string): void => {
    try {
      if (reason) {
        db.prepare(
          `UPDATE webhook_deliveries SET status = 'dead', last_error = ?,
             updated_at = CURRENT_TIMESTAMP
           WHERE subscription_id = ? AND event_id = ?`
        ).run(reason, row.subscription_id, row.event_id);
      } else {
        db.prepare(
          `UPDATE webhook_deliveries SET status = 'dead', updated_at = CURRENT_TIMESTAMP
           WHERE subscription_id = ? AND event_id = ?`
        ).run(row.subscription_id, row.event_id);
      }
    } catch {
      /* ignore */
    }
  };

  const rowsBySubscription = new Map<number, RetryRow[]>();
  for (const row of rows) {
    const list = rowsBySubscription.get(row.subscription_id) ?? [];
    list.push(row);
    rowsBySubscription.set(row.subscription_id, list);
  }

  let redelivered = 0;
  await runWithConcurrency(
    [...rowsBySubscription.values()],
    webhookDeliveryConcurrency(),
    async (subRows) => {
      for (const row of subRows) {
        let event: EventDbRow | undefined;
        let sub: DeliverySubscription | undefined;
        try {
          event = eventStmt.get(row.event_id) as EventDbRow | undefined;
          sub = subStmt.get(row.subscription_id) as DeliverySubscription | undefined;
        } catch {
          continue;
        }
        if (!event || !sub) {
          markDead(row, "event or subscription gone");
          continue;
        }
        // Expire rows older than the max age instead of retrying forever.
        const eventAgeMs = Date.now() - new Date(event.created_at).getTime();
        if (
          row.attempts >= WEBHOOK_MAX_DELIVERY_ATTEMPTS ||
          (!Number.isNaN(eventAgeMs) && eventAgeMs > WEBHOOK_RETRY_MAX_AGE_MS)
        ) {
          markDead(row);
          continue;
        }
        const result = await attemptDelivery(sub, event, row.attempts + 1, false);
        if (!result.success) {
          // Keep per-subscriber order: later rows wait for this one.
          return;
        }
        redelivered++;
      }
    }
  );
  return redelivered;
}

/**
 * Whether the subscription has a delivery still waiting in the retry path.
 * New events are held back until it clears, so a receiver never gets a
 * later event before an earlier one (#851).
 */
function hasPendingRetry(subscriptionId: number): boolean {
  try {
    ensureDeliveriesTable();
    return (
      getDb()
        .prepare(
          `SELECT 1 FROM webhook_deliveries
           WHERE subscription_id = ? AND status = 'failed' LIMIT 1`
        )
        .get(subscriptionId) !== undefined
    );
  } catch {
    return false;
  }
}

function subscriptionsMatchEvent(
  eventTypes: string,
  eventType: string
): boolean {
  if (eventTypes === "*") return true;
  try {
    const types = JSON.parse(eventTypes) as string[];
    return types.includes("*") || types.includes(eventType);
  } catch {
    return eventTypes === eventType;
  }
}

/**
 * Deliver one subscription's queue: every event for its contract with an id
 * above the subscription's persisted cursor, in id order (#850). The queue
 * stops at the first failed attempt; that event is retried by the persisted
 * retry path and the rest of the queue follows once it clears (#851).
 */
async function deliverSubscriptionQueue(
  sub: ReturnType<typeof getActiveSubscriptionsForDelivery>[number],
  results: DeliveryResult[]
): Promise<void> {
  if (hasPendingRetry(sub.id)) return;

  const pageQuery = getDb().prepare(
    `SELECT * FROM events
     WHERE contract_id = ? AND id > ?
     ORDER BY id ASC
     LIMIT ?`
  );

  let cursor = sub.last_delivered_event_id ?? 0;
  // Highest id of a skipped (non-matching) event not yet persisted.
  let skippedTo = cursor;
  try {
    for (;;) {
      const events = pageQuery.all(
        sub.contract_id,
        cursor,
        WEBHOOK_DELIVERY_PAGE_SIZE
      ) as EventDbRow[];
      if (events.length === 0) return;

      for (const event of events) {
        cursor = event.id;
        if (!subscriptionsMatchEvent(sub.event_types, event.event_type)) {
          skippedTo = event.id;
          continue;
        }
        const result = await attemptDelivery(sub, event, 1, true);
        // The cursor now covers this event and every skipped one before it.
        skippedTo = event.id;
        results.push(result);
        if (!result.success) return;
      }
    }
  } finally {
    if (skippedTo > (sub.last_delivered_event_id ?? 0)) {
      try {
        advanceSubscriptionCursor(sub.id, skippedTo);
      } catch (err) {
        logger.warn("Failed to advance webhook delivery cursor", {
          subscriptionId: sub.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/**
 * Deliver every stored event that has not yet been handed to its
 * subscribers.
 *
 * Delivery is driven by each subscription's persisted cursor
 * (`last_delivered_event_id`, #850), not by the ledger range: events
 * indexed before a restart are delivered by the first run after it. The
 * `startLedger` / `endLedger` arguments only identify the poll that
 * triggered the run and are kept for callers and logs.
 *
 * Each subscription has its own ordered queue, and queues run in parallel
 * bounded by WEBHOOK_DELIVERY_CONCURRENCY (#851), so an unreachable
 * subscriber no longer delays healthy ones.
 */
export async function deliverWebhooks(
  _startLedger?: number,
  _endLedger?: number
): Promise<DeliveryResult[]> {
  // Retry previously failed deliveries first, so a subscriber that was down
  // for one cycle receives the missed events on the next cycle (#611).
  try {
    await retryFailedDeliveries();
  } catch (err) {
    logger.warn("Webhook retry sweep failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Auto-disabled subscriptions are skipped: their endpoint is permanently
  // dead (#701).
  const subscriptions = getActiveSubscriptionsForDelivery();
  if (subscriptions.length === 0) return [];

  const results: DeliveryResult[] = [];
  await runWithConcurrency(
    subscriptions,
    webhookDeliveryConcurrency(),
    (sub) => deliverSubscriptionQueue(sub, results)
  );
  return results;
}
