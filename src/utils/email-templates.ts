/**
 * Contract email notification templates (#…).
 *
 * Plain-text and HTML bodies for the event notifications a recipient can
 * subscribe to. Every template carries the recipient's one-click
 * `/unsubscribe?token=...` link. The HTML is intentionally small and inline
 * styled so it renders in every client without an external stylesheet.
 */

/** Notification types a recipient can subscribe to. */
export const EMAIL_NOTIFICATION_TYPES = [
  "delivered",
  "approved",
  "disputed",
  "auto_release_available",
] as const;
export type EmailNotificationType = (typeof EMAIL_NOTIFICATION_TYPES)[number];

const NOTIFICATION_TYPE_SET = new Set<string>(EMAIL_NOTIFICATION_TYPES);

export function isEmailNotificationType(
  value: unknown,
): value is EmailNotificationType {
  return typeof value === "string" && NOTIFICATION_TYPE_SET.has(value);
}

/**
 * Indexed `event_type` discriminators that satisfy each notification type.
 * Contract events are stored by their short topic discriminator (`deliver`,
 * `approve`, `dispute`); `auto_release_available` has no discrete on-chain
 * event today, so it maps to its own name and will deliver if the indexer
 * ever records such a row.
 */
export const EMAIL_EVENT_TYPE_ALIASES: Record<EmailNotificationType, string[]> = {
  delivered: ["deliver", "delivered"],
  approved: ["approve", "approved"],
  disputed: ["dispute", "disputed"],
  auto_release_available: ["auto_release_available"],
};

/** Map an indexed event type to the notification type it triggers. */
export function notificationTypeFor(
  eventType: string,
): EmailNotificationType | null {
  const normalized = eventType.toLowerCase();
  for (const type of EMAIL_NOTIFICATION_TYPES) {
    if (EMAIL_EVENT_TYPE_ALIASES[type].includes(normalized)) return type;
  }
  return null;
}

/** Human-readable label per notification type. */
export const EMAIL_NOTIFICATION_LABELS: Record<EmailNotificationType, string> = {
  delivered: "Milestone delivered",
  approved: "Milestone approved",
  disputed: "Milestone disputed",
  auto_release_available: "Auto-release available",
};

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface EventEmailContext {
  notificationType: EmailNotificationType;
  contractId: string;
  /** Raw indexed event type, shown for traceability. */
  eventType: string;
  ledger: number;
  milestoneIndex: number | null;
  /** One-click opt-out link. */
  unsubscribeUrl: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bulletLines(context: EventEmailContext): string[] {
  const lines = [
    `Contract: ${context.contractId}`,
    `Event: ${context.eventType} (ledger ${context.ledger})`,
  ];
  if (context.milestoneIndex !== null) {
    lines.push(`Milestone: #${context.milestoneIndex}`);
  }
  return lines;
}

/** Render the plain-text and HTML bodies for a contract event notification. */
export function renderEventEmail(context: EventEmailContext): RenderedEmail {
  const label = EMAIL_NOTIFICATION_LABELS[context.notificationType];
  const subject = `[Escrow] ${label}`;
  const details = bulletLines(context);

  const text = [
    label,
    "",
    ...details,
    "",
    `Unsubscribe: ${context.unsubscribeUrl}`,
  ].join("\n");

  const htmlDetails = details
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join("");
  const html = [
    `<h2>${escapeHtml(label)}</h2>`,
    `<ul>${htmlDetails}</ul>`,
    `<p><a href="${escapeHtml(context.unsubscribeUrl)}">Unsubscribe</a></p>`,
  ].join("\n");

  return { subject, text, html };
}

export interface ConfirmationEmailContext {
  contractId: string;
  /** Confirmation link the recipient must open. */
  confirmUrl: string;
  /** One-click opt-out link. */
  unsubscribeUrl: string;
}

/** Render the confirmation email sent when a subscription is created. */
export function renderConfirmationEmail(
  context: ConfirmationEmailContext,
): RenderedEmail {
  const subject = "[Escrow] Confirm your email notifications";
  const text = [
    "Confirm your escrow email notifications",
    "",
    `Contract: ${context.contractId}`,
    "",
    "Open this link to start receiving notifications:",
    context.confirmUrl,
    "",
    "If you did not request this, ignore this email.",
    `Unsubscribe: ${context.unsubscribeUrl}`,
  ].join("\n");

  const html = [
    "<h2>Confirm your escrow email notifications</h2>",
    `<p>Contract: ${escapeHtml(context.contractId)}</p>`,
    `<p><a href="${escapeHtml(context.confirmUrl)}">Confirm notifications</a></p>`,
    "<p>If you did not request this, ignore this email.</p>",
    `<p><a href="${escapeHtml(context.unsubscribeUrl)}">Unsubscribe</a></p>`,
  ].join("\n");

  return { subject, text, html };
}
