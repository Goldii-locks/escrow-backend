/**
 * webhook_dispatcher – webhook event notification service.
 *
 * Features:
 *  - #516 Template configuration parsing with unescaped variable interpolation
 *  - #517 Activity-history row inserts under active SQLite transactions
 *  - #518 Notification-switch checks that skip opted-out recipients
 *  - #519 Bulk batching buffers that aggregate alerts before delivery
 */

import { getDb } from "./db.js";
import logger from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebhookTemplateConfig {
  /** Mustache-style template body, e.g. "Hello {{name}}" */
  template: string;
  /** Named variables substituted into the template */
  variables: Record<string, string | number | boolean | null | undefined>;
  /** Optional event / channel metadata */
  eventType?: string;
  channel?: string;
}

export interface ParsedTemplateResult {
  config: WebhookTemplateConfig;
  /** Fully interpolated body – HTML is NOT escaped (#516) */
  rendered: string;
}

export interface WebhookActivityEntry {
  id: number;
  recipient_id: string;
  event_type: string;
  channel: string;
  payload_json: string;
  status: string;
  created_at: string;
}

export interface NotificationSwitch {
  recipient_id: string;
  /** When true, all alerts for this recipient are suppressed (#518) */
  opted_out: boolean;
  /** Channels that remain enabled when not opted out (empty = all) */
  enabled_channels: string[];
  /** Event types that are muted even when opted in */
  muted_event_types: string[];
}

export interface DispatchAlert {
  recipientId: string;
  eventType: string;
  channel: string;
  payload: Record<string, unknown>;
  template?: WebhookTemplateConfig;
}

export interface DeliveryTarget {
  recipientId: string;
  eventType: string;
  channel: string;
  body: string;
  payload: Record<string, unknown>;
}

export interface BatchBufferConfig {
  /** Flush when this many alerts are queued (default: 10) */
  maxBatchSize: number;
  /** Optional wall-clock flush interval in ms (default: disabled) */
  flushIntervalMs?: number;
}

export type DeliveryHandler = (
  batch: DeliveryTarget[],
) => Promise<void> | void;

// ---------------------------------------------------------------------------
// Schema bootstrap (self-contained; does not alter shared migrations)
// ---------------------------------------------------------------------------

let schemaReady = false;

/**
 * Ensure activity-history and notification-switch tables exist.
 * Safe to call repeatedly.
 */
export function ensureWebhookDispatcherSchema(): void {
  if (schemaReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_activity_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'webhook',
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'logged',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_activity_recipient
      ON webhook_activity_history (recipient_id);

    CREATE INDEX IF NOT EXISTS idx_webhook_activity_event_type
      ON webhook_activity_history (event_type);

    CREATE TABLE IF NOT EXISTS webhook_notification_switches (
      recipient_id TEXT PRIMARY KEY,
      opted_out INTEGER NOT NULL DEFAULT 0,
      enabled_channels TEXT NOT NULL DEFAULT '[]',
      muted_event_types TEXT NOT NULL DEFAULT '[]',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  schemaReady = true;
}

/** Test helper – force schema re-check on next call. */
export function resetWebhookDispatcherSchemaFlag(): void {
  schemaReady = false;
}

// ---------------------------------------------------------------------------
// #516 – Template configuration parsing (no HTML escaping)
// ---------------------------------------------------------------------------

const TEMPLATE_VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Validate and normalise a raw template configuration object.
 */
export function parseTemplateConfig(raw: unknown): WebhookTemplateConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("template config must be a plain object");
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.template !== "string") {
    throw new Error("template config requires a string `template` field");
  }

  const variables: WebhookTemplateConfig["variables"] = {};
  if (obj.variables !== undefined) {
    if (
      obj.variables === null ||
      typeof obj.variables !== "object" ||
      Array.isArray(obj.variables)
    ) {
      throw new Error("template config `variables` must be a plain object");
    }
    for (const [key, value] of Object.entries(
      obj.variables as Record<string, unknown>,
    )) {
      if (
        value !== null &&
        value !== undefined &&
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw new Error(
          `template variable "${key}" must be string | number | boolean | null`,
        );
      }
      variables[key] = value as string | number | boolean | null | undefined;
    }
  }

  return {
    template: obj.template,
    variables,
    eventType: typeof obj.eventType === "string" ? obj.eventType : undefined,
    channel: typeof obj.channel === "string" ? obj.channel : undefined,
  };
}

/**
 * Interpolate `{{var}}` placeholders.
 *
 * Intentionally does NOT HTML-escape substituted values so callers can
 * embed markup / raw payloads when needed (#516 validation).
 */
export function interpolateTemplate(
  template: string,
  variables: Record<string, string | number | boolean | null | undefined>,
): string {
  return template.replace(TEMPLATE_VAR_RE, (_match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(variables, name)) {
      return "";
    }
    const value = variables[name];
    if (value === null || value === undefined) return "";
    return String(value);
  });
}

/**
 * Parse a template config and render it in one step.
 */
