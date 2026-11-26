import { jest } from "@jest/globals";
import http from "http";
import type { AddressInfo } from "net";
import type { EventDbRow } from "../src/indexer/db.js";
import { deliverToUrl } from "../src/indexer/webhook-delivery.js";
import {
  assertDeliveryTargetAllowed,
  pinnedLookup,
  type LookupAddress,
  type LookupFn,
} from "../src/utils/webhook-url-guard.js";

/**
 * #862: the delivery-time URL guard and the request must use the same DNS
 * answer. A 0-TTL record that answers the guard with a public address and the
 * next lookup with 127.0.0.1 must never produce a connection to loopback.
 */

jest.setTimeout(20_000);

const PUBLIC: LookupAddress = { address: "203.0.113.10", family: 4 }; // TEST-NET-3
const LOOPBACK: LookupAddress = { address: "127.0.0.1", family: 4 };

const event: EventDbRow = {
  id: 1,
  contract_id: "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901",
  event_type: "funded",
  ledger_sequence: 100,
  timestamp: 1000,
  data_json: JSON.stringify({ client: "GCLIENT" }),
  created_at: "2026-01-01T00:00:00Z",
} as EventDbRow;

/** A rebinding resolver: the first answer is `first`, every later one is `then`. */
function rebinding(first: LookupAddress, then: LookupAddress) {
  const calls: string[] = [];
  const lookup: LookupFn = async (hostname) => {
    calls.push(hostname);
    return [calls.length === 1 ? first : then];
  };
  return { lookup, calls };
}

let server: http.Server;
let port: number;
let received: http.IncomingHttpHeaders[];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    received.push(req.headers);
    req.resume();
    req.on("end", () => res.end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

beforeEach(() => {
  received = [];
  delete process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS;
  process.env.WEBHOOK_TIMEOUT_MS = "1500";
});

afterAll(async () => {
  delete process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS;
  delete process.env.WEBHOOK_TIMEOUT_MS;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("webhook delivery DNS pinning (#862)", () => {
  it("returns the vetted address from the delivery-time guard", async () => {
    const result = await assertDeliveryTargetAllowed("https://hooks.example.com/x", async () => [PUBLIC]);
    expect(result).toEqual({ ok: true, address: PUBLIC });
  });

  it("never connects to loopback when the second lookup rebinds to 127.0.0.1", async () => {
    const { lookup, calls } = rebinding(PUBLIC, LOOPBACK);

    const outcome = await deliverToUrl(`http://rebind.test:${port}/hook`, event, undefined, { lookup });

    // Resolved once, by the guard; the connection went to the vetted public
    // address (unroutable here), not to a fresh answer pointing at loopback.
    expect(calls).toEqual(["rebind.test"]);
    expect(received).toHaveLength(0);
    expect(outcome.ok).toBe(false);
  });

  it("connects to the vetted address and keeps the original Host header", async () => {
    // Loopback is allowed only in this test so the receiver can be local. The
    // name does not resolve in real DNS, so success proves the request used
    // the pinned address rather than a fresh lookup.
    process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS = "1";
    const { lookup, calls } = rebinding(LOOPBACK, PUBLIC);

    const outcome = await deliverToUrl(`http://pinned.test:${port}/hook`, event, undefined, { lookup });

    expect(outcome.ok).toBe(true);
    expect(calls).toEqual(["pinned.test"]);
    expect(received).toHaveLength(1);
    expect(received[0].host).toBe(`pinned.test:${port}`);
  });

  it("still blocks when the guard's own answer is private", async () => {
    const { lookup } = rebinding(LOOPBACK, PUBLIC);
    const outcome = await deliverToUrl(`http://evil.test:${port}/hook`, event, undefined, { lookup });
    expect(outcome).toMatchObject({ ok: false, errorCode: "BLOCKED_URL" });
    expect(received).toHaveLength(0);
  });
});

describe("pinnedLookup", () => {
  it("answers every hostname with the vetted address in both callback forms", async () => {
    const lookup = pinnedLookup(PUBLIC);
    const single = await new Promise<[string, number | undefined]>((resolve) =>
      lookup("anything.example", {}, (_err, address, family) => resolve([address as string, family]))
    );
    expect(single).toEqual(["203.0.113.10", 4]);

    const all = await new Promise<unknown>((resolve) =>
      lookup("other.example", { all: true }, (_err, addresses) => resolve(addresses))
    );
    expect(all).toEqual([{ address: "203.0.113.10", family: 4 }]);
  });
});
