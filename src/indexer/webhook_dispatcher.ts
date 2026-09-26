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

// ---------------------------------------------------------------------------
// Timeouts, payload schema serialization and retry backoff (#513–#515)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Error / warning codes
// ---------------------------------------------------------------------------

export const ERROR_CODES = {
  CALL_TIMEOUT: "WEBHOOK_DISPATCHER_CALL_TIMEOUT",
  CONNECTION_ERROR: "WEBHOOK_DISPATCHER_CONNECTION_ERROR",
  INVALID_PAYLOAD: "WEBHOOK_DISPATCHER_INVALID_PAYLOAD",
  SCHEMA_MISMATCH: "WEBHOOK_DISPATCHER_SCHEMA_MISMATCH",
  SERIALIZATION_ERROR: "WEBHOOK_DISPATCHER_SERIALIZATION_ERROR",
  RETRY_EXHAUSTED: "WEBHOOK_DISPATCHER_RETRY_EXHAUSTED",
  INVALID_URL: "WEBHOOK_DISPATCHER_INVALID_URL",
} as const;

export type WebhookDispatcherErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// ---------------------------------------------------------------------------
// Timeout configuration (#513)
// ---------------------------------------------------------------------------

export interface WebhookTimeoutConfig {
  /** Total request timeout in milliseconds (AbortSignal). */
  timeoutMs: number;
  /** Connection / connect-phase timeout in milliseconds. */
  connectTimeoutMs: number;
}

const DEFAULT_TIMEOUT_CONFIG: WebhookTimeoutConfig = {
  timeoutMs: 5_000,
  connectTimeoutMs: 3_000,
};

let timeoutConfig: WebhookTimeoutConfig = { ...DEFAULT_TIMEOUT_CONFIG };

export function setWebhookTimeoutConfig(
  config: Partial<WebhookTimeoutConfig>
): void {
  timeoutConfig = { ...timeoutConfig, ...config };
}

export function getWebhookTimeoutConfig(): WebhookTimeoutConfig {
  return { ...timeoutConfig };
}

export function resetWebhookTimeoutConfig(): void {
  timeoutConfig = { ...DEFAULT_TIMEOUT_CONFIG };
}

export class WebhookTimeoutError extends Error {
  readonly code = ERROR_CODES.CALL_TIMEOUT;
  readonly timeoutMs: number;

  constructor(timeoutMs: number, message?: string) {
    super(
      message ??
        `Webhook request exceeded timeout threshold of ${timeoutMs}ms`
    );
    this.name = "WebhookTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function isTimeoutError(err: unknown): boolean {
  if (err instanceof WebhookTimeoutError) return true;
  // Duck-type rather than `instanceof Error`: fetch aborts surface as a
  // DOMException, which can come from a different realm than this module.
  if (typeof err !== "object" || err === null) return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  if (typeof name !== "string" || typeof message !== "string") return false;
  const msg = message.toLowerCase();
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    msg.includes("timeout") ||
    msg.includes("aborted") ||
    msg.includes("etimedout")
  );
}

// ---------------------------------------------------------------------------
// Payload schema serialization (#514)
// ---------------------------------------------------------------------------

export type PayloadFieldType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array";

export interface PayloadFieldTemplate {
  name: string;
  type: PayloadFieldType;
  required?: boolean;
  /** Dot-path into the source event (default: field name). */
  source?: string;
  /** Static default when source is missing and field is optional. */
  default?: unknown;
}

export interface PayloadSchemaTemplate {
  name: string;
  fields: PayloadFieldTemplate[];
  /** When true, reject unknown top-level keys after serialization. */
  strict?: boolean;
}

export const DEFAULT_WEBHOOK_PAYLOAD_SCHEMA: PayloadSchemaTemplate = {
  name: "escrow.event.v1",
  strict: true,
  fields: [
    { name: "event_type", type: "string", required: true, source: "event_type" },
    { name: "contract_id", type: "string", required: true, source: "contract_id" },
    {
      name: "ledger_sequence",
      type: "number",
      required: true,
      source: "ledger_sequence",
    },
    { name: "timestamp", type: "string", required: true, source: "timestamp" },
    { name: "data", type: "object", required: true, source: "data" },
    {
      name: "schema",
      type: "string",
      required: false,
      default: "escrow.event.v1",
    },
  ],
};

