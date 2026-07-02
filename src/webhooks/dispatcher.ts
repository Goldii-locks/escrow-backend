import { getWebhookSubscriptions } from "../indexer/db.js";
import { deliverWebhook } from "./deliver.js";
import type { MilestoneWebhookPayload } from "./milestone-events.js";

export function dispatchMilestoneWebhook(payload: MilestoneWebhookPayload): void {
  const subscriptions = getWebhookSubscriptions();
  if (subscriptions.length === 0) {
    return;
  }

  for (const subscription of subscriptions) {
    void deliverWebhook(subscription.url, payload);
  }
}
