/**
 * SSRF guard for outbound webhook URLs (#605).
 *
 * `deliverToUrl` POSTs to whatever a subscriber registered, so an unchecked
 * URL turns the backend into a probe into its own network: the EC2 metadata
 * service (169.254.169.254), loopback services and RFC 1918 addresses are all
 * reachable from where the poller runs.
 *
 * Two checks are needed, because DNS can change between them:
 *
 *  - `validateWebhookUrl` runs at subscribe time. It only inspects the URL
 *    itself: scheme, credentials, localhost names and IP literals.
 *  - `assertDeliveryTargetAllowed` runs immediately before each delivery
 *    attempt and additionally resolves the hostname, because a public name
 *    can be re-pointed at a private address after the subscription exists.
 *
 * Delivery also uses `redirect: "manual"` (see `webhook-delivery.ts`) so a
 * public URL cannot bounce the request to an internal one.
 */

import { promises as dns } from "dns";

export type UrlCheckResult = { ok: true } | { ok: false; error: string };

export type LookupAddress = { address: string; family: number };

export type LookupFn = (hostname: string) => Promise<LookupAddress[]>;

const BLOCKED_PRIVATE_ERROR =
  "webhook_url must not target a private, loopback, link-local or metadata address";
const BLOCKED_LOCALHOST_ERROR = "webhook_url must not target localhost";

/**
 * Upper bound for the delivery-time DNS check. A stalled resolver must not
 * hold up the delivery pipeline; on timeout the target is treated as
 * unresolvable and the request proceeds to fail on its own terms.
 */
