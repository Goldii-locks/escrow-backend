import { jest } from "@jest/globals";
import {
  ERROR_CODES,
  DEFAULT_WEBHOOK_PAYLOAD_SCHEMA,
  WebhookTimeoutError,
  isTimeoutError,
  setWebhookTimeoutConfig,
  getWebhookTimeoutConfig,
  resetWebhookTimeoutConfig,
  serializeWebhookPayload,
  assertPayloadMatchesSchema,
  setWebhookPayloadSchema,
  getWebhookPayloadSchema,
  resetWebhookPayloadSchema,
  computeWebhookBackoffMs,
  setWebhookRetryConfig,
  getWebhookRetryConfig,
  resetWebhookRetryConfig,
  enqueueWebhookRetry,
  getWebhookRetryQueue,
  clearWebhookRetryQueue,
  peekDueRetryItems,
  dequeueDueRetryItems,
  dispatchWebhook,
  dispatchWebhookWithRetry,
  processWebhookRetryQueue,
  type FetchLike,
  type PayloadSchemaTemplate,
} from "../src/indexer/webhook_dispatcher.js";

const SAMPLE_EVENT = {
  event_type: "funded",
  contract_id: "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901",
  ledger_sequence: 12345,
  timestamp: "2026-01-01T00:00:00Z",
  data: { amount: "100" },
};

function mockFetchOk(status = 200): FetchLike {
  return jest.fn<FetchLike>().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
  } as Response);
}

function mockFetchTimeout(timeoutMs = 50): FetchLike {
  return jest.fn<FetchLike>().mockImplementation((_url, init) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      const onAbort = () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      setTimeout(() => {
        // stay pending until aborted
      }, timeoutMs * 10);
    });
  });
}

beforeEach(() => {
  resetWebhookTimeoutConfig();
  resetWebhookPayloadSchema();
  resetWebhookRetryConfig();
  clearWebhookRetryQueue();
});

