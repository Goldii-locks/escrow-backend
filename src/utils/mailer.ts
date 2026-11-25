/**
 * SMTP email transport (#…).
 *
 * The unauthenticated contract email notification feature is gated on
 * `SMTP_URL` + `EMAIL_FROM`. When either is unset the transport is a clean
 * no-op: `getMailTransport()` returns `null`, `sendMail()` returns `false`,
 * and nothing is attempted, so startup and the rest of the server are
 * unaffected.
 */

import { createTransport, type Transporter } from "nodemailer";
import { config } from "../config.js";
import logger from "./logger.js";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

let transport: Transporter | null = null;

/** True when both `SMTP_URL` and `EMAIL_FROM` are configured. */
export function emailDeliveryEnabled(): boolean {
  return config.emailNotificationsEnabled;
}

/** The live transport, or `null` when the feature is disabled. */
export function getMailTransport(): Transporter | null {
  if (!emailDeliveryEnabled()) return null;
  if (!transport) {
    transport = createTransport(config.smtpUrl);
  }
  return transport;
}

/** Replace the transport (tests). */
export function setMailTransportForTests(next: Transporter | null): void {
  transport = next;
}

/** Drop the cached transport so the next call rebuilds it from config. */
export function resetMailTransportForTests(): void {
  transport = null;
}

/**
 * Send one email. Returns `true` on success. Never throws: a disabled feature
 * or any transport failure is logged and reported as `false` so a delivery
 * failure cannot break the indexer.
 */
export async function sendMail(message: OutgoingEmail): Promise<boolean> {
  const active = getMailTransport();
  if (!active) return false;

  try {
    await active.sendMail({
      from: config.emailFrom,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return true;
  } catch (err) {
    logger.error("Failed to send email", {
      to: message.to,
      subject: message.subject,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
