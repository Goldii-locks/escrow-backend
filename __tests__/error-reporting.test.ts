import { jest } from "@jest/globals";
import {
  captureError,
  initErrorReporting,
  resetErrorReporting,
  type ErrorTransport,
  type SentryEvent,
} from "../src/utils/error-reporting.js";

describe("optional error reporting (#895)", () => {
  afterEach(() => {
    resetErrorReporting();
    delete process.env.GIT_SHA;
  });

  it("does nothing when SENTRY_DSN is unset", () => {
    const transport = jest.fn((_event: SentryEvent) => undefined);
    initErrorReporting("", transport);
    captureError(new Error("boom"));
    expect(transport).not.toHaveBeenCalled();
  });

  it("scrubs keys, bodies and webhook query strings before sending", () => {
    process.env.GIT_SHA = "deadbeef";
    const seen: SentryEvent[] = [];
    const transport: ErrorTransport = (event) => {
      seen.push(event);
    };
    initErrorReporting("https://public@example.com/1", transport);

    captureError(new Error("webhook failed"), {
      requestId: "req-1",
      method: "POST",
      url: "/api/webhooks/subscribe?token=secret",
      headers: {
        "x-api-key": "client-secret",
        "X-ADMIN-KEY": "admin-secret",
        "content-type": "application/json",
      },
      body: { client: "G...", secret: "must-not-leak" },
      extra: { webhook_url: "https://hooks.example.com/notify?token=secret&user=1" },
    });

    expect(seen).toHaveLength(1);
    const event = seen[0];
    expect(event.tags).toMatchObject({ requestId: "req-1", release: "deadbeef" });
    expect(event.request?.headers).toEqual({
      "x-api-key": "[redacted]",
      "X-ADMIN-KEY": "[redacted]",
      "content-type": "application/json",
    });
    expect(event.request?.data).toBe("[redacted]");
    expect(event.request?.url).toBe("/api/webhooks/subscribe?[redacted]");
    expect(event.extra?.webhook_url).toBe("https://hooks.example.com/notify?[redacted]");
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(JSON.stringify(event)).not.toContain("must-not-leak");
  });
});
