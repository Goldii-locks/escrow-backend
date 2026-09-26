/**
 * Tests for webhook_dispatcher covering issues #516–#519.
 */

import Database from "better-sqlite3";
import {
  initSchema,
  setDb,
  closeDb,
} from "../src/indexer/db.js";
import {
  parseTemplateConfig,
  interpolateTemplate,
  renderTemplateConfig,
  ensureWebhookDispatcherSchema,
  resetWebhookDispatcherSchemaFlag,
  insertActivityHistory,
  getActivityHistory,
  setNotificationSwitch,
  getNotificationSwitch,
  shouldIgnoreAlert,
  filterDeliverableAlerts,
  WebhookBatchBuffer,
  dispatchWebhookAlerts,
  type DispatchAlert,
  type DeliveryTarget,
} from "../src/indexer/webhook_dispatcher.js";

let testDb: Database.Database;

beforeAll(() => {
  testDb = new Database(":memory:");
  setDb(testDb);
  initSchema();
  ensureWebhookDispatcherSchema();
});

afterAll(() => {
  testDb.close();
  closeDb();
});

beforeEach(() => {
  testDb.exec("DELETE FROM webhook_activity_history");
  testDb.exec("DELETE FROM webhook_notification_switches");
});

// ---------------------------------------------------------------------------
// #516 – Template structure parsing (no HTML escaping)
// ---------------------------------------------------------------------------

describe("#516 template structure parsing", () => {
  it("parses a valid template configuration", () => {
    const config = parseTemplateConfig({
      template: "Job {{jobId}} funded by {{funder}}",
      variables: { jobId: "42", funder: "Alice" },
      eventType: "funded",
      channel: "webhook",
    });

    expect(config.template).toBe("Job {{jobId}} funded by {{funder}}");
    expect(config.variables).toEqual({ jobId: "42", funder: "Alice" });
    expect(config.eventType).toBe("funded");
    expect(config.channel).toBe("webhook");
  });

  it("interpolates variables without escaping HTML markup", () => {
    const html = '<b>Alert</b> & <script>alert("x")</script>';
    const rendered = interpolateTemplate("Payload: {{body}}", {
      body: html,
    });

    expect(rendered).toBe(`Payload: ${html}`);
    expect(rendered).toContain("<script>");
    expect(rendered).toContain("&");
    // Must NOT produce HTML entities
    expect(rendered).not.toContain("&lt;");
    expect(rendered).not.toContain("&gt;");
    expect(rendered).not.toContain("&amp;");
  });

  it("renderTemplateConfig parses + interpolates in one step without escaping", () => {
    const { rendered, config } = renderTemplateConfig({
      template: "Hello {{name}} — {{note}}",
      variables: {
        name: "<em>Bob</em>",
        note: "a & b",
      },
    });

    expect(config.variables.name).toBe("<em>Bob</em>");
    expect(rendered).toBe("Hello <em>Bob</em> — a & b");
    expect(rendered).not.toMatch(/&lt;|&gt;|&amp;/);
  });

  it("replaces missing variables with empty string", () => {
    expect(interpolateTemplate("Hi {{who}}!", {})).toBe("Hi !");
  });

  it("rejects non-object template configs", () => {
    expect(() => parseTemplateConfig(null)).toThrow(/plain object/);
    expect(() => parseTemplateConfig("nope")).toThrow(/plain object/);
    expect(() => parseTemplateConfig([])).toThrow(/plain object/);
  });

  it("rejects configs without a string template", () => {
    expect(() => parseTemplateConfig({ variables: {} })).toThrow(
      /string `template`/,
    );
  });

  it("rejects non-object variables maps", () => {
    expect(() =>
      parseTemplateConfig({ template: "x", variables: ["a"] }),
    ).toThrow(/variables/);
  });

  it("supports number and boolean variable values", () => {
    const rendered = interpolateTemplate("n={{n}} ok={{ok}}", {
      n: 7,
      ok: true,
    });
    expect(rendered).toBe("n=7 ok=true");
  });
});

// ---------------------------------------------------------------------------
// #517 – Activity history row inserts under transactions
// ---------------------------------------------------------------------------

