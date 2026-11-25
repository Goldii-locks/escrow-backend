import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import request from "supertest";
import express from "express";
import {
  addSubscription,
  insertEvent,
  initSchema,
  setDb,
} from "../src/indexer/db.js";
import {
  parseWebhookFilters,
  subscriptionsMatchEvent,
} from "../src/indexer/webhook-delivery.js";
import { TEST_API_KEY } from "./helpers/api-key-helper.js";

let testDb: Database.Database;

const CONTRACT_ID = "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";
const CLIENT = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";
const FREELANCER = "GB5CRPXUGXZCG6BESL4CM4F3VUAGQGFNYNBHPBRJAGLXXSRYJSEGZHUV";
const ARBITER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const CALLER = "GABNCQRZNTG6MMITD33VHFITKJZ5PSYW2XVEXMP52BSMTPLU7WORDQNT";

beforeAll(() => {
  testDb = new Database(":memory:");
  setDb(testDb);
  initSchema();
});

afterAll(() => {
  testDb.close();
});

beforeEach(() => {
  testDb.exec("DELETE FROM webhook_subscriptions");
  testDb.exec("DELETE FROM events");
  testDb.exec("DELETE FROM webhook_deliveries");
});

describe("parseWebhookFilters", () => {
  it("returns null for absent/empty/malformed filters", () => {
    expect(parseWebhookFilters(null)).toBeNull();
    expect(parseWebhookFilters(undefined)).toBeNull();
    expect(parseWebhookFilters("")).toBeNull();
    expect(parseWebhookFilters("not-json")).toBeNull();
    expect(parseWebhookFilters("[]")).toBeNull();
    expect(parseWebhookFilters("null")).toBeNull();
  });

  it("parses a stored filters object", () => {
    expect(parseWebhookFilters('{"milestone_index":[0,2]}')).toEqual({
      milestone_index: [0, 2],
    });
    expect(parseWebhookFilters(`{"party":"${CLIENT}"}`)).toEqual({ party: CLIENT });
  });
});

describe("subscriptionsMatchEvent", () => {
  const baseEvent = { event_type: "milestone", data_json: "{}" };

  it("preserves event_types-only matching when no filters are set", () => {
    const sub = { event_types: '["milestone"]', filters_json: null };
    expect(subscriptionsMatchEvent(sub, baseEvent)).toBe(true);
    expect(
      subscriptionsMatchEvent(sub, { event_type: "other", data_json: "{}" }),
    ).toBe(false);

    const wildcard = { event_types: '"*"', filters_json: null };
    expect(subscriptionsMatchEvent(wildcard, baseEvent)).toBe(true);
  });

  it("matches milestone_index only for listed indices", () => {
    const sub = {
      event_types: '"*"',
      filters_json: '{"milestone_index":[0,2]}',
    };
    expect(
      subscriptionsMatchEvent(sub, {
        event_type: "milestone",
        data_json: '{"milestone_index":0}',
      }),
    ).toBe(true);
    expect(
      subscriptionsMatchEvent(sub, {
        event_type: "milestone",
        data_json: '{"milestone_index":2}',
      }),
    ).toBe(true);
    expect(
      subscriptionsMatchEvent(sub, {
        event_type: "milestone",
        data_json: '{"milestone_index":1}',
      }),
    ).toBe(false);
  });

  it("treats a missing milestone_index as a non-match when filtered", () => {
    const sub = {
      event_types: '"*"',
      filters_json: '{"milestone_index":[0]}',
    };
    expect(
      subscriptionsMatchEvent(sub, { event_type: "milestone", data_json: "{}" }),
    ).toBe(false);
    expect(
      subscriptionsMatchEvent(sub, {
        event_type: "milestone",
        data_json: "not-json",
      }),
    ).toBe(false);
  });

  it("matches party across client, freelancer, arbiter and caller", () => {
    for (const key of ["client", "freelancer", "arbiter", "caller"]) {
      const sub = { event_types: '"*"', filters_json: `{"party":"${CLIENT}"}` };
      const data = JSON.stringify({ [key]: CLIENT, milestone_index: 0 });
      expect(
        subscriptionsMatchEvent(sub, { event_type: "milestone", data_json: data }),
      ).toBe(true);
    }
  });

  it("treats a missing/other party as a non-match when filtered", () => {
    const sub = { event_types: '"*"', filters_json: `{"party":"${FREELANCER}"}` };
    expect(
      subscriptionsMatchEvent(sub, {
        event_type: "milestone",
        data_json: JSON.stringify({ client: CLIENT, arbiter: ARBITER }),
      }),
    ).toBe(false);
    expect(
      subscriptionsMatchEvent(sub, { event_type: "milestone", data_json: "{}" }),
    ).toBe(false);
  });

  it("requires every set filter to match", () => {
    const sub = {
      event_types: '"*"',
      filters_json: `{"milestone_index":[1],"party":"${CALLER}"}`,
    };
    expect(
      subscriptionsMatchEvent(sub, {
        event_type: "milestone",
        data_json: JSON.stringify({ milestone_index: 1, caller: CALLER }),
      }),
    ).toBe(true);
    expect(
      subscriptionsMatchEvent(sub, {
        event_type: "milestone",
        data_json: JSON.stringify({ milestone_index: 2, caller: CALLER }),
      }),
    ).toBe(false);
    expect(
      subscriptionsMatchEvent(sub, {
        event_type: "milestone",
        data_json: JSON.stringify({ milestone_index: 1, caller: CLIENT }),
      }),
    ).toBe(false);
  });
});