export function renderTemplateConfig(raw: unknown): ParsedTemplateResult {
  const config = parseTemplateConfig(raw);
  const rendered = interpolateTemplate(config.template, config.variables);
  return { config, rendered };
}

// ---------------------------------------------------------------------------
// #517 – Activity history inserts under active transactions
// ---------------------------------------------------------------------------

export interface ActivityInsertInput {
  recipientId: string;
  eventType: string;
  channel?: string;
  payload: Record<string, unknown> | string;
  status?: string;
}

/**
 * Insert one or more activity-history rows inside a single SQLite
 * transaction so tracking rows are only persisted when the whole batch
 * commits (#517).
 */
export function insertActivityHistory(
  entries: ActivityInsertInput | ActivityInsertInput[],
): WebhookActivityEntry[] {
  ensureWebhookDispatcherSchema();
  const db = getDb();
  const list = Array.isArray(entries) ? entries : [entries];

  if (list.length === 0) return [];

  const insertTx = db.transaction((rows: ActivityInsertInput[]) => {
    const stmt = db.prepare(`
      INSERT INTO webhook_activity_history
        (recipient_id, event_type, channel, payload_json, status)
      VALUES (?, ?, ?, ?, ?)
    `);
    const select = db.prepare(
      "SELECT * FROM webhook_activity_history WHERE id = ?",
    );
    const inserted: WebhookActivityEntry[] = [];

    for (const row of rows) {
      if (!row.recipientId || !row.eventType) {
        throw new Error(
          "activity history requires recipientId and eventType",
        );
      }
      const payloadJson =
        typeof row.payload === "string"
          ? row.payload
          : JSON.stringify(row.payload ?? {});
      const result = stmt.run(
        row.recipientId,
        row.eventType,
        row.channel ?? "webhook",
        payloadJson,
        row.status ?? "logged",
      );
      const saved = select.get(Number(result.lastInsertRowid)) as
        | WebhookActivityEntry
        | undefined;
      if (saved) inserted.push(saved);
    }

    return inserted;
  });

  return insertTx(list);
}

/**
 * Read activity-history rows, optionally filtered by recipient.
 */
export function getActivityHistory(
  recipientId?: string,
): WebhookActivityEntry[] {
  ensureWebhookDispatcherSchema();
  const db = getDb();
  if (recipientId) {
    return db
      .prepare(
        "SELECT * FROM webhook_activity_history WHERE recipient_id = ? ORDER BY id ASC",
      )
      .all(recipientId) as WebhookActivityEntry[];
  }
  return db
    .prepare("SELECT * FROM webhook_activity_history ORDER BY id ASC")
    .all() as WebhookActivityEntry[];
}

// ---------------------------------------------------------------------------
// #518 – Notification switches (opt-out filtering)
// ---------------------------------------------------------------------------

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function rowToSwitch(row: {
  recipient_id: string;
  opted_out: number;
  enabled_channels: string;
  muted_event_types: string;
}): NotificationSwitch {
  return {
    recipient_id: row.recipient_id,
    opted_out: row.opted_out === 1,
    enabled_channels: parseStringArray(row.enabled_channels),
    muted_event_types: parseStringArray(row.muted_event_types),
  };
}

/**
 * Upsert notification delivery preferences for a recipient.
 */
export function setNotificationSwitch(
  settings: NotificationSwitch,
): NotificationSwitch {
  ensureWebhookDispatcherSchema();
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      `
      INSERT INTO webhook_notification_switches
        (recipient_id, opted_out, enabled_channels, muted_event_types, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(recipient_id) DO UPDATE SET
        opted_out = excluded.opted_out,
        enabled_channels = excluded.enabled_channels,
        muted_event_types = excluded.muted_event_types,
        updated_at = CURRENT_TIMESTAMP
    `,
    ).run(
      settings.recipient_id,
      settings.opted_out ? 1 : 0,
      JSON.stringify(settings.enabled_channels ?? []),
      JSON.stringify(settings.muted_event_types ?? []),
    );

    const row = db
      .prepare(
        "SELECT * FROM webhook_notification_switches WHERE recipient_id = ?",
      )
      .get(settings.recipient_id) as {
      recipient_id: string;
      opted_out: number;
      enabled_channels: string;
      muted_event_types: string;
    };
    return rowToSwitch(row);
  });
  return tx();
}

export function getNotificationSwitch(
  recipientId: string,
): NotificationSwitch | null {
  ensureWebhookDispatcherSchema();
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM webhook_notification_switches WHERE recipient_id = ?",
    )
    .get(recipientId) as
    | {
        recipient_id: string;
        opted_out: number;
        enabled_channels: string;
        muted_event_types: string;
      }
    | undefined;
  return row ? rowToSwitch(row) : null;
}

/**
 * Return true when alerts for this recipient/event/channel must be ignored.
 *
 * Rules (#518):
 *  - No switch row → deliver (default opt-in)
 *  - opted_out === true → suppress all
 *  - muted_event_types includes eventType → suppress
 *  - enabled_channels non-empty and channel not listed → suppress
 */
