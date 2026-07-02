import type { MilestoneWebhookPayload } from "./milestone-events.js";

const MAX_ATTEMPTS = 3;

function getRetryDelayMs(): number {
  return parseInt(process.env.WEBHOOK_RETRY_DELAY_MS || "1000", 10);
}

export async function deliverWebhook(
  url: string,
  payload: MilestoneWebhookPayload
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        return true;
      }

      console.error(
        `Webhook delivery attempt ${attempt}/${MAX_ATTEMPTS} to ${url} failed with status ${response.status}`
      );
    } catch (err) {
      console.error(
        `Webhook delivery attempt ${attempt}/${MAX_ATTEMPTS} to ${url} failed:`,
        err
      );
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) =>
        setTimeout(resolve, getRetryDelayMs() * attempt)
      );
    }
  }

  console.error(
    `Webhook delivery to ${url} failed after ${MAX_ATTEMPTS} attempts`
  );
  return false;
}
