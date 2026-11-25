/**
 * Operator alerting (#…).
 *
 * A single outbound webhook for critical operational events: the poller
 * stalling or repeatedly failing, a reconciliation mismatch, an
 * auto-disabled webhook subscription, a skipped ledger range and a startup
 * network mismatch. The URL is operator-configured, so – unlike subscriber
 * webhooks (#605) – it is not run through the SSRF guard; it only has to use
 * `https:`.
 *
 * `sendOpsAlert` is deliberately infallible: alerting must never be the
 * reason a poll cycle or a request fails, so every error (missing config,
 * bad URL, network error, timeout, non-2xx response) is swallowed and, at
 * most, logged at debug level.
 */

import { config } from "../config.js";
import logger from "./logger.js";

export type OpsAlertSeverity = "info" | "warning" | "critical";

export interface OpsAlertInput {
  severity: OpsAlertSeverity;
  /** Deduplication key: the same title is sent at most once per window. */
  title: string;
  details?: Record<string, unknown> | string;
}

/** Hard ceiling on a single alert POST so a hung endpoint cannot pin a caller. */
export const OPS_ALERT_TIMEOUT_MS = 5000;

/**
 * Last time (epoch ms) each title was sent. Module-scoped so the dedupe
 * window spans every call site.
 */
const lastSentByTitle = new Map<string, number>();

/** Reset dedupe state. Test-only. */
export function resetOpsAlertsForTests(): void {
  lastSentByTitle.clear();
}

/** Whether a configured alert URL is safe to POST to (https only). */
export function isAllowedOpsAlertUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Render one alert as a single message body usable by Slack and Discord. */
export function formatOpsAlertMessage(input: OpsAlertInput): string {
  const header = `[${input.severity.toUpperCase()}] ${input.title}`;
  if (input.details === undefined) return header;
  const body =
    typeof input.details === "string"
      ? input.details
      : JSON.stringify(input.details, null, 2);
  return `${header}\n${body}`;
}

/**
 * Build the request body. Slack incoming webhooks read `text`, Discord reads
 * `content`; sending both lets the same payload target either.
 */
export function buildOpsAlertPayload(input: OpsAlertInput): {
  text: string;
  content: string;
} {
  const text = formatOpsAlertMessage(input);
  return { text, content: text };
}

/**
 * Send an operator alert, best-effort. Never throws.
 *
 * No-op when `OPS_ALERT_WEBHOOK_URL` is unset. Alerts sharing a title are
 * throttled to at most one per `OPS_ALERT_MIN_INTERVAL_S` seconds.
 */
export async function sendOpsAlert(input: OpsAlertInput): Promise<void> {
  try {
    const url = config.opsAlertWebhookUrl;
    if (!url) return;

    if (!isAllowedOpsAlertUrl(url)) {
      logger.warn("OPS_ALERT_WEBHOOK_URL must use https – alert suppressed", {
        title: input.title,
      });
      return;
    }

    const now = Date.now();
    const windowMs = config.opsAlertMinIntervalS * 1000;
    const last = lastSentByTitle.get(input.title);
    if (last !== undefined && now - last < windowMs) {
      logger.debug("Ops alert suppressed by dedupe window", { title: input.title });
      return;
    }
    lastSentByTitle.set(input.title, now);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildOpsAlertPayload(input)),
      signal: AbortSignal.timeout(OPS_ALERT_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.debug("Ops alert endpoint returned an error status", {
        title: input.title,
        status: response.status,
      });
    }
  } catch (err) {
    logger.debug("Ops alert delivery failed", {
      title: input.title,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
