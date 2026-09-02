const {
  MILESTONE_WEBHOOK_EVENT_TYPES,
  isMilestoneWebhookEvent,
  mapEventTypeToStatus,
  parseMilestoneIndex,
  buildMilestoneWebhookPayload,
} = await import("../src/webhooks/milestone-events.js");

const CONTRACT = "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";
const TX = "abc123";

describe("isMilestoneWebhookEvent", () => {
  it("accepts every advertised event type", () => {
    for (const type of MILESTONE_WEBHOOK_EVENT_TYPES) {
      expect(isMilestoneWebhookEvent(type)).toBe(true);
    }
  });

  it("rejects unknown event types", () => {
    expect(isMilestoneWebhookEvent("funded")).toBe(false);
    expect(isMilestoneWebhookEvent("")).toBe(false);
  });

  // `in` checks the prototype chain, so these must not read as known events.
  it("rejects inherited Object properties", () => {
    expect(isMilestoneWebhookEvent("toString")).toBe(false);
    expect(isMilestoneWebhookEvent("constructor")).toBe(false);
    expect(isMilestoneWebhookEvent("__proto__")).toBe(false);
  });
});

describe("mapEventTypeToStatus", () => {
  it("returns undefined for an inherited property rather than a function", () => {
    expect(mapEventTypeToStatus("toString")).toBeUndefined();
    expect(mapEventTypeToStatus("constructor")).toBeUndefined();
  });

  it("maps each event type to its milestone status", () => {
    expect(mapEventTypeToStatus("delivered")).toBe("delivered");
    expect(mapEventTypeToStatus("approved")).toBe("approved");
    expect(mapEventTypeToStatus("dispute_raised")).toBe("disputed");
    expect(mapEventTypeToStatus("dispute_resolved")).toBe("resolved");
  });
});

describe("parseMilestoneIndex", () => {
  it("reads a plain integer", () => {
    expect(parseMilestoneIndex(0)).toBe(0);
    expect(parseMilestoneIndex(3)).toBe(3);
  });

  it("reads a bigint, as the Soroban RPC returns", () => {
    expect(parseMilestoneIndex(2n)).toBe(2);
  });

  it("reads the first element of an argument array", () => {
    expect(parseMilestoneIndex([1, "ignored"])).toBe(1);
    expect(parseMilestoneIndex([4n])).toBe(4);
  });

  it("reads any of the accepted object keys", () => {
    expect(parseMilestoneIndex({ index: 1 })).toBe(1);
    expect(parseMilestoneIndex({ milestone_index: 2 })).toBe(2);
    expect(parseMilestoneIndex({ milestone: 3 })).toBe(3);
    expect(parseMilestoneIndex({ milestoneIndex: 4 })).toBe(4);
    expect(parseMilestoneIndex({ milestone_index: 5n })).toBe(5);
  });

  it("prefers the earliest key when several are present", () => {
    expect(parseMilestoneIndex({ milestoneIndex: 9, index: 1 })).toBe(1);
  });

  it("returns null for values it cannot read as an index", () => {
    expect(parseMilestoneIndex(undefined)).toBeNull();
    expect(parseMilestoneIndex(null)).toBeNull();
    expect(parseMilestoneIndex("2")).toBeNull();
    expect(parseMilestoneIndex([])).toBeNull();
    expect(parseMilestoneIndex(["2"])).toBeNull();
    expect(parseMilestoneIndex({})).toBeNull();
    expect(parseMilestoneIndex({ other: 1 })).toBeNull();
  });

  // A non-integer index would address a milestone that does not exist.
  it("rejects non-integer numbers", () => {
    expect(parseMilestoneIndex(1.5)).toBeNull();
    expect(parseMilestoneIndex([1.5])).toBeNull();
    expect(parseMilestoneIndex({ index: 1.5 })).toBeNull();
    expect(parseMilestoneIndex(NaN)).toBeNull();
    expect(parseMilestoneIndex(Infinity)).toBeNull();
  });
});

describe("buildMilestoneWebhookPayload", () => {
  it("builds a payload for a known event with a readable index", () => {
    expect(
      buildMilestoneWebhookPayload(CONTRACT, "dispute_raised", { index: 2 }, TX)
    ).toEqual({
      contractId: CONTRACT,
      milestoneIndex: 2,
      newStatus: "disputed",
      txHash: TX,
    });
  });

  it("returns null for an event type that is not a milestone event", () => {
    expect(
      buildMilestoneWebhookPayload(CONTRACT, "escrow_funded", { index: 0 }, TX)
    ).toBeNull();
  });

  // Before Object.hasOwn, this passed the guard and produced a payload whose
  // newStatus was Object.prototype.toString -- a function, which JSON.stringify
  // drops, so subscribers received a webhook with no newStatus field at all.
  it("returns null for an inherited property posing as an event type", () => {
    expect(
      buildMilestoneWebhookPayload(CONTRACT, "toString", { index: 1 }, TX)
    ).toBeNull();
    expect(
      buildMilestoneWebhookPayload(CONTRACT, "constructor", { index: 1 }, TX)
    ).toBeNull();
  });

  it("returns null when the milestone index cannot be read", () => {
    expect(
      buildMilestoneWebhookPayload(CONTRACT, "approved", { nope: 1 }, TX)
    ).toBeNull();
  });

  it("keeps index 0, which must not be discarded as falsy", () => {
    const payload = buildMilestoneWebhookPayload(CONTRACT, "approved", 0, TX);
    expect(payload).not.toBeNull();
    expect(payload?.milestoneIndex).toBe(0);
  });
});
