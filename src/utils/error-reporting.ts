import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Optional error reporting (#895)
// ---------------------------------------------------------------------------
// A tiny Sentry-compatible reporter: with SENTRY_DSN unset nothing is
// initialised, no transport exists, and every call is a no-op. A DSN enables a
// fetch-based envelope transport; tests inject a mock transport instead.
// Bodies and credential headers never leave the process, and URL query strings
// (where webhook secrets are commonly smuggled) are stripped recursively.

export interface SentryEvent {
  level: "error";
  event_id: string;
  timestamp: string;
  release: string;
  tags: Record<string, string>;
  exception: {
    values: Array<{ type: string; value: string }>;
  };
  request?: {
    method?: string;
    url?: string;
    headers?: Record<string, unknown>;
    data?: unknown;
  };
  extra?: Record<string, unknown>;
}

export interface CaptureContext {
  requestId?: string;
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  body?: unknown;
  tags?: Record<string, string | number>;
  extra?: Record<string, unknown>;
}

export type ErrorTransport = (event: SentryEvent) => void | Promise<void>;

const SENSITIVE_HEADERS = new Set(["x-api-key", "x-admin-key"]);
let transport: ErrorTransport | null = null;

/** Drop query strings from absolute or root-relative URLs. */
export function scrubUrlQuery(value: string): string {
  const i = value.indexOf("?");
  if (i === -1) return value;
  if (!/^https?:\/\//i.test(value) && !value.startsWith("/")) return value;
  return `${value.slice(0, i)}?[redacted]`;
}

function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return scrubUrlQuery(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = SENSITIVE_HEADERS.has(key.toLowerCase())
        ? "[redacted]"
        : scrubValue(entry);
    }
    return out;
  }
  return value;
}

/** Redact credentials before an event is handed to any transport. */
export function scrubEvent(event: SentryEvent): SentryEvent {
  const scrubbed = scrubValue(event) as SentryEvent;
  if (scrubbed.request) scrubbed.request.data = "[redacted]";
  return scrubbed;
}

function createHttpTransport(dsn: string): ErrorTransport {
  const parsed = new URL(dsn);
  const projectId = parsed.pathname.replace(/^\//, "").replace(/\/$/, "");
  const endpoint = `${parsed.origin}/api/${projectId}/envelope/`;
  const auth = `Sentry sentry_version=7, sentry_key=${parsed.username || "public"}`;
  return (event) => {
    const envelope = [
      JSON.stringify({ dsn, sent_at: new Date().toISOString() }),
      JSON.stringify({ type: "event", event_id: event.event_id }),
      JSON.stringify(event),
    ].join("\n");
    void fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": auth,
      },
      body: envelope,
    }).catch(() => {});
  };
}

/**
 * Enable reporting. An unset or malformed DSN keeps the process in no-op mode.
 * `transportOverride` exists for tests with a mocked transport.
 */
export function initErrorReporting(
  dsn: string | undefined = process.env.SENTRY_DSN,
  transportOverride?: ErrorTransport,
): void {
  if (!dsn) return;
  try {
    transport = transportOverride ?? createHttpTransport(dsn);
  } catch {
    transport = null;
  }
}

/** Restore no-op mode (tests). */
export function resetErrorReporting(): void {
  transport = null;
}

export function captureError(error: unknown, context: CaptureContext = {}): void {
  if (!transport) return;

  const err = error instanceof Error ? error : new Error(String(error));
  const release = process.env.GIT_SHA ?? "unknown";
  const tags: Record<string, string> = {
    release,
    requestId: context.requestId ?? "none",
  };
  for (const [key, value] of Object.entries(context.tags ?? {})) {
    tags[key] = String(value);
  }

  const event: SentryEvent = {
    level: "error",
    event_id: randomUUID(),
    timestamp: new Date().toISOString(),
    release,
    tags,
    exception: { values: [{ type: err.name, value: err.message }] },
  };

  if (context.method || context.url || context.headers || context.body !== undefined) {
    event.request = {
      ...(context.method ? { method: context.method } : {}),
      ...(context.url ? { url: context.url } : {}),
      ...(context.headers ? { headers: context.headers } : {}),
      ...(context.body !== undefined ? { data: context.body } : {}),
    };
  }
  if (context.extra) event.extra = context.extra;

  try {
    void Promise.resolve(transport(scrubEvent(event))).catch(() => {});
  } catch {
    // Reporting must never change the behaviour of the code being reported on.
  }
}