let activePayloadSchema: PayloadSchemaTemplate = {
  ...DEFAULT_WEBHOOK_PAYLOAD_SCHEMA,
  fields: [...DEFAULT_WEBHOOK_PAYLOAD_SCHEMA.fields],
};

export function setWebhookPayloadSchema(
  schema: PayloadSchemaTemplate
): void {
  activePayloadSchema = schema;
}

export function getWebhookPayloadSchema(): PayloadSchemaTemplate {
  return {
    ...activePayloadSchema,
    fields: [...activePayloadSchema.fields],
  };
}

export function resetWebhookPayloadSchema(): void {
  activePayloadSchema = {
    ...DEFAULT_WEBHOOK_PAYLOAD_SCHEMA,
    fields: [...DEFAULT_WEBHOOK_PAYLOAD_SCHEMA.fields],
  };
}

function readSourcePath(source: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = source;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function matchesType(value: unknown, type: PayloadFieldType): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  return typeof value === type;
}

export type SerializePayloadResult =
  | { ok: true; payload: Record<string, unknown>; body: string }
  | {
      ok: false;
      error: string;
      code: WebhookDispatcherErrorCode;
      details?: unknown;
    };

/**
 * Dynamically serialize an event against the configured payload schema template.
 */
export function serializeWebhookPayload(
  event: Record<string, unknown>,
  schema: PayloadSchemaTemplate = activePayloadSchema
): SerializePayloadResult {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    return {
      ok: false,
      error: "Event must be a non-null object",
      code: ERROR_CODES.INVALID_PAYLOAD,
    };
  }

  const payload: Record<string, unknown> = {};

  for (const field of schema.fields) {
    const sourcePath = field.source ?? field.name;
    let value = readSourcePath(event, sourcePath);

    if (value === undefined) {
      if (field.default !== undefined) {
        value = field.default;
      } else if (field.required !== false) {
        return {
          ok: false,
          error: `Missing required payload field '${field.name}' (source: ${sourcePath})`,
          code: ERROR_CODES.SCHEMA_MISMATCH,
          details: { field, schema: schema.name },
        };
      } else {
        continue;
      }
    }

    if (!matchesType(value, field.type)) {
      return {
        ok: false,
        error: `Payload field '${field.name}' expected type ${field.type}, got ${
          Array.isArray(value) ? "array" : value === null ? "null" : typeof value
        }`,
        code: ERROR_CODES.SCHEMA_MISMATCH,
        details: { field, value, schema: schema.name },
      };
    }

    payload[field.name] = value;
  }

  if (schema.strict) {
    const allowed = new Set(schema.fields.map((f) => f.name));
    for (const key of Object.keys(payload)) {
      if (!allowed.has(key)) {
        return {
          ok: false,
          error: `Unexpected payload key '${key}' for schema '${schema.name}'`,
          code: ERROR_CODES.SCHEMA_MISMATCH,
          details: { key, schema: schema.name },
        };
      }
    }
  }

  try {
    const body = JSON.stringify(payload);
    return { ok: true, payload, body };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to serialize webhook payload: ${
        err instanceof Error ? err.message : String(err)
      }`,
      code: ERROR_CODES.SERIALIZATION_ERROR,
    };
  }
}

/**
 * Assert a serialized payload matches the config template field-for-field.
 */
export function assertPayloadMatchesSchema(
  payload: Record<string, unknown>,
  schema: PayloadSchemaTemplate = activePayloadSchema
): SerializePayloadResult {
  for (const field of schema.fields) {
    if (!(field.name in payload)) {
      if (field.required === false) continue;
      return {
        ok: false,
        error: `Serialized payload missing field '${field.name}'`,
        code: ERROR_CODES.SCHEMA_MISMATCH,
        details: { field, schema: schema.name },
      };
    }
    if (!matchesType(payload[field.name], field.type)) {
      return {
        ok: false,
        error: `Serialized payload field '${field.name}' type mismatch`,
        code: ERROR_CODES.SCHEMA_MISMATCH,
        details: { field, value: payload[field.name], schema: schema.name },
      };
    }
  }

  if (schema.strict) {
    const allowed = new Set(schema.fields.map((f) => f.name));
    for (const key of Object.keys(payload)) {
      if (!allowed.has(key)) {
        return {
          ok: false,
          error: `Serialized payload has unexpected key '${key}'`,
          code: ERROR_CODES.SCHEMA_MISMATCH,
        };
      }
    }
  }

  try {
    return { ok: true, payload, body: JSON.stringify(payload) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: ERROR_CODES.SERIALIZATION_ERROR,
    };
  }
}

// ---------------------------------------------------------------------------
// Retry backoff queue (#515)
// ---------------------------------------------------------------------------

export interface WebhookRetryConfig {
  maxRetries: number;
  initialBackoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
}

const DEFAULT_RETRY_CONFIG: WebhookRetryConfig = {
  maxRetries: 3,
  initialBackoffMs: 500,
  backoffMultiplier: 3,
  maxBackoffMs: 30_000,
};

let retryConfig: WebhookRetryConfig = { ...DEFAULT_RETRY_CONFIG };

export function setWebhookRetryConfig(
  config: Partial<WebhookRetryConfig>
): void {
  retryConfig = { ...retryConfig, ...config };
}

export function getWebhookRetryConfig(): WebhookRetryConfig {
  return { ...retryConfig };
}

export function resetWebhookRetryConfig(): void {
  retryConfig = { ...DEFAULT_RETRY_CONFIG };
}

/**
 * Compute the backoff delay for a zero-based retry attempt index.
 * Delays scale: initial * multiplier^attempt, capped at maxBackoffMs.
 */
export function computeWebhookBackoffMs(
  attempt: number,
  config: Pick<
    WebhookRetryConfig,
    "initialBackoffMs" | "backoffMultiplier" | "maxBackoffMs"
  > = retryConfig
): number {
  if (attempt < 0) return config.initialBackoffMs;
  return Math.min(
    config.initialBackoffMs * Math.pow(config.backoffMultiplier, attempt),
    config.maxBackoffMs
  );
}

export interface RetryQueueItem {
  id: string;
  webhookUrl: string;
  event: Record<string, unknown>;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
}

const retryQueue: RetryQueueItem[] = [];

export function enqueueWebhookRetry(
  item: Omit<RetryQueueItem, "attempts" | "nextAttemptAt"> & {
    attempts?: number;
    nextAttemptAt?: number;
  }
): RetryQueueItem {
  const attempts = item.attempts ?? 0;
  const queued: RetryQueueItem = {
    id: item.id,
    webhookUrl: item.webhookUrl,
    event: item.event,
    attempts,
    nextAttemptAt:
      item.nextAttemptAt ??
      Date.now() + computeWebhookBackoffMs(attempts),
    lastError: item.lastError,
  };
  retryQueue.push(queued);
  retryQueue.sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
  return queued;
}

export function getWebhookRetryQueue(): RetryQueueItem[] {
  return retryQueue.map((item) => ({ ...item, event: { ...item.event } }));
}

export function clearWebhookRetryQueue(): void {
  retryQueue.length = 0;
}

export function peekDueRetryItems(now: number = Date.now()): RetryQueueItem[] {
  return retryQueue.filter((item) => item.nextAttemptAt <= now);
}

export function dequeueDueRetryItems(now: number = Date.now()): RetryQueueItem[] {
  const due: RetryQueueItem[] = [];
  while (retryQueue.length > 0 && retryQueue[0].nextAttemptAt <= now) {
    due.push(retryQueue.shift()!);
  }
  return due;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Dispatch (#513 + #514 + #515)
// ---------------------------------------------------------------------------

export interface DispatchResult {
  success: boolean;
  attempts: number;
  status?: number;
  error?: string;
  code?: WebhookDispatcherErrorCode;
  timeoutMs?: number;
  delays?: number[];
  payload?: Record<string, unknown>;
}

export type FetchLike = (
  url: string,
  init?: RequestInit
) => Promise<Response>;

/**
 * Deliver a single webhook with timeout enforcement and schema serialization.
 * Does not retry — use `dispatchWebhookWithRetry` for backoff queues.
 */
export async function dispatchWebhook(
  webhookUrl: string,
  event: Record<string, unknown>,
  options?: {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    schema?: PayloadSchemaTemplate;
  }
): Promise<DispatchResult> {
  if (typeof webhookUrl !== "string" || !/^https?:\/\//i.test(webhookUrl)) {
    return {
      success: false,
      attempts: 0,
      error: "Invalid webhook URL",
      code: ERROR_CODES.INVALID_URL,
    };
  }

  const serialized = serializeWebhookPayload(
    event,
    options?.schema ?? activePayloadSchema
  );
  if (!serialized.ok) {
    return {
      success: false,
      attempts: 0,
      error: serialized.error,
      code: serialized.code,
    };
  }

  const match = assertPayloadMatchesSchema(
    serialized.payload,
    options?.schema ?? activePayloadSchema
  );
  if (!match.ok) {
    return {
      success: false,
      attempts: 0,
      error: match.error,
      code: match.code,
    };
  }

  const timeoutMs = options?.timeoutMs ?? timeoutConfig.timeoutMs;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serialized.body,
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        success: false,
        attempts: 1,
        status: response.status,
        error: `Webhook responded with HTTP ${response.status}`,
        code: ERROR_CODES.CONNECTION_ERROR,
        payload: serialized.payload,
      };
    }

    return {
      success: true,
      attempts: 1,
      status: response.status,
      payload: serialized.payload,
    };
  } catch (err) {
    if (isTimeoutError(err)) {
      logger.warn("Webhook dispatcher call timeout", {
        webhookUrl,
        timeoutMs,
        code: ERROR_CODES.CALL_TIMEOUT,
      });
      return {
        success: false,
        attempts: 1,
        error: `Webhook request exceeded timeout threshold of ${timeoutMs}ms`,
        code: ERROR_CODES.CALL_TIMEOUT,
        timeoutMs,
        payload: serialized.payload,
      };
    }

    return {
      success: false,
      attempts: 1,
      error: err instanceof Error ? err.message : String(err),
      code: ERROR_CODES.CONNECTION_ERROR,
      payload: serialized.payload,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Schedule-worker style dispatch with exponential retry backoff.
 * Verifies retry delays scale according to configuration thresholds.
 */
export async function dispatchWebhookWithRetry(
  webhookUrl: string,
  event: Record<string, unknown>,
  options?: {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    schema?: PayloadSchemaTemplate;
    retry?: Partial<WebhookRetryConfig>;
    sleepFn?: (ms: number) => Promise<void>;
  }
): Promise<DispatchResult> {
  const config: WebhookRetryConfig = {
    ...retryConfig,
    ...options?.retry,
  };
  const sleepFn = options?.sleepFn ?? sleep;
  const delays: number[] = [];
  let lastResult: DispatchResult = {
    success: false,
    attempts: 0,
    error: "No attempts made",
    code: ERROR_CODES.RETRY_EXHAUSTED,
  };

  const maxAttempts = Math.max(1, config.maxRetries);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    lastResult = await dispatchWebhook(webhookUrl, event, {
      fetchImpl: options?.fetchImpl,
      timeoutMs: options?.timeoutMs,
      schema: options?.schema,
    });
    lastResult.attempts = attempt + 1;
    lastResult.delays = [...delays];

    if (lastResult.success) {
      return lastResult;
    }

    const retryable =
      lastResult.code === ERROR_CODES.CALL_TIMEOUT ||
      lastResult.code === ERROR_CODES.CONNECTION_ERROR;

    if (!retryable || attempt >= maxAttempts - 1) {
      break;
    }

    const delay = computeWebhookBackoffMs(attempt, config);
    delays.push(delay);
    enqueueWebhookRetry({
      id: `${webhookUrl}:${attempt}:${Date.now()}`,
      webhookUrl,
      event,
      attempts: attempt + 1,
      nextAttemptAt: Date.now() + delay,
      lastError: lastResult.error,
    });
    await sleepFn(delay);
  }

  return {
    ...lastResult,
    attempts: lastResult.attempts || maxAttempts,
    delays,
    code: lastResult.success
      ? undefined
      : lastResult.code ?? ERROR_CODES.RETRY_EXHAUSTED,
    error: lastResult.success
      ? undefined
      : lastResult.error ?? "Webhook delivery failed after retries",
  };
}

/**
 * Process due items from the retry backoff queue (schedule worker tick).
 */
export async function processWebhookRetryQueue(
  options?: {
    fetchImpl?: FetchLike;
    now?: number;
    sleepFn?: (ms: number) => Promise<void>;
  }
): Promise<DispatchResult[]> {
  const due = dequeueDueRetryItems(options?.now ?? Date.now());
  const results: DispatchResult[] = [];

  for (const item of due) {
    const result = await dispatchWebhookWithRetry(
      item.webhookUrl,
      item.event,
      {
        fetchImpl: options?.fetchImpl,
        sleepFn: options?.sleepFn ?? (async () => undefined),
        retry: {
          maxRetries: Math.max(1, retryConfig.maxRetries - item.attempts),
        },
      }
    );
    results.push(result);
  }

  return results;
}
