/**
 * Unit coverage for the webhook URL guard (#605).
 *
 * Subscribe-time validation inspects the URL itself; delivery-time validation
 * additionally resolves the hostname, because DNS can be re-pointed after the
 * subscription exists. The resolver is injected here so the assertions do not
 * depend on real DNS.
 */

import { jest } from "@jest/globals";
import {
  validateWebhookUrl,
  assertDeliveryTargetAllowed,
  isBlockedIpLiteral,
  type LookupFn,
} from "../src/utils/webhook-url-guard.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("validateWebhookUrl (#605)", () => {
  it("accepts public https URLs", () => {
    expect(validateWebhookUrl("https://example.com/webhook").ok).toBe(true);
    expect(validateWebhookUrl("https://example.com:8443/hook?x=1").ok).toBe(true);
    expect(validateWebhookUrl("https://sub.example.co.za/hook").ok).toBe(true);
  });

  it("accepts public IP literals", () => {
    expect(validateWebhookUrl("https://8.8.8.8/hook").ok).toBe(true);
    expect(validateWebhookUrl("https://[2606:4700:4700::1111]/hook").ok).toBe(true);
  });

  it("allows plain http outside production and rejects it in production", () => {
    process.env.NODE_ENV = "test";
    expect(validateWebhookUrl("http://example.com/hook").ok).toBe(true);

    process.env.NODE_ENV = "production";
    expect(validateWebhookUrl("http://example.com/hook")).toEqual({
      ok: false,
      error: "webhook_url must use https",
    });
  });

  it("rejects non-http schemes", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/hook",
      "gopher://example.com/hook",
    ]) {
      expect(validateWebhookUrl(url).ok).toBe(false);
    }
  });

  it("rejects URLs carrying credentials", () => {
    expect(validateWebhookUrl("https://user:pass@example.com/hook").ok).toBe(
      false
    );
  });

  it("rejects invalid URLs", () => {
    for (const url of ["", "not-a-url", "example.com/hook"]) {
      expect(validateWebhookUrl(url).ok).toBe(false);
    }
  });

  it("rejects IPv4 private, loopback, link-local, CGNAT and metadata ranges", () => {
    for (const url of [
      "http://127.0.0.1:3001/hook",
      "http://127.10.0.1/hook",
      "http://10.1.2.3/hook",
      "http://172.16.0.9/hook",
      "http://172.31.255.255/hook",
      "http://192.168.1.10/hook",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/hook",
      "http://0.0.0.0/hook",
      "http://224.0.0.1/hook",
      "https://255.255.255.255/hook",
    ]) {
      expect(validateWebhookUrl(url).ok).toBe(false);
    }
  });

  it("rejects localhost and .localhost names", () => {
    for (const url of [
      "http://localhost/hook",
      "http://LOCALHOST/hook",
      "https://app.localhost/hook",
      "https://metadata.google.internal/computeMetadata/v1/",
    ]) {
      expect(validateWebhookUrl(url).ok).toBe(false);
    }
  });

  it("rejects IPv6 loopback, link-local, ULA, mapped and NAT64 ranges", () => {
    for (const url of [
      "https://[::1]/hook",
      "https://[::]/hook",
      "https://[fe80::1]/hook",
      "https://[fe80::abcd]/hook",
      "https://[fc00::1]/hook",
      "https://[fd12:3456::1]/hook",
      "https://[::ffff:127.0.0.1]/hook",
      "https://[::ffff:7f00:1]/hook",
      "https://[64:ff9b::192.168.0.1]/hook",
      "https://[ff02::1]/hook",
    ]) {
      expect(validateWebhookUrl(url).ok).toBe(false);
    }
  });
});

describe("isBlockedIpLiteral (#605)", () => {
  it("classifies IPv4 literals", () => {
    expect(isBlockedIpLiteral("10.0.0.1")).toBe(true);
    expect(isBlockedIpLiteral("169.254.169.254")).toBe(true);
    expect(isBlockedIpLiteral("8.8.8.8")).toBe(false);
  });

  it("classifies IPv6 literals with and without brackets", () => {
    expect(isBlockedIpLiteral("::1")).toBe(true);
    expect(isBlockedIpLiteral("[::1]")).toBe(true);
    expect(isBlockedIpLiteral("[fe80::1]")).toBe(true);
    expect(isBlockedIpLiteral("2606:4700:4700::1111")).toBe(false);
  });

  it("returns null for hostnames", () => {
    expect(isBlockedIpLiteral("example.com")).toBeNull();
    expect(isBlockedIpLiteral("localhost")).toBeNull();
  });
});

describe("assertDeliveryTargetAllowed (#605)", () => {
  it("allows a hostname that resolves publicly", async () => {
    const lookup = jest.fn<LookupFn>(async () => [
      { address: "93.184.216.34", family: 4 },
    ]);

    await expect(
      assertDeliveryTargetAllowed("https://example.com/hook", lookup)
    ).resolves.toEqual({ ok: true });
    expect(lookup).toHaveBeenCalledWith("example.com");
  });

  it("blocks a hostname that resolves to a private address", async () => {
    const lookup = jest.fn<LookupFn>(async () => [
      { address: "10.0.0.5", family: 4 },
    ]);

    await expect(
      assertDeliveryTargetAllowed("https://rebind.example/hook", lookup)
    ).resolves.toEqual({
      ok: false,
      error:
        "webhook_url must not target a private, loopback, link-local or metadata address",
    });
  });

  it("blocks when any resolved address is private", async () => {
    const lookup = jest.fn<LookupFn>(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);

    const result = await assertDeliveryTargetAllowed(
      "https://rebind.example/hook",
      lookup
    );
    expect(result.ok).toBe(false);
  });

  it("blocks hostname resolutions to IPv6 loopback and link-local", async () => {
    const loopback = jest.fn<LookupFn>(async () => [
      { address: "::1", family: 6 },
    ]);
    const linkLocal = jest.fn<LookupFn>(async () => [
      { address: "fe80::1", family: 6 },
    ]);

    expect(
      (await assertDeliveryTargetAllowed("https://rebind.example/hook", loopback))
        .ok
    ).toBe(false);
    expect(
      (
        await assertDeliveryTargetAllowed(
          "https://rebind.example/hook",
          linkLocal
        )
      ).ok
    ).toBe(false);
  });

  it("lets unresolvable hostnames fail on their own", async () => {
    const lookup = jest.fn<LookupFn>(async () => {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    });

    await expect(
      assertDeliveryTargetAllowed("https://gone.example/hook", lookup)
    ).resolves.toEqual({ ok: true });
  });

  it("blocks private IP literals without resolving", async () => {
    const lookup = jest.fn<LookupFn>();

    const result = await assertDeliveryTargetAllowed(
      "http://169.254.169.254/latest",
      lookup
    );

    expect(result.ok).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("honours WEBHOOK_ALLOW_PRIVATE_HOSTS only under NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";
    process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS = "1";

    await expect(
      assertDeliveryTargetAllowed(
        "http://127.0.0.1:4000/hook",
        jest.fn<LookupFn>()
      )
    ).resolves.toEqual({ ok: true });

    process.env.NODE_ENV = "production";
    expect(
      (
        await assertDeliveryTargetAllowed(
          "http://127.0.0.1:4000/hook",
          jest.fn<LookupFn>()
        )
      ).ok
    ).toBe(false);
  });
});
