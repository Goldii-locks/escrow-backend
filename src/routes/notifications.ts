import { Router } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";
import { sendError, sendSuccess } from "../utils/api-response.js";
import {
  countActiveOrPendingEmailSubscriptions,
  confirmEmailSubscription,
  getEmailSubscriptionsForAddress,
  unsubscribeEmailSubscription,
  upsertEmailSubscription,
} from "../indexer/db.js";
import {
  EMAIL_NOTIFICATION_TYPES,
  renderConfirmationEmail,
} from "../utils/email-templates.js";
import { isValidStellarContractId } from "../utils/stellar.js";
import { emailDeliveryEnabled, sendMail } from "../utils/mailer.js";
import {
  emailAddressRateLimiter,
  emailIpRateLimiter,
  normalizeEmailAddress,
} from "../middleware/email-rate-limit.js";
import { emailConfirmUrl, emailUnsubscribeUrl } from "../indexer/email-delivery.js";
import logger from "../utils/logger.js";

const router = Router();

/** 32 random bytes → 64 hex chars, unguessable confirmation/opt-out tokens. */
function generateToken(): string {
  return randomBytes(32).toString("hex");
}

const subscribeSchema = z
  .object({
    contract_id: z
      .string()
      .refine((value) => isValidStellarContractId(value), {
        message: "contract_id must be a valid Stellar contract id (C…)",
      }),
    email: z.string().trim().min(1).email(),
    event_types: z.array(z.enum(EMAIL_NOTIFICATION_TYPES)).min(1),
  })
  .strict();

const EMAIL_DISABLED_ERROR =
  "Email notifications are not available: the server is not configured to send email";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Minimal standalone HTML page for the browser-facing confirm/unsubscribe links. */
function htmlPage(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title></head>`,
    `<body style="font-family:sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">`,
    `<h1>${escapeHtml(title)}</h1>`,
    body,
    "</body></html>",
  ].join("\n");
}

// POST /api/notifications/email — create a pending subscription and email the
// recipient a confirmation link. No wallet credential is required, so the IP
// and address rate limits plus the per-address cap are the only abuse control.
router.post(
  "/email",
  emailIpRateLimiter,
  emailAddressRateLimiter,
  (req, res) => {
    if (!emailDeliveryEnabled()) {
      return sendError(res, 503, EMAIL_DISABLED_ERROR);
    }

    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(
        res,
        400,
        parsed.error.issues[0]?.message ?? "Invalid subscription request",
      );
    }

    const contractId = parsed.data.contract_id;
    const email = normalizeEmailAddress(parsed.data.email);
    const eventTypes = [...new Set(parsed.data.event_types)];

    // Cap active/pending subscriptions per address. Re-subscribing an
    // existing (contract, email) pair resets that row rather than adding one,
    // so it is allowed even at the cap.
    const existing = getEmailSubscriptionsForAddress(email);
    const alreadySubscribed = existing.some(
      (row) => row.contract_id === contractId && row.status !== "unsubscribed",
    );
    if (
      !alreadySubscribed &&
      countActiveOrPendingEmailSubscriptions(email) >=
        config.emailMaxActivePerAddress
    ) {
      return sendError(
        res,
        429,
        "Too many subscriptions for this email address",
      );
    }

    const subscription = upsertEmailSubscription({
      contractId,
      email,
      eventTypes,
      confirmToken: generateToken(),
      unsubscribeToken: generateToken(),
    });

    const confirmUrl = emailConfirmUrl(subscription.confirm_token);
    const unsubscribeUrl = emailUnsubscribeUrl(subscription.unsubscribe_token);
    const rendered = renderConfirmationEmail({
      contractId,
      confirmUrl,
      unsubscribeUrl,
    });

    // Fire-and-forget: the subscription exists regardless of whether the
    // confirmation email could be sent, and a slow SMTP server must not stall
    // the request.
    void sendMail({
      to: email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    }).then((ok) => {
      if (!ok) {
        logger.warn("Confirmation email could not be sent", { subscriptionId: subscription.id });
      }
    });

    sendSuccess(res, {
      subscription: {
        id: subscription.id,
        contract_id: subscription.contract_id,
        email: subscription.email,
        event_types: eventTypes,
        status: subscription.status,
      },
      message: "Confirmation email sent",
    });
  },
);

// GET /api/notifications/email/confirm?token=... — activate a pending row.
router.get("/email/confirm", (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!emailDeliveryEnabled()) {
    return res
      .status(503)
      .type("html")
      .send(htmlPage("Notifications unavailable", `<p>${escapeHtml(EMAIL_DISABLED_ERROR)}</p>`));
  }

  const subscription = token ? confirmEmailSubscription(token) : undefined;
  if (!subscription) {
    return res
      .status(400)
      .type("html")
      .send(
        htmlPage(
          "Invalid confirmation link",
          "<p>This confirmation link is invalid or has expired.</p>",
        ),
      );
  }

  const message =
    subscription.status === "active"
      ? "<p>Your email notifications are now active.</p>"
      : "<p>This subscription is no longer active.</p>";
  res.status(200).type("html").send(htmlPage("Subscription confirmed", message));
});

/** One-click opt-out shared by the GET link and the POST form. */
function handleUnsubscribe(req: import("express").Request, res: import("express").Response): void {
  const raw = req.method === "POST" ? req.body?.token : req.query.token;
  const token = typeof raw === "string" ? raw : "";

  if (!emailDeliveryEnabled()) {
    res
      .status(503)
      .type("html")
      .send(htmlPage("Notifications unavailable", `<p>${escapeHtml(EMAIL_DISABLED_ERROR)}</p>`));
    return;
  }

  const subscription = token ? unsubscribeEmailSubscription(token) : undefined;
  if (!subscription) {
    res
      .status(400)
      .type("html")
      .send(
        htmlPage(
          "Invalid unsubscribe link",
          "<p>This unsubscribe link is invalid or has expired.</p>",
        ),
      );
    return;
  }

  res
    .status(200)
    .type("html")
    .send(
      htmlPage(
        "Unsubscribed",
        "<p>You will no longer receive email notifications for this contract.</p>",
      ),
    );
}

router.get("/unsubscribe", emailIpRateLimiter, handleUnsubscribe);
router.post("/unsubscribe", emailIpRateLimiter, handleUnsubscribe);

/**
 * Root-mounted copy of the one-click opt-out route, so the link embedded in
 * outgoing emails (`GET /unsubscribe?token=...`) and the `/api` copy above
 * both resolve.
 */
export const unsubscribeRouter = Router();
unsubscribeRouter.get("/unsubscribe", emailIpRateLimiter, handleUnsubscribe);
unsubscribeRouter.post("/unsubscribe", emailIpRateLimiter, handleUnsubscribe);

export default router;
