import { jest } from "@jest/globals";
import { createHmac } from "crypto";

const mockLogger = {
  info: jest.fn<(...args: any[]) => void>(),
  warn: jest.fn<(...args: any[]) => void>(),
  error: jest.fn<(...args: any[]) => void>(),
  debug: jest.fn<(...args: any[]) => void>(),
};

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: mockLogger,
}));

const {
  signOutgoingWebhook,
  verifyWebhookSignature,
  sendEmailAlert,
  resolveEmailSenderTimeoutMs,
  resolveWebhookSigningSecret,
  EmailSenderTimeoutError,
  EmailSenderConfigError,
  DEFAULT_EMAIL_SENDER_TIMEOUT_MS,
  WEBHOOK_SIGNATURE_HEADER,
  SIGNATURE_SCHEME,
} = await import("../src/utils/email_sender_service.js");

const SECRET = "test-email-webhook-secret";
const PAYLOAD = {
  type: "escrow.alert",
  to: "ops@example.com",
  subject: "Milestone funded",
  body: "Contract CA… was funded",
};

describe("email_sender_service signature checks (#522)", () => {
  const originalSecret = process.env.EMAIL_WEBHOOK_SECRET;
  const originalTimeout = process.env.EMAIL_SENDER_TIMEOUT_MS;

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.EMAIL_WEBHOOK_SECRET;
    } else {
      process.env.EMAIL_WEBHOOK_SECRET = originalSecret;
    }
    if (originalTimeout === undefined) {
      delete process.env.EMAIL_SENDER_TIMEOUT_MS;
    } else {
      process.env.EMAIL_SENDER_TIMEOUT_MS = originalTimeout;
    }
    jest.clearAllMocks();
  });

  it("signs outgoing webhooks with sha256 HMAC hex digests", () => {
    const signed = signOutgoingWebhook(PAYLOAD, SECRET);

    const expected = createHmac("sha256", SECRET)
      .update(JSON.stringify(PAYLOAD), "utf8")
      .digest("hex");

    expect(signed.signatureHex).toBe(expected);
    expect(signed.signatureHeader).toBe(`${SIGNATURE_SCHEME}=${expected}`);
    expect(signed.body).toBe(JSON.stringify(PAYLOAD));
  });

  it("accepts client-side verification of the produced signature header", () => {
    const signed = signOutgoingWebhook(PAYLOAD, SECRET);

    expect(
      verifyWebhookSignature(signed.body, signed.signatureHeader, SECRET)
    ).toBe(true);
    expect(
      verifyWebhookSignature(signed.body, signed.signatureHex, SECRET)
    ).toBe(true);
  });

  it("rejects tampered bodies and wrong secrets", () => {
    const signed = signOutgoingWebhook(PAYLOAD, SECRET);

    expect(
      verifyWebhookSignature(
        JSON.stringify({ ...PAYLOAD, body: "tampered" }),
        signed.signatureHeader,
        SECRET
      )
    ).toBe(false);

    expect(
      verifyWebhookSignature(signed.body, signed.signatureHeader, "wrong-secret")
    ).toBe(false);

    expect(verifyWebhookSignature(signed.body, "not-a-hex", SECRET)).toBe(false);
    expect(verifyWebhookSignature(signed.body, "", SECRET)).toBe(false);
  });

  it("requires a non-empty signing secret", () => {
    delete process.env.EMAIL_WEBHOOK_SECRET;
    expect(() => resolveWebhookSigningSecret()).toThrow(EmailSenderConfigError);
    expect(() => signOutgoingWebhook(PAYLOAD, "")).toThrow(EmailSenderConfigError);
  });

  it("attaches the signature header when sending an alert", async () => {
    const mockFetch = jest.fn<(...args: any[]) => any>();
    mockFetch.mockResolvedValue({ ok: true, status: 202 });
    (global as any).fetch = mockFetch;

    const result = await sendEmailAlert({
      webhookUrl: "https://hooks.example.com/email",
      payload: PAYLOAD,
      secret: SECRET,
      timeoutMs: 2_000,
    });

    expect(result.ok).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.signatureHeader.startsWith(`${SIGNATURE_SCHEME}=`)).toBe(true);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://hooks.example.com/email");
    expect(init.headers[WEBHOOK_SIGNATURE_HEADER]).toBe(result.signatureHeader);
    expect(init.headers["Content-Type"]).toBe("application/json");

    expect(
      verifyWebhookSignature(init.body, init.headers[WEBHOOK_SIGNATURE_HEADER], SECRET)
    ).toBe(true);

    delete (global as any).fetch;
  });
});

describe("email_sender_service call timeouts (#523)", () => {
  afterEach(() => {
    jest.clearAllMocks();
    delete (global as any).fetch;
  });

  it("resolves timeout from override, env, then default", () => {
    delete process.env.EMAIL_SENDER_TIMEOUT_MS;
    expect(resolveEmailSenderTimeoutMs()).toBe(DEFAULT_EMAIL_SENDER_TIMEOUT_MS);
    expect(resolveEmailSenderTimeoutMs(1500)).toBe(1500);

    process.env.EMAIL_SENDER_TIMEOUT_MS = "2500";
    expect(resolveEmailSenderTimeoutMs()).toBe(2500);
    expect(resolveEmailSenderTimeoutMs(900)).toBe(900);
  });

  it("terminates stalled requests and throws EmailSenderTimeoutError with a warning", async () => {
    const mockFetch = jest.fn<(...args: any[]) => any>();
    mockFetch.mockImplementation((_url: any, init: any) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (!signal) {
          reject(new Error("missing abort signal"));
          return;
        }
        if (signal.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
          return;
        }
        signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    (global as any).fetch = mockFetch;

    await expect(
      sendEmailAlert({
        webhookUrl: "https://slow.example.com/email",
        payload: PAYLOAD,
        secret: SECRET,
        timeoutMs: 50,
      })
    ).rejects.toBeInstanceOf(EmailSenderTimeoutError);

    expect(mockLogger.warn).toHaveBeenCalled();
    const warnCall = mockLogger.warn.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0] === "email_sender_service call timeout threshold exceeded"
    );
    expect(warnCall?.[1]).toMatchObject({
      webhookUrl: "https://slow.example.com/email",
      timeoutMs: 50,
      thresholdMs: 50,
    });
  });

  it("propagates non-timeout delivery failures without a timeout warning", async () => {
    const mockFetch = jest.fn<(...args: any[]) => any>();
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    (global as any).fetch = mockFetch;

    await expect(
      sendEmailAlert({
        webhookUrl: "https://down.example.com/email",
        payload: PAYLOAD,
        secret: SECRET,
        timeoutMs: 1_000,
      })
    ).rejects.toThrow("ECONNREFUSED");

    const timeoutWarns = mockLogger.warn.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" &&
        call[0] === "email_sender_service call timeout threshold exceeded"
    );
    expect(timeoutWarns).toHaveLength(0);
    expect(mockLogger.error).toHaveBeenCalled();
  });
});