describe("dispatchSubscribe validates filters with Zod", () => {
  it("rejects a non-integer / negative milestone_index", async () => {
    const { dispatchSubscribe } = await import("../src/utils/webhook_dispatcher.js");
    const negative = dispatchSubscribe({
      contract_id: CONTRACT_ID,
      webhook_url: "https://example.com/hook",
      event_types: ["*"],
      filters: { milestone_index: [-1] },
    });
    expect(negative.ok).toBe(false);
    expect(!negative.ok && negative.status).toBe(400);

    const decimal = dispatchSubscribe({
      contract_id: CONTRACT_ID,
      webhook_url: "https://example.com/hook",
      event_types: ["*"],
      filters: { milestone_index: [1.5] },
    });
    expect(decimal.ok).toBe(false);
  });

  it("rejects an invalid party address and unknown filter keys", async () => {
    const { dispatchSubscribe } = await import("../src/utils/webhook_dispatcher.js");
    const badParty = dispatchSubscribe({
      contract_id: CONTRACT_ID,
      webhook_url: "https://example.com/hook",
      event_types: ["*"],
      filters: { party: "not-a-stellar-address" },
    });
    expect(badParty.ok).toBe(false);

    const unknownKey = dispatchSubscribe({
      contract_id: CONTRACT_ID,
      webhook_url: "https://example.com/hook",
      event_types: ["*"],
      filters: { milestone_index: [0], bogus: true },
    });
    expect(unknownKey.ok).toBe(false);
  });
});

describe("webhook delivery honours subscription filters", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockFetchOk() {
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it("delivers only the milestone events listed in the filter", async () => {
    const { deliverWebhooks } = await import("../src/indexer/webhook-delivery.js");
    const fetchMock = mockFetchOk();

    addSubscription(CONTRACT_ID, "https://example.com/hook", ["*"], {
      milestone_index: [0, 2],
    });

    insertEvent(CONTRACT_ID, "milestone", 3000, 1, '{"milestone_index":0}');
    insertEvent(CONTRACT_ID, "milestone", 3001, 2, '{"milestone_index":1}');
    insertEvent(CONTRACT_ID, "milestone", 3002, 3, '{"milestone_index":2}');

    const results = await deliverWebhooks(3000, 3002);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.success)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("delivers only events whose party field matches the filter", async () => {
    const { deliverWebhooks } = await import("../src/indexer/webhook-delivery.js");
    const fetchMock = mockFetchOk();

    addSubscription(CONTRACT_ID, "https://example.com/hook", ["*"], {
      party: FREELANCER,
    });

    insertEvent(CONTRACT_ID, "milestone", 3100, 1, JSON.stringify({ client: CLIENT }));
    insertEvent(
      CONTRACT_ID,
      "milestone",
      3101,
      2,
      JSON.stringify({ freelancer: FREELANCER }),
    );
    insertEvent(CONTRACT_ID, "milestone", 3102, 3, JSON.stringify({ arbiter: ARBITER }));

    const results = await deliverWebhooks(3100, 3102);

    expect(results).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("behaves identically to before when no filters are stored", async () => {
    const { deliverWebhooks } = await import("../src/indexer/webhook-delivery.js");
    const fetchMock = mockFetchOk();

    addSubscription(CONTRACT_ID, "https://example.com/hook", ["*"], null);

    insertEvent(CONTRACT_ID, "milestone", 3200, 1, '{"milestone_index":0}');
    insertEvent(CONTRACT_ID, "milestone", 3201, 2, '{"milestone_index":1}');
    insertEvent(CONTRACT_ID, "milestone", 3202, 3, '{"milestone_index":2}');

    const results = await deliverWebhooks(3200, 3202);

    expect(results).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("GET /api/webhooks/subscriptions echoes parsed filters", () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: router } = await import("../src/routes/webhooks.js");
    app = express();
    app.use(express.json());
    app.use("/api/webhooks", router);
  });

  it("returns the parsed filters object and null when unset", async () => {
    addSubscription(CONTRACT_ID, "https://example.com/with-filters", ["*"], {
      milestone_index: [0, 2],
      party: CLIENT,
    });
    addSubscription(CONTRACT_ID, "https://example.com/no-filters", ["*"], null);

    const res = await request(app)
      .get("/api/webhooks/subscriptions")
      .query({ contract_id: CONTRACT_ID })
      .set("x-api-key", TEST_API_KEY);

    expect(res.status).toBe(200);
    const subs = (res.body.data.subscriptions as Array<{
      webhook_url: string;
      filters: unknown;
    }>);
    const withFilters = subs.find((s) => s.webhook_url.includes("with-filters"));
    const withoutFilters = subs.find((s) => s.webhook_url.includes("no-filters"));

    expect(withFilters?.filters).toEqual({ milestone_index: [0, 2], party: CLIENT });
    expect(withoutFilters?.filters).toBeNull();
  });
});
