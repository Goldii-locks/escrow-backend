const MILESTONE_EVENT_STATUS: Record<string, string> = {
  delivered: "delivered",
  approved: "approved",
  dispute_raised: "disputed",
  dispute_resolved: "resolved",
};

export const MILESTONE_WEBHOOK_EVENT_TYPES = Object.keys(MILESTONE_EVENT_STATUS);

export interface MilestoneWebhookPayload {
  contractId: string;
  milestoneIndex: number;
  newStatus: string;
  txHash: string;
}

export function isMilestoneWebhookEvent(eventType: string): boolean {
  return eventType in MILESTONE_EVENT_STATUS;
}

export function mapEventTypeToStatus(eventType: string): string {
  return MILESTONE_EVENT_STATUS[eventType];
}

export function parseMilestoneIndex(data: unknown): number | null {
  if (typeof data === "number" && Number.isInteger(data)) {
    return data;
  }

  if (typeof data === "bigint") {
    return Number(data);
  }

  if (Array.isArray(data) && data.length > 0) {
    const first = data[0];
    if (typeof first === "number" && Number.isInteger(first)) {
      return first;
    }
    if (typeof first === "bigint") {
      return Number(first);
    }
  }

  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    for (const key of ["index", "milestone_index", "milestone", "milestoneIndex"]) {
      const value = obj[key];
      if (typeof value === "number" && Number.isInteger(value)) {
        return value;
      }
      if (typeof value === "bigint") {
        return Number(value);
      }
    }
  }

  return null;
}

export function buildMilestoneWebhookPayload(
  contractId: string,
  eventType: string,
  data: unknown,
  txHash: string
): MilestoneWebhookPayload | null {
  if (!isMilestoneWebhookEvent(eventType)) {
    return null;
  }

  const milestoneIndex = parseMilestoneIndex(data);
  if (milestoneIndex === null) {
    return null;
  }

  return {
    contractId,
    milestoneIndex,
    newStatus: mapEventTypeToStatus(eventType),
    txHash,
  };
}
