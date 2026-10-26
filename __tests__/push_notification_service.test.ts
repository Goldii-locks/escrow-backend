import { jest } from "@jest/globals";
import { createHmac } from "crypto";
import {
  PUSH_NOTIFICATION_ERROR_CODES,
  publishPushMessage,
  type PublishPushOptions,
  type PushMessage,
} from "../src/utils/push_notification_service.js";
import {
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  verifySignature,
} from "../src/utils/webhook_signature_verifier.js";

type FetchImpl = NonNullable<PublishPushOptions["fetchImpl"]>;

const SECRET = "push_test_secret_0123456789abcdef0123456789";
const SIGNED_AT = 1_767_225_600;
const ENDPOINT = "https://push.example.com/v1/messages";
const MESSAGE: PushMessage = {
  recipientId: "user-1",
  title: "Escrow funded",
  body: "Job #42 has been funded",
  data: { jobId: 42 },
};

function captureFetch(status = 200) {
  const fetchImpl = jest.fn<FetchImpl>().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
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

describe("push_notification_service signature checks (#203)", () => {
  const originalEnv = process.env.PUSH_NOTIFICATION_SECRET;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PUSH_NOTIFICATION_SECRET;
    else process.env.PUSH_NOTIFICATION_SECRET = originalEnv;
  });

  it("signs published push messages with timestamp and signature headers", async () => {
    const { fetchImpl, sent } = captureFetch();
    const result = await publishPushMessage(ENDPOINT, MESSAGE, {
      fetchImpl,
      secret: SECRET,
      signedAt: SIGNED_AT,
    });

    expect(result).toEqual({ ok: true, status: 200 });
    const { headers } = sent();
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers[WEBHOOK_TIMESTAMP_HEADER]).toBe(String(SIGNED_AT));
    expect(headers[WEBHOOK_SIGNATURE_HEADER]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("produces signatures a client-side HMAC implementation accepts", async () => {
    const { fetchImpl, sent } = captureFetch();
    await publishPushMessage(ENDPOINT, MESSAGE, {
      fetchImpl,
      secret: SECRET,
      signedAt: SIGNED_AT,
    });

    const { body, headers } = sent();
    const expected = createHmac("sha256", SECRET)
      .update(`${headers[WEBHOOK_TIMESTAMP_HEADER]}.${body}`)
      .digest("hex");
    expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBe(`sha256=${expected}`);
    expect(
      verifySignature(body, SECRET, SIGNED_AT, headers[WEBHOOK_SIGNATURE_HEADER])
    ).toBe(true);
    expect(
      verifySignature(body, `${SECRET}x`, SIGNED_AT, headers[WEBHOOK_SIGNATURE_HEADER])
    ).toBe(false);
  });

  it("uses PUSH_NOTIFICATION_SECRET when no explicit secret is passed", async () => {
    process.env.PUSH_NOTIFICATION_SECRET = SECRET;
    const { fetchImpl, sent } = captureFetch();
    const result = await publishPushMessage(ENDPOINT, MESSAGE, {
      fetchImpl,
      signedAt: SIGNED_AT,
    });
    expect(result.ok).toBe(true);
    const { body, headers } = sent();
    expect(
      verifySignature(body, SECRET, SIGNED_AT, headers[WEBHOOK_SIGNATURE_HEADER])
    ).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["too short", "short-secret"],
  ])("refuses to publish with a %s secret", async (_label, secret) => {
    delete process.env.PUSH_NOTIFICATION_SECRET;
    const { fetchImpl } = captureFetch();
    const result = await publishPushMessage(ENDPOINT, MESSAGE, { fetchImpl, secret });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(PUSH_NOTIFICATION_ERROR_CODES.INVALID_SECRET);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects non-https endpoints and malformed messages", async () => {
    const { fetchImpl } = captureFetch();
    const badEndpoint = await publishPushMessage("http://push.example.com", MESSAGE, {
      fetchImpl,
      secret: SECRET,
    });
    expect(badEndpoint.ok).toBe(false);
    if (!badEndpoint.ok) {
      expect(badEndpoint.code).toBe(PUSH_NOTIFICATION_ERROR_CODES.INVALID_ENDPOINT);
    }

    const badMessage = await publishPushMessage(
      ENDPOINT,
      { ...MESSAGE, recipientId: "" },
      { fetchImpl, secret: SECRET }
    );
    expect(badMessage.ok).toBe(false);
    if (!badMessage.ok) {
      expect(badMessage.code).toBe(PUSH_NOTIFICATION_ERROR_CODES.INVALID_MESSAGE);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports non-2xx responses as delivery failures", async () => {
    const { fetchImpl } = captureFetch(503);
    const result = await publishPushMessage(ENDPOINT, MESSAGE, {
      fetchImpl,
      secret: SECRET,
    });
    expect(result).toMatchObject({
      ok: false,
      status: 503,
      code: PUSH_NOTIFICATION_ERROR_CODES.DELIVERY_FAILED,
    });
  });
});
