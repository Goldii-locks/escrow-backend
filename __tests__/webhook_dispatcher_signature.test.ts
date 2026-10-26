import { jest } from "@jest/globals";
import { createHmac } from "crypto";
import {
  ERROR_CODES,
  dispatchWebhook,
  dispatchWebhookWithRetry,
  type FetchLike,
} from "../src/indexer/webhook_dispatcher.js";
import {
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  verifySignature,
} from "../src/utils/webhook_signature_verifier.js";

const SECRET = "whsec_test_0123456789abcdef0123456789abcdef";
const SIGNED_AT = 1_767_225_600;
const WEBHOOK_URL = "https://example.com/webhook";
const SAMPLE_EVENT = {
  event_type: "funded",
  contract_id: "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901",
  ledger_sequence: 12345,
  timestamp: "2026-01-01T00:00:00Z",
  data: { amount: "100" },
};

function captureFetch() {
  const fetchImpl = jest.fn<FetchLike>().mockResolvedValue({
    ok: true,
    status: 200,
  } as Response);
  const sent = () => {
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    return {
      body: init.body as string,
      headers: init.headers as Record<string, string>,
    };
  };
  return { fetchImpl, sent };
}

describe("webhook_dispatcher signature checks (#202)", () => {
  const originalEnv = process.env.WEBHOOK_SIGNING_SECRET;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.WEBHOOK_SIGNING_SECRET;
    else process.env.WEBHOOK_SIGNING_SECRET = originalEnv;
  });

  it("signs outgoing webhooks with timestamp and HMAC-SHA256 headers", async () => {
    const { fetchImpl, sent } = captureFetch();
    const result = await dispatchWebhook(WEBHOOK_URL, SAMPLE_EVENT, {
      fetchImpl,
      secret: SECRET,
      signedAt: SIGNED_AT,
    });

    expect(result.success).toBe(true);
    const { headers } = sent();
    expect(headers[WEBHOOK_TIMESTAMP_HEADER]).toBe(String(SIGNED_AT));
    expect(headers[WEBHOOK_SIGNATURE_HEADER]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("produces signatures a client-side HMAC implementation accepts", async () => {
    const { fetchImpl, sent } = captureFetch();
    await dispatchWebhook(WEBHOOK_URL, SAMPLE_EVENT, {
      fetchImpl,
      secret: SECRET,
      signedAt: SIGNED_AT,
    });

    const { body, headers } = sent();
    const timestamp = headers[WEBHOOK_TIMESTAMP_HEADER];
    // Independent client-side verification algorithm.
    const expected = createHmac("sha256", SECRET)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBe(`sha256=${expected}`);
    expect(
      verifySignature(body, SECRET, Number(timestamp), headers[WEBHOOK_SIGNATURE_HEADER])
    ).toBe(true);
  });

  it("signature fails verification when the body is tampered with", async () => {
    const { fetchImpl, sent } = captureFetch();
    await dispatchWebhook(WEBHOOK_URL, SAMPLE_EVENT, {
      fetchImpl,
      secret: SECRET,
      signedAt: SIGNED_AT,
    });
    const { body, headers } = sent();
    const tampered = body.replace('"100"', '"999"');
    expect(
      verifySignature(tampered, SECRET, SIGNED_AT, headers[WEBHOOK_SIGNATURE_HEADER])
    ).toBe(false);
  });

  it("falls back to WEBHOOK_SIGNING_SECRET from the environment", async () => {
    process.env.WEBHOOK_SIGNING_SECRET = SECRET;
    const { fetchImpl, sent } = captureFetch();
    await dispatchWebhook(WEBHOOK_URL, SAMPLE_EVENT, { fetchImpl, signedAt: SIGNED_AT });
    const { body, headers } = sent();
    expect(
      verifySignature(body, SECRET, SIGNED_AT, headers[WEBHOOK_SIGNATURE_HEADER])
    ).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["too short", "short-secret"],
  ])("rejects an %s secret without sending the request", async (_label, secret) => {
    const { fetchImpl } = captureFetch();
    const result = await dispatchWebhook(WEBHOOK_URL, SAMPLE_EVENT, { fetchImpl, secret });
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(0);
    expect(result.code).toBe(ERROR_CODES.INVALID_SECRET);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not retry an invalid secret", async () => {
    const { fetchImpl } = captureFetch();
    const result = await dispatchWebhookWithRetry(WEBHOOK_URL, SAMPLE_EVENT, {
      fetchImpl,
      secret: "short",
      sleepFn: async () => undefined,
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe(ERROR_CODES.INVALID_SECRET);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