const DNS_LOOKUP_TIMEOUT_MS = 250;

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const resolved = dns.lookup(hostname, { all: true }).then((results) =>
      results.map((entry) => ({
        address: entry.address,
        family: entry.family,
      }))
    );
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("DNS lookup timed out")),
        DNS_LOOKUP_TIMEOUT_MS
      );
      timer.unref?.();
    });
    return await Promise.race([resolved, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Test-only escape hatch: suites that need a real local HTTP server (the
 * delivery-timeout coverage in #606) can allow loopback targets. It is
 * honoured only when NODE_ENV is exactly "test", so a production deployment
 * cannot be talked into disabling the guard with an environment variable.
 */
function privateHostsAllowedForTest(): boolean {
  return (
    process.env.NODE_ENV === "test" &&
    process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS === "1"
  );
}

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function isBlockedIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + EC2 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0 && octets[2] === 0) return true; // 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function embeddedIpv4Blocked(low: number, high: number): boolean {
  const octets = [high >> 8, high & 0xff, low >> 8, low & 0xff];
  return isBlockedIpv4(octets);
}

function isBlockedIpv6(hextets: number[]): boolean {
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets;

  const allZero = hextets.every((part) => part === 0);
  if (allZero) return true; // ::
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 === 0 && h7 === 1) {
    return true; // ::1
  }
  if ((h0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((h0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  const firstFiveZero =
    h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0;
  // ::ffff:a.b.c.d IPv4-mapped and ::a.b.c.d IPv4-compatible addresses
  if (firstFiveZero && (h5 === 0xffff || h5 === 0)) {
    if (!(h5 === 0 && h6 === 0 && h7 <= 1)) {
      return embeddedIpv4Blocked(h7, h6);
    }
  }
  // 64:ff9b::/96 NAT64, which embeds the IPv4 target in the low 32 bits
  if (h0 === 0x64 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    return embeddedIpv4Blocked(h7, h6);
  }
  return false;
}

function expandIpv6(host: string): number[] | null {
  let input = host;
  if (input.startsWith("[") && input.endsWith("]")) {
    input = input.slice(1, -1);
  }
  if (input.length === 0 || !input.includes(":")) return null;

  // A trailing dotted quad (e.g. ::ffff:127.0.0.1) occupies the last two
  // hextets. URL normalises the bracketed form to hex, but the delivery-time
  // resolver reports plain IPv4-mapped strings, so accept both.
  const lastColon = input.lastIndexOf(":");
  const tail = input.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = parseIpv4(tail);
    if (!octets) return null;
    const high = (octets[0] << 8) | octets[1];
    const low = (octets[2] << 8) | octets[3];
    input = `${input.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const doubleColonCount = input.split("::").length - 1;
  if (doubleColonCount > 1) return null;

  let head: string[];
  let tailParts: string[];
  if (doubleColonCount === 1) {
    const [left, right] = input.split("::");
    head = left.length > 0 ? left.split(":") : [];
    tailParts = right.length > 0 ? right.split(":") : [];
  } else {
    head = input.split(":");
    tailParts = [];
  }

  const parseHextet = (part: string): number | null => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    return parseInt(part, 16);
  };

  const headValues: number[] = [];
  for (const part of head) {
    const value = parseHextet(part);
    if (value === null) return null;
    headValues.push(value);
  }
  const tailValues: number[] = [];
  for (const part of tailParts) {
    const value = parseHextet(part);
    if (value === null) return null;
    tailValues.push(value);
  }

  if (doubleColonCount === 1) {
    const missing = 8 - headValues.length - tailValues.length;
    if (missing < 1) return null;
    return [
      ...headValues,
      ...new Array<number>(missing).fill(0),
      ...tailValues,
    ];
  }

  if (headValues.length !== 8) return null;
  return headValues;
}

/**
 * `true` when the host is a blocked IP literal, `false` when it is a public
 * IP literal, and `null` when it is not an IP literal at all.
 */
export function isBlockedIpLiteral(host: string): boolean | null {
  const unbracketed =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  const ipv4 = parseIpv4(unbracketed);
  if (ipv4) return isBlockedIpv4(ipv4);

  const ipv6 = expandIpv6(unbracketed);
  if (ipv6) return isBlockedIpv6(ipv6);

  return null;
}

function isBlockedHostname(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower === "metadata.google.internal"
  );
}

function schemeAllowed(protocol: string): boolean {
  if (protocol === "https:") return true;
  // Plain http is tolerated outside production so local development can use
  // a dev receiver; production accepts https only.
  if (protocol === "http:") return process.env.NODE_ENV !== "production";
  return false;
}

function schemeError(protocol: string): string {
  if (protocol === "http:") return "webhook_url must use https";
  return "webhook_url must use http or https";
}

function unbracket(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * Subscribe-time validation. Inspects the URL only; DNS is deliberately not
 * consulted here because the address can change later (see
 * `assertDeliveryTargetAllowed`).
 */
export function validateWebhookUrl(rawUrl: string): UrlCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: "webhook_url must be a valid URL" };
  }

  if (!schemeAllowed(parsed.protocol)) {
    return { ok: false, error: schemeError(parsed.protocol) };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: "webhook_url must not include credentials" };
  }

  const host = unbracket(parsed.hostname);
  if (!host) {
    return { ok: false, error: "webhook_url must include a host" };
  }

  if (isBlockedHostname(host)) {
    return { ok: false, error: BLOCKED_LOCALHOST_ERROR };
  }

  if (isBlockedIpLiteral(host) === true) {
    return { ok: false, error: BLOCKED_PRIVATE_ERROR };
  }

  return { ok: true };
}

/**
 * Delivery-time validation: re-checks the URL and resolves the hostname, so a
 * record that used to point somewhere public and now points inside the
 * network is not followed. Unresolvable names are allowed through because
 * there is no address to abuse; the request itself then fails naturally.
 */
export async function assertDeliveryTargetAllowed(
  rawUrl: string,
  lookup: LookupFn = defaultLookup
): Promise<UrlCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: "webhook_url must be a valid URL" };
  }

  if (!schemeAllowed(parsed.protocol)) {
    return { ok: false, error: schemeError(parsed.protocol) };
  }

  const host = unbracket(parsed.hostname);
  if (!host) {
    return { ok: false, error: "webhook_url must include a host" };
  }

  if (isBlockedHostname(host)) {
    return { ok: false, error: BLOCKED_LOCALHOST_ERROR };
  }

  const literal = isBlockedIpLiteral(host);
  if (literal !== null) {
    if (literal && !privateHostsAllowedForTest()) {
      return { ok: false, error: BLOCKED_PRIVATE_ERROR };
    }
    return { ok: true };
  }

  let addresses: LookupAddress[];
  try {
    addresses = await lookup(host);
  } catch {
    // Nothing to connect to; let the delivery attempt fail on its own terms.
    return { ok: true };
  }

  if (addresses.length === 0) return { ok: true };

  const blocked = addresses.some((entry) => {
    const ipv4 = parseIpv4(entry.address);
    if (ipv4) return isBlockedIpv4(ipv4);
    const ipv6 = expandIpv6(entry.address);
    if (ipv6) return isBlockedIpv6(ipv6);
    return false;
  });

  if (blocked && !privateHostsAllowedForTest()) {
    return { ok: false, error: BLOCKED_PRIVATE_ERROR };
  }

  return { ok: true };
}
