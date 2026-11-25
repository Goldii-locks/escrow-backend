/**
 * Contract email notification delivery (#…).
 *
 * Emails are delivered from their own ordered queue, separate from the
 * webhook delivery queue (#682) so a slow SMTP server can never delay – or be
 * delayed by – subscriber webhooks. Only `active` subscriptions receive event
 * emails: `pending` rows have not confirmed their address and `unsubscribed`
 * rows have opted out.
 *
 * The whole pipeline is a clean no-op when SMTP_URL/EMAIL_FROM are unset
 * (`emailDeliveryEnabled()` is false), so an unconfigured deployment simply
 * never sends mail.
 */

import {
  EventDbRow,
  EmailSubscription,
  getActiveEmailSubscriptions,
  getDb,
} from "./db.js";
import { emailDeliveryEnabled, sendMail } from "../utils/mailer.js";
import {
  EMAIL_EVENT_TYPE_ALIASES,
  EmailNotificationType,
  notificationTypeFor,
  renderEventEmail,
} from "../utils/email-templates.js";
import { config } from "../config.js";
import logger from "../utils/logger.js";

/** Ledgers scanned per query, bounding peak memory on long-downtime ranges. */
const EMAIL_DELIVERY_LEDGER_PAGE_SIZE = 500;

let emailDeliveryTail: Promise<void> = Promise.resolve();

/** Reset the email delivery queue (used by tests). */
export function resetEmailDeliveryQueueForTests(): void {
  emailDeliveryTail = Promise.resolve();
}

/**
 * Queue delivery of `[startLedger, endLedger]` behind every earlier range.
 * A failed run is logged and never stalls later ranges; the returned promise
 * settles when this range's delivery has finished and never rejects.
 */
export function enqueueEmailNotificationDelivery(
  startLedger: number,
  endLedger: number,
): Promise<void> {
  const run = emailDeliveryTail
    .then(() => deliverEmailNotifications(startLedger, endLedger))
    .then(
      () => undefined,
      (err) => {
        logger.error("Error delivering email notifications", {
          error: err instanceof Error ? err.message : String(err),
          startLedger,
          endLedger,
        });
      },
    );
  emailDeliveryTail = run;
  return run;
}

/** Absolute one-click opt-out link placed in every outgoing email. */
export function emailUnsubscribeUrl(token: string): string {
  const base = config.publicBaseUrl.replace(/\/+$/, "");
  return `${base}/unsubscribe?token=${encodeURIComponent(token)}`;
}

/** Absolute confirmation link sent with the initial subscription email. */
export function emailConfirmUrl(token: string): string {
  const base = config.publicBaseUrl.replace(/\/+$/, "");
  return `${base}/api/notifications/email/confirm?token=${encodeURIComponent(token)}`;
}

function parseEventData(dataJson: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(dataJson);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return null;
}

function eventMilestoneIndex(data: Record<string, unknown> | null): number | null {
  if (!data) return null;
  for (const key of ["milestone_index", "milestoneIndex"]) {
    const value = data[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return parseInt(value, 10);
  }
  return null;
}

/**
 * Whether a subscription's stored `event_types` covers a notification type.
 * `*` matches everything; otherwise the list may name the notification type,
 * one of its indexed-event aliases, or the raw event type.
 */
export function emailEventTypesMatch(
  eventTypes: string,
  notificationType: EmailNotificationType,
  rawEventType: string,
): boolean {
  if (eventTypes === "*") return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(eventTypes);
  } catch {
    return eventTypes === rawEventType;
  }
  if (!Array.isArray(parsed)) return false;
  const types = parsed.filter((value): value is string => typeof value === "string");
  if (types.includes("*")) return true;
  if (types.includes(notificationType)) return true;
  if (types.includes(rawEventType)) return true;
  return EMAIL_EVENT_TYPE_ALIASES[notificationType].some((alias) =>
    types.includes(alias),
  );
}

/**
 * Deliver event emails for every active subscription in `[startLedger,
 * endLedger]`. Returns the number of emails sent. Never throws for a single
 * failed send (sendMail swallows transport errors).
 */
export async function deliverEmailNotifications(
  startLedger: number,
  endLedger: number,
): Promise<number> {
  if (!emailDeliveryEnabled()) return 0;

  const subscriptionsByContract = new Map<string, EmailSubscription[]>();
  for (const sub of getActiveEmailSubscriptions()) {
    const list = subscriptionsByContract.get(sub.contract_id) ?? [];
    list.push(sub);
    subscriptionsByContract.set(sub.contract_id, list);
  }
  if (subscriptionsByContract.size === 0) return 0;

  const db = getDb();
  const contractIds = [...subscriptionsByContract.keys()];
  const placeholders = contractIds.map(() => "?").join(", ");
  const pageQuery = db.prepare(
    `SELECT * FROM events
     WHERE ledger_sequence >= ? AND ledger_sequence <= ?
       AND contract_id IN (${placeholders})
     ORDER BY ledger_sequence ASC, id ASC`,
  );

  let sent = 0;
  for (
    let pageStart = startLedger;
    pageStart <= endLedger;
    pageStart += EMAIL_DELIVERY_LEDGER_PAGE_SIZE
  ) {
    const pageEnd = Math.min(
      pageStart + EMAIL_DELIVERY_LEDGER_PAGE_SIZE - 1,
      endLedger,
    );
    const events = pageQuery.all(pageStart, pageEnd, ...contractIds) as EventDbRow[];

    for (const event of events) {
      const notificationType = notificationTypeFor(event.event_type);
      if (!notificationType) continue;

      const data = parseEventData(event.data_json);
      const milestoneIndex = eventMilestoneIndex(data);

      for (const sub of subscriptionsByContract.get(event.contract_id) ?? []) {
        if (sub.status !== "active") continue;
        if (
          !emailEventTypesMatch(
            sub.event_types,
            notificationType,
            event.event_type,
          )
        ) {
          continue;
        }

        const rendered = renderEventEmail({
          notificationType,
          contractId: event.contract_id,
          eventType: event.event_type,
          ledger: event.ledger_sequence,
          milestoneIndex,
          unsubscribeUrl: emailUnsubscribeUrl(sub.unsubscribe_token),
        });

        const ok = await sendMail({
          to: sub.email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
        });
        if (ok) {
          sent++;
          logger.info("Email notification delivered", {
            subscriptionId: sub.id,
            contractId: event.contract_id,
            eventId: event.id,
            notificationType,
          });
        }
      }
    }
  }

  return sent;
}