describe("webhook_dispatcher — call timeout exceptions (#513)", () => {
  it("exposes configurable timeout thresholds", () => {
    expect(getWebhookTimeoutConfig().timeoutMs).toBe(5000);
    setWebhookTimeoutConfig({ timeoutMs: 100, connectTimeoutMs: 50 });
    expect(getWebhookTimeoutConfig()).toEqual({
      timeoutMs: 100,
      connectTimeoutMs: 50,
    });
  });

  it("terminates stalled requests and returns CALL_TIMEOUT warning", async () => {
    setWebhookTimeoutConfig({ timeoutMs: 40 });
    const fetchImpl = mockFetchTimeout(40);

    const result = await dispatchWebhook(
      "https://example.com/webhook",
      SAMPLE_EVENT,
      { fetchImpl, timeoutMs: 40 }
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe(ERROR_CODES.CALL_TIMEOUT);
    expect(result.error).toMatch(/timeout threshold of 40ms/i);
    expect(result.timeoutMs).toBe(40);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = (fetchImpl as jest.MockedFunction<FetchLike>).mock.calls[0][1];
    expect(init?.signal).toBeDefined();
  });

  it("isTimeoutError recognizes abort / timeout errors", () => {
    expect(isTimeoutError(new WebhookTimeoutError(100))).toBe(true);
    expect(isTimeoutError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isTimeoutError(new Error("connect ETIMEDOUT"))).toBe(true);
    expect(isTimeoutError(new Error("boom"))).toBe(false);
  });

  it("returns success when the remote responds before the threshold", async () => {
    const fetchImpl = mockFetchOk(200);
    const result = await dispatchWebhook(
      "https://example.com/webhook",
      SAMPLE_EVENT,
      { fetchImpl, timeoutMs: 1000 }
    );
    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    expect(result.code).toBeUndefined();
  });

  it("rejects invalid webhook URLs without calling fetch", async () => {
    const fetchImpl = mockFetchOk();
    const result = await dispatchWebhook("not-a-url", SAMPLE_EVENT, {
      fetchImpl,
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe(ERROR_CODES.INVALID_URL);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("webhook_dispatcher — payload schema formatting (#514)", () => {
  it("serializes events to match the default config template", () => {
    const result = serializeWebhookPayload(SAMPLE_EVENT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual({
        event_type: SAMPLE_EVENT.event_type,
        contract_id: SAMPLE_EVENT.contract_id,
        ledger_sequence: SAMPLE_EVENT.ledger_sequence,
        timestamp: SAMPLE_EVENT.timestamp,
        data: SAMPLE_EVENT.data,
        schema: "escrow.event.v1",
      });
      expect(JSON.parse(result.body)).toEqual(result.payload);
      expect(assertPayloadMatchesSchema(result.payload).ok).toBe(true);
    }
  });

  it("fails when required fields are missing", () => {
    const result = serializeWebhookPayload({
      event_type: "funded",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.SCHEMA_MISMATCH);
      expect(result.error).toMatch(/Missing required payload field/i);
    }
  });

  it("fails when field types do not match the template", () => {
    const result = serializeWebhookPayload({
      ...SAMPLE_EVENT,
      ledger_sequence: "12345",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.SCHEMA_MISMATCH);
      expect(result.error).toMatch(/expected type number/i);
    }
  });

  it("supports dynamic schema templates via setWebhookPayloadSchema", () => {
    const custom: PayloadSchemaTemplate = {
      name: "escrow.event.v2",
      strict: true,
      fields: [
        { name: "type", type: "string", required: true, source: "event_type" },
        { name: "id", type: "string", required: true, source: "contract_id" },
        {
          name: "version",
          type: "number",
          required: false,
          default: 2,
        },
      ],
    };
    setWebhookPayloadSchema(custom);
    expect(getWebhookPayloadSchema().name).toBe("escrow.event.v2");

    const result = serializeWebhookPayload(SAMPLE_EVENT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual({
        type: SAMPLE_EVENT.event_type,
        id: SAMPLE_EVENT.contract_id,
        version: 2,
      });
      expect(assertPayloadMatchesSchema(result.payload, custom).ok).toBe(true);
    }
  });

  it("dispatchWebhook sends the serialized schema-aligned body", async () => {
    const fetchImpl = mockFetchOk(201);
    const result = await dispatchWebhook(
      "https://hooks.example/escrow",
      SAMPLE_EVENT,
      { fetchImpl }
    );
    expect(result.success).toBe(true);
    expect(result.payload?.schema).toBe(DEFAULT_WEBHOOK_PAYLOAD_SCHEMA.name);

    const [, init] = (fetchImpl as jest.MockedFunction<FetchLike>).mock.calls[0];
    const sent = JSON.parse(String(init?.body));
    expect(assertPayloadMatchesSchema(sent).ok).toBe(true);
  });
});

describe("webhook_dispatcher — retry delays and intervals (#515)", () => {
  it("scales retry delays according to configuration thresholds", () => {
    setWebhookRetryConfig({
      initialBackoffMs: 100,
      backoffMultiplier: 2,
      maxBackoffMs: 1000,
    });

    expect(computeWebhookBackoffMs(0)).toBe(100);
    expect(computeWebhookBackoffMs(1)).toBe(200);
    expect(computeWebhookBackoffMs(2)).toBe(400);
    expect(computeWebhookBackoffMs(3)).toBe(800);
    expect(computeWebhookBackoffMs(4)).toBe(1000); // capped
    expect(computeWebhookBackoffMs(10)).toBe(1000);

    const delays = [0, 1, 2, 3].map((i) => computeWebhookBackoffMs(i));
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    }

    expect(getWebhookRetryConfig().maxRetries).toBe(3);
  });

  it("enqueues retry items with increasing nextAttemptAt delays", () => {
    setWebhookRetryConfig({
      initialBackoffMs: 50,
      backoffMultiplier: 3,
      maxBackoffMs: 5000,
    });

    const now = Date.now();
    const a = enqueueWebhookRetry({
      id: "a",
      webhookUrl: "https://example.com/a",
      event: SAMPLE_EVENT,
      attempts: 0,
      nextAttemptAt: now + computeWebhookBackoffMs(0),
    });
    const b = enqueueWebhookRetry({
      id: "b",
      webhookUrl: "https://example.com/b",
      event: SAMPLE_EVENT,
      attempts: 1,
      nextAttemptAt: now + computeWebhookBackoffMs(1),
    });

    expect(b.nextAttemptAt - now).toBeGreaterThan(a.nextAttemptAt - now);
    expect(getWebhookRetryQueue()).toHaveLength(2);
    expect(peekDueRetryItems(now).map((i) => i.id)).toEqual([]);
    expect(peekDueRetryItems(a.nextAttemptAt).map((i) => i.id)).toEqual(["a"]);
  });

  it("dispatchWebhookWithRetry records scaled delay intervals on failure", async () => {
    setWebhookRetryConfig({
      maxRetries: 4,
      initialBackoffMs: 100,
      backoffMultiplier: 2,
      maxBackoffMs: 10_000,
    });

    const fetchImpl = jest
      .fn<FetchLike>()
      .mockRejectedValue(new Error("ECONNRESET"));

    const delaysSeen: number[] = [];
    const result = await dispatchWebhookWithRetry(
      "https://example.com/webhook",
      SAMPLE_EVENT,
      {
        fetchImpl,
        sleepFn: async (ms) => {
          delaysSeen.push(ms);
        },
      }
    );

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(4);
    expect(result.delays).toEqual([100, 200, 400]);
    expect(delaysSeen).toEqual([100, 200, 400]);
    for (let i = 1; i < delaysSeen.length; i++) {
      expect(delaysSeen[i]).toBeGreaterThan(delaysSeen[i - 1]);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("stops retrying once a delivery succeeds", async () => {
    const fetchImpl = jest
      .fn<FetchLike>()
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    const result = await dispatchWebhookWithRetry(
      "https://example.com/webhook",
      SAMPLE_EVENT,
      {
        fetchImpl,
        sleepFn: async () => undefined,
        retry: { maxRetries: 3, initialBackoffMs: 10, backoffMultiplier: 2 },
      }
    );

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.delays).toEqual([10]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("processWebhookRetryQueue drains due schedule-worker items", async () => {
    const now = Date.now();
    enqueueWebhookRetry({
      id: "due",
      webhookUrl: "https://example.com/due",
      event: SAMPLE_EVENT,
      attempts: 1,
      nextAttemptAt: now - 1,
    });
    enqueueWebhookRetry({
      id: "later",
      webhookUrl: "https://example.com/later",
      event: SAMPLE_EVENT,
      attempts: 0,
      nextAttemptAt: now + 60_000,
    });

    const fetchImpl = mockFetchOk(200);
    const results = await processWebhookRetryQueue({
      fetchImpl,
      now,
      sleepFn: async () => undefined,
    });

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(getWebhookRetryQueue().map((i) => i.id)).toEqual(["later"]);
    expect(dequeueDueRetryItems(now)).toHaveLength(0);
  });
});