export function shouldIgnoreAlert(
  recipientId: string,
  eventType: string,
  channel = "webhook",
): boolean {
  const settings = getNotificationSwitch(recipientId);
  if (!settings) return false;
  if (settings.opted_out) return true;
  if (settings.muted_event_types.includes(eventType)) return true;
  if (
    settings.enabled_channels.length > 0 &&
    !settings.enabled_channels.includes(channel)
  ) {
    return true;
  }
  return false;
}

/**
 * Drop alerts destined for opted-out / muted recipients.
 */
export function filterDeliverableAlerts(
  alerts: DispatchAlert[],
): DispatchAlert[] {
  return alerts.filter(
    (alert) =>
      !shouldIgnoreAlert(alert.recipientId, alert.eventType, alert.channel),
  );
}

// ---------------------------------------------------------------------------
// #519 – Bulk batching buffers
// ---------------------------------------------------------------------------

export const DEFAULT_BATCH_BUFFER_CONFIG: BatchBufferConfig = {
  maxBatchSize: 10,
};

/**
 * In-memory queue that aggregates notification alerts and only hands them
 * to the delivery handler once a flush threshold is reached (#519).
 */
export class WebhookBatchBuffer {
  private readonly queue: DispatchAlert[] = [];
  private readonly config: BatchBufferConfig;
  private readonly deliver: DeliveryHandler;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deliveryCount = 0;

  constructor(
    deliver: DeliveryHandler,
    config: Partial<BatchBufferConfig> = {},
  ) {
    this.deliver = deliver;
    this.config = { ...DEFAULT_BATCH_BUFFER_CONFIG, ...config };
    if (
      this.config.flushIntervalMs !== undefined &&
      this.config.flushIntervalMs > 0
    ) {
      this.armTimer();
    }
  }

  get size(): number {
    return this.queue.length;
  }

  get deliveriesMade(): number {
    return this.deliveryCount;
  }

  /** Enqueue an alert; auto-flushes when maxBatchSize is reached. */
  async enqueue(alert: DispatchAlert): Promise<DeliveryTarget[] | null> {
    this.queue.push(alert);
    if (this.queue.length >= this.config.maxBatchSize) {
      return this.flush();
    }
    return null;
  }

  /**
   * Aggregate queued alerts (apply opt-out filters + template render),
   * invoke the delivery handler once with the whole batch, and clear
   * the buffer. Returns the delivered targets (empty when nothing left).
   */
  async flush(): Promise<DeliveryTarget[]> {
    if (this.queue.length === 0) return [];

    const pending = this.queue.splice(0, this.queue.length);
    const deliverable = filterDeliverableAlerts(pending);
    const targets = deliverable.map((alert) => toDeliveryTarget(alert));

    if (targets.length > 0) {
      await this.deliver(targets);
      this.deliveryCount += 1;

      // Persist activity history for the flushed batch under one transaction
      insertActivityHistory(
        targets.map((t) => ({
          recipientId: t.recipientId,
          eventType: t.eventType,
          channel: t.channel,
          payload: { ...t.payload, body: t.body },
          status: "dispatched",
        })),
      );
    }

    this.armTimer();
    return targets;
  }

  /** Cancel the optional flush timer (for tests / shutdown). */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private armTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const interval = this.config.flushIntervalMs;
    if (interval === undefined || interval <= 0) return;
    this.timer = setTimeout(() => {
      void this.flush().catch((err) => {
        logger.error("webhook_dispatcher batch flush failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, interval);
    // Allow Node to exit even if the timer is still pending in tests
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }
}

function toDeliveryTarget(alert: DispatchAlert): DeliveryTarget {
  let body = "";
  if (alert.template) {
    const parsed = parseTemplateConfig(alert.template);
    body = interpolateTemplate(parsed.template, {
      ...parsed.variables,
      ...(alert.payload as Record<
        string,
        string | number | boolean | null | undefined
      >),
    });
  } else {
    body = JSON.stringify(alert.payload);
  }

  return {
    recipientId: alert.recipientId,
    eventType: alert.eventType,
    channel: alert.channel,
    body,
    payload: alert.payload,
  };
}

// ---------------------------------------------------------------------------
// High-level dispatch entry point
// ---------------------------------------------------------------------------

/**
 * Process a set of alerts: filter opt-outs, render templates, log activity,
 * and optionally hand the batch to a delivery callback.
 */
export async function dispatchWebhookAlerts(
  alerts: DispatchAlert[],
  deliver?: DeliveryHandler,
): Promise<DeliveryTarget[]> {
  ensureWebhookDispatcherSchema();
  const deliverable = filterDeliverableAlerts(alerts);
  const targets = deliverable.map((a) => toDeliveryTarget(a));

  if (targets.length === 0) return [];

  insertActivityHistory(
    targets.map((t) => ({
      recipientId: t.recipientId,
      eventType: t.eventType,
      channel: t.channel,
      payload: { ...t.payload, body: t.body },
      status: "dispatched",
    })),
  );

  if (deliver) {
    await deliver(targets);
  }

  return targets;
}
