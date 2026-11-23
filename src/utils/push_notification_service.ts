/**
 * push_notification_service – push message publisher.
 *
 * Publishes push messages to a provider/relay endpoint. Every request is
 * signed with HMAC-SHA256 (see webhook_signature_verifier) so the receiver
 * can authenticate it; publishing is refused when no valid secret is set.
 */

import {
  signPayload,
  WebhookSignatureError,
} from "./webhook_signature_verifier.js";

export const PUSH_NOTIFICATION_ERROR_CODES = {
  INVALID_ENDPOINT: "PUSH_NOTIFICATION_INVALID_ENDPOINT",
  INVALID_MESSAGE: "PUSH_NOTIFICATION_INVALID_MESSAGE",
  INVALID_SECRET: "PUSH_NOTIFICATION_INVALID_SECRET",
  DELIVERY_FAILED: "PUSH_NOTIFICATION_DELIVERY_FAILED",
  CALL_TIMEOUT: "PUSH_NOTIFICATION_CALL_TIMEOUT",
} as const;

export type PushNotificationErrorCode =
  (typeof PUSH_NOTIFICATION_ERROR_CODES)[keyof typeof PUSH_NOTIFICATION_ERROR_CODES];

export interface PushMessage {
  recipientId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface PublishPushOptions {
  /** HMAC secret; falls back to PUSH_NOTIFICATION_SECRET. */
  secret?: string;
  /** Override the signature timestamp (unix seconds); used in tests. */
  signedAt?: number;
  timeoutMs?: number;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

export type PublishPushResult =
  | { ok: true; status: number }
  | { ok: false; error: string; code: PushNotificationErrorCode; status?: number };

const DEFAULT_TIMEOUT_MS = 5_000;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateMessage(message: unknown): message is PushMessage {
  if (message === null || typeof message !== "object") return false;
  const m = message as Record<string, unknown>;
  if (!isNonEmptyString(m.recipientId) || !isNonEmptyString(m.title)) return false;
  if (typeof m.body !== "string") return false;
  if (
    m.data !== undefined &&
    (m.data === null || typeof m.data !== "object" || Array.isArray(m.data))
  ) {
    return false;
  }
  return true;
}

/**
 * Sign and publish a push message. Never throws.
 */
export async function publishPushMessage(
  endpoint: string,
  message: PushMessage,
  options: PublishPushOptions = {}
): Promise<PublishPushResult> {
  if (typeof endpoint !== "string" || !/^https:\/\//i.test(endpoint)) {
    return {
      ok: false,
      error: "Push endpoint must be an https URL",
      code: PUSH_NOTIFICATION_ERROR_CODES.INVALID_ENDPOINT,
    };
  }
  if (!validateMessage(message)) {
    return {
      ok: false,
      error: "Push message requires recipientId, title and body",
      code: PUSH_NOTIFICATION_ERROR_CODES.INVALID_MESSAGE,
    };
  }

  const body = JSON.stringify({
    recipient_id: message.recipientId,
    title: message.title,
    body: message.body,
    data: message.data ?? {},
  });

  let signatureHeaders: Record<string, string>;
  try {
    signatureHeaders = signPayload(
      body,
      options.secret ?? process.env.PUSH_NOTIFICATION_SECRET,
      options.signedAt
    ).headers;
  } catch (err) {
    if (!(err instanceof WebhookSignatureError)) throw err;
    return {
      ok: false,
      error: err.message,
      code: PUSH_NOTIFICATION_ERROR_CODES.INVALID_SECRET,
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signatureHeaders },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        error: `Push endpoint responded with HTTP ${response.status}`,
        code: PUSH_NOTIFICATION_ERROR_CODES.DELIVERY_FAILED,
        status: response.status,
      };
    }
    return { ok: true, status: response.status };
  } catch (err) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        error: "Push request timed out",
        code: PUSH_NOTIFICATION_ERROR_CODES.CALL_TIMEOUT,
      };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: PUSH_NOTIFICATION_ERROR_CODES.DELIVERY_FAILED,
    };
  } finally {
    clearTimeout(timer);
  }
}
