import { jest } from "@jest/globals";
import {
  buildOpsAlertPayload,
  formatOpsAlertMessage,
  isAllowedOpsAlertUrl,
  OPS_ALERT_TIMEOUT_MS,
  resetOpsAlertsForTests,
  sendOpsAlert,
} from "../src/utils/ops-alerts.js";

const originalFetch = global.fetch;
const originalUrl = process.env.OPS_ALERT_WEBHOOK_URL;
const originalInterval = process.env.OPS_ALERT_MIN_INTERVAL_S;

function setEnv(url: string | undefined, intervalS?: string) {
  if (url === undefined) delete process.env.OPS_ALERT_WEBHOOK_URL;
  else process.env.OPS_ALERT_WEBHOOK_URL = url;

  if (intervalS === undefined) delete process.env.OPS_ALERT_MIN_INTERVAL_S;
  else process.env.OPS_ALERT_MIN_INTERVAL_S = intervalS;
}

beforeEach(() => {
  resetOpsAlertsForTests();
  setEnv(undefined);
  global.fetch = originalFetch;
});

afterAll(() => {
  global.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.OPS_ALERT_WEBHOOK_URL;
  else process.env.OPS_ALERT_WEBHOOK_URL = originalUrl;
  if (originalInterval === undefined) delete process.env.OPS_ALERT_MIN_INTERVAL_S;
  else process.env.OPS_ALERT_MIN_INTERVAL_S = originalInterval;
});

describe("ops-alerts helpers", () => {
  it("accepts only https URLs", () => {
    expect(isAllowedOpsAlertUrl("https://hooks.slack.com/services/x")).toBe(true);
    expect(isAllowedOpsAlertUrl("http://hooks.slack.com/services/x")).toBe(false);
    expect(isAllowedOpsAlertUrl("ftp://example.com")).toBe(false);
    expect(isAllowedOpsAlertUrl("not a url")).toBe(false);
  });

  it("formats severity, title and details", () => {
    const msg = formatOpsAlertMessage({
      severity: "critical",
      title: "Poller stall detected",
      details: { elapsedMs: 1200 },
    });
    expect(msg).toContain("[CRITICAL] Poller stall detected");
    expect(msg).toContain("1200");
  });

  it("builds a payload usable by both Slack and Discord", () => {
    const payload = buildOpsAlertPayload({
      severity: "warning",
      title: "X",
      details: "boom",
    });
    expect(payload.text).toBe(payload.content);
    expect(payload.text).toContain("[WARNING] X");
    expect(payload.text).toContain("boom");
  });
});

describe("sendOpsAlert", () => {
  it("is a clean no-op when the URL is unset", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await sendOpsAlert({ severity: "info", title: "noop" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("suppresses alerts when the URL is not https", async () => {
    setEnv("http://insecure.example.com/hook");
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await sendOpsAlert({ severity: "critical", title: "insecure" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts both text and content to the configured webhook", async () => {
    setEnv("https://alerts.example.com/hook");
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    await sendOpsAlert({
      severity: "critical",
      title: "Reconciliation mismatch",
      details: { contractId: "C1" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://alerts.example.com/hook");
    const body = JSON.parse(String(init.body));
    expect(body.text).toContain("Reconciliation mismatch");
    expect(body.content).toBe(body.text);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("deduplicates by title within the window", async () => {
    setEnv("https://alerts.example.com/hook", "900");
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    await sendOpsAlert({ severity: "info", title: "same" });
    await sendOpsAlert({ severity: "info", title: "same" });
    await sendOpsAlert({ severity: "info", title: "different" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not deduplicate when the window has elapsed", async () => {
    setEnv("https://alerts.example.com/hook", "0");
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    await sendOpsAlert({ severity: "info", title: "same" });
    await sendOpsAlert({ severity: "info", title: "same" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("swallows network errors instead of throwing", async () => {
    setEnv("https://alerts.example.com/hook");
    global.fetch = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(
      sendOpsAlert({ severity: "critical", title: "network error" }),
    ).resolves.toBeUndefined();
  });

  it("swallows a timeout/abort instead of throwing", async () => {
    setEnv("https://alerts.example.com/hook");
    global.fetch = jest.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;

    await expect(
      sendOpsAlert({ severity: "critical", title: "slow endpoint" }),
    ).resolves.toBeUndefined();
  });

  it("bounds the request with a 5s abort signal", async () => {
    setEnv("https://alerts.example.com/hook");
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    await sendOpsAlert({ severity: "info", title: "bounded" });

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(OPS_ALERT_TIMEOUT_MS).toBe(5000);
  });

  it("does not throw on a non-2xx response", async () => {
    setEnv("https://alerts.example.com/hook");
    global.fetch = jest.fn(async () => ({ ok: false, status: 500 }) as unknown as Response) as unknown as typeof fetch;

    await expect(
      sendOpsAlert({ severity: "warning", title: "server error" }),
    ).resolves.toBeUndefined();
  });
});