describe("#517 activity history row entry operations", () => {
  it("inserts tracking rows inside an active transaction", () => {
    const rows = insertActivityHistory({
      recipientId: "recipient-a",
      eventType: "funded",
      channel: "webhook",
      payload: { amount: 100 },
      status: "logged",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_id).toBe("recipient-a");
    expect(rows[0].event_type).toBe("funded");
    expect(rows[0].status).toBe("logged");
    expect(JSON.parse(rows[0].payload_json)).toEqual({ amount: 100 });

    const stored = getActivityHistory("recipient-a");
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(rows[0].id);
  });

  it("commits multiple tracking rows atomically in one transaction", () => {
    const rows = insertActivityHistory([
      {
        recipientId: "r1",
        eventType: "funded",
        payload: { i: 1 },
      },
      {
        recipientId: "r2",
        eventType: "approved",
        payload: { i: 2 },
      },
      {
        recipientId: "r1",
        eventType: "released",
        payload: { i: 3 },
      },
    ]);

    expect(rows).toHaveLength(3);
    expect(getActivityHistory()).toHaveLength(3);
    expect(getActivityHistory("r1")).toHaveLength(2);
  });

  it("rolls back the whole batch when one insert is invalid", () => {
    expect(() =>
      insertActivityHistory([
        {
          recipientId: "ok",
          eventType: "funded",
          payload: {},
        },
        {
          recipientId: "",
          eventType: "funded",
          payload: {},
        },
      ]),
    ).toThrow(/recipientId and eventType/);

    // Nothing from the failed transaction should remain
    expect(getActivityHistory()).toHaveLength(0);
  });

  it("populates rows when dispatchWebhookAlerts runs under a live db", async () => {
    const targets = await dispatchWebhookAlerts([
      {
        recipientId: "dispatch-user",
        eventType: "funded",
        channel: "webhook",
        payload: { job: "J1" },
        template: {
          template: "Job {{job}} ready",
          variables: {},
        },
      },
    ]);

    expect(targets).toHaveLength(1);
    expect(targets[0].body).toBe("Job J1 ready");

    const history = getActivityHistory("dispatch-user");
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("dispatched");
    expect(history[0].event_type).toBe("funded");
  });
});

// ---------------------------------------------------------------------------
// #518 – Notification switch constraints (opt-out)
// ---------------------------------------------------------------------------

describe("#518 notification switch constraints", () => {
  it("stores and reads notification switches", () => {
    const saved = setNotificationSwitch({
      recipient_id: "user-1",
      opted_out: false,
      enabled_channels: ["webhook", "email"],
      muted_event_types: ["marketing"],
    });

    expect(saved.opted_out).toBe(false);
    expect(saved.enabled_channels).toEqual(["webhook", "email"]);
    expect(getNotificationSwitch("user-1")?.muted_event_types).toEqual([
      "marketing",
    ]);
  });

  it("ignores alerts for opted-out recipients", () => {
    setNotificationSwitch({
      recipient_id: "opted-out-user",
      opted_out: true,
      enabled_channels: [],
      muted_event_types: [],
    });

    expect(shouldIgnoreAlert("opted-out-user", "funded")).toBe(true);
    expect(shouldIgnoreAlert("unknown-user", "funded")).toBe(false);
  });

  it("ignores muted event types even when opted in", () => {
    setNotificationSwitch({
      recipient_id: "muted-user",
      opted_out: false,
      enabled_channels: [],
      muted_event_types: ["spam", "promo"],
    });

    expect(shouldIgnoreAlert("muted-user", "spam")).toBe(true);
    expect(shouldIgnoreAlert("muted-user", "funded")).toBe(false);
  });

  it("ignores channels that are not in enabled_channels", () => {
    setNotificationSwitch({
      recipient_id: "channel-user",
      opted_out: false,
      enabled_channels: ["email"],
      muted_event_types: [],
    });

    expect(shouldIgnoreAlert("channel-user", "funded", "webhook")).toBe(true);
    expect(shouldIgnoreAlert("channel-user", "funded", "email")).toBe(false);
  });

  it("filterDeliverableAlerts drops opted-out recipients", () => {
    setNotificationSwitch({
      recipient_id: "skip-me",
      opted_out: true,
      enabled_channels: [],
      muted_event_types: [],
    });

    const alerts: DispatchAlert[] = [
      {
        recipientId: "skip-me",
        eventType: "funded",
        channel: "webhook",
        payload: {},
      },
      {
        recipientId: "keep-me",
        eventType: "funded",
        channel: "webhook",
        payload: { ok: true },
      },
    ];

    const kept = filterDeliverableAlerts(alerts);
    expect(kept).toHaveLength(1);
    expect(kept[0].recipientId).toBe("keep-me");
  });

  it("dispatchWebhookAlerts skips opted-out recipients entirely", async () => {
    setNotificationSwitch({
      recipient_id: "no-alerts",
      opted_out: true,
      enabled_channels: [],
      muted_event_types: [],
    });

    const delivered: DeliveryTarget[] = [];
    const targets = await dispatchWebhookAlerts(
      [
        {
          recipientId: "no-alerts",
          eventType: "funded",
          channel: "webhook",
          payload: { x: 1 },
        },
        {
          recipientId: "yes-alerts",
          eventType: "funded",
          channel: "webhook",
          payload: { x: 2 },
        },
      ],
      async (batch) => {
        delivered.push(...batch);
      },
    );

    expect(targets).toHaveLength(1);
    expect(targets[0].recipientId).toBe("yes-alerts");
    expect(delivered).toHaveLength(1);
    expect(getActivityHistory("no-alerts")).toHaveLength(0);
    expect(getActivityHistory("yes-alerts")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// #519 – Bulk batching buffers
// ---------------------------------------------------------------------------

describe("#519 bulk batching buffers", () => {
  it("aggregates triggers before hitting the delivery service", async () => {
    const deliveries: DeliveryTarget[][] = [];
    const buffer = new WebhookBatchBuffer(
      async (batch) => {
        deliveries.push(batch);
      },
      { maxBatchSize: 3 },
    );

    const mk = (id: string): DispatchAlert => ({
      recipientId: id,
      eventType: "funded",
      channel: "webhook",
      payload: { id },
      template: { template: "id={{id}}", variables: {} },
    });

    expect(await buffer.enqueue(mk("a"))).toBeNull();
    expect(await buffer.enqueue(mk("b"))).toBeNull();
    expect(deliveries).toHaveLength(0);
    expect(buffer.size).toBe(2);

    const flushed = await buffer.enqueue(mk("c"));
    expect(flushed).not.toBeNull();
    expect(flushed).toHaveLength(3);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].map((t) => t.recipientId)).toEqual(["a", "b", "c"]);
    expect(buffer.size).toBe(0);
    expect(buffer.deliveriesMade).toBe(1);

    buffer.dispose();
  });

  it("manual flush delivers remaining buffered alerts once", async () => {
    const deliveries: DeliveryTarget[][] = [];
    const buffer = new WebhookBatchBuffer(
      (batch) => {
        deliveries.push([...batch]);
      },
      { maxBatchSize: 10 },
    );

    await buffer.enqueue({
      recipientId: "r1",
      eventType: "approved",
      channel: "webhook",
      payload: { n: 1 },
    });
    await buffer.enqueue({
      recipientId: "r2",
      eventType: "approved",
      channel: "webhook",
      payload: { n: 2 },
    });

    expect(deliveries).toHaveLength(0);
    const targets = await buffer.flush();
    expect(targets).toHaveLength(2);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toHaveLength(2);

    // Second flush with empty buffer is a no-op
    expect(await buffer.flush()).toEqual([]);
    expect(deliveries).toHaveLength(1);

    buffer.dispose();
  });

  it("batch flush respects opt-out switches before delivery", async () => {
    setNotificationSwitch({
      recipient_id: "blocked",
      opted_out: true,
      enabled_channels: [],
      muted_event_types: [],
    });

    const deliveries: DeliveryTarget[][] = [];
    const buffer = new WebhookBatchBuffer(
      (batch) => {
        deliveries.push([...batch]);
      },
      { maxBatchSize: 2 },
    );

    await buffer.enqueue({
      recipientId: "blocked",
      eventType: "funded",
      channel: "webhook",
      payload: {},
    });
    await buffer.enqueue({
      recipientId: "allowed",
      eventType: "funded",
      channel: "webhook",
      payload: { ok: true },
    });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toHaveLength(1);
    expect(deliveries[0][0].recipientId).toBe("allowed");
    expect(getActivityHistory("blocked")).toHaveLength(0);
    expect(getActivityHistory("allowed")).toHaveLength(1);

    buffer.dispose();
  });

  it("does not call delivery until the buffer threshold is met", async () => {
    let callCount = 0;
    const buffer = new WebhookBatchBuffer(
      () => {
        callCount += 1;
      },
      { maxBatchSize: 5 },
    );

    for (let i = 0; i < 4; i++) {
      await buffer.enqueue({
        recipientId: `u${i}`,
        eventType: "funded",
        channel: "webhook",
        payload: { i },
      });
    }

    expect(callCount).toBe(0);
    expect(buffer.deliveriesMade).toBe(0);

    await buffer.enqueue({
      recipientId: "u4",
      eventType: "funded",
      channel: "webhook",
      payload: { i: 4 },
    });

    expect(callCount).toBe(1);
    expect(buffer.deliveriesMade).toBe(1);

    buffer.dispose();
  });
});

describe("schema bootstrap", () => {
  it("is idempotent when ensureWebhookDispatcherSchema is called again", () => {
    resetWebhookDispatcherSchemaFlag();
    ensureWebhookDispatcherSchema();
    ensureWebhookDispatcherSchema();

    const tables = testDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN (?, ?)",
      )
      .all("webhook_activity_history", "webhook_notification_switches") as Array<{
      name: string;
    }>;

    expect(tables.map((t) => t.name).sort()).toEqual([
      "webhook_activity_history",
      "webhook_notification_switches",
    ]);
  });
});
