/**
 * Webhook dispatcher — event notification service with:
 *  - Connection / call timeout checks (#513)
 *  - Dynamic payload schema serialization (#514)
 *  - Configurable retry backoff queues for the schedule worker (#515)
 */

import logger from "../utils/logger.js";

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
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    err.name === "AbortError" ||
    err.name === "TimeoutError" ||
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
