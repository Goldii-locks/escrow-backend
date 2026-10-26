import {
  EVENT_TYPES,
  isKnownEventType,
  buildGetEventsRequest,
} from "../src/indexer/event_type_filter.js";

// ---------------------------------------------------------------------------
// EVENT_TYPES – contract-derived topics (#687)
// ---------------------------------------------------------------------------

describe("EVENT_TYPES", () => {
  it("contains exactly the contract's emitted topics", () => {
    expect(EVENT_TYPES.length).toBe(82);
  });

  it("contains the core lifecycle discriminators", () => {
    for (const topic of [
      "init",
      "fund",
      "deliver",
      "approve",
      "dispute",
      "resolve",
      "claim",
      "cancel",
      "arbsplit",
      "wtok",
      "wldel",
    ]) {
      expect(EVENT_TYPES).toContain(topic);
    }
  });

  it("has no topic longer than symbol_short!'s 9-character limit", () => {
    for (const topic of EVENT_TYPES) {
      expect(typeof topic).toBe("string");
      expect(topic.length).toBeGreaterThan(0);
      expect(topic.length).toBeLessThanOrEqual(9);
    }
  });

  it("has no duplicated topics", () => {
    expect(new Set([...EVENT_TYPES]).size).toBe(EVENT_TYPES.length);
  });

  it("isKnownEventType accepts known topics and rejects unknown ones", () => {
    expect(isKnownEventType("fund")).toBe(true);
    expect(isKnownEventType("arbsplit")).toBe(true);
    expect(isKnownEventType("initialized")).toBe(false);
    expect(isKnownEventType("token_whitelisted")).toBe(false);
    expect(isKnownEventType("")).toBe(false);
    expect(isKnownEventType(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildGetEventsRequest – wildcard request building (#688)
// ---------------------------------------------------------------------------

describe("buildGetEventsRequest", () => {
  it("sends a wildcard topic filter, never an EVENT_TYPES enumeration", () => {
    const request = buildGetEventsRequest({
      startLedger: 42,
      contractIds: ["CONTRACT-ALPHA"],
      limit: 100,
    });

    expect(request.filters).toHaveLength(1);
    expect(request.filters[0].type).toBe("contract");
    expect(request.filters[0].contractIds).toEqual(["CONTRACT-ALPHA"]);
    expect(request.filters[0].topics).toEqual([["*"]]);
    for (const eventType of EVENT_TYPES) {
      expect(request.filters[0].topics.flat()).not.toContain(eventType);
    }
  });

  it("passes startLedger and limit through, defaulting limit to 100", () => {
    expect(
      buildGetEventsRequest({ startLedger: 999, contractIds: ["C1", "C2"], limit: 50 })
        .limit
    ).toBe(50);
    const withDefault = buildGetEventsRequest({ startLedger: 1, contractIds: ["C"] });
    expect(withDefault.limit).toBe(100);
    expect(withDefault.startLedger).toBe(1);
  });

  it("supports cursor paging without a startLedger", () => {
    const request = buildGetEventsRequest({ cursor: "cursor-1", limit: 100 });
    expect(request.cursor).toBe("cursor-1");
    expect(request.startLedger).toBeUndefined();
  });
});
