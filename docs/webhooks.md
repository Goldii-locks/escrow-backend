# Webhook Delivery

The indexer POSTs a JSON payload to each registered `webhook_url` whenever a
matching on-chain event is ingested. Each attempt has a hard timeout
(`WEBHOOK_TIMEOUT_MS`, default `5000`).

Delivery is driven from the database (#850). Every subscription stores the
id of the last event it was handed (`last_delivered_event_id`). Each poll
cycle, and once at startup, the indexer sends every matching event above
that cursor and moves the cursor forward in the same transaction that
records the delivery. Events indexed just before a deploy, crash or
`SIGTERM` are therefore delivered by the next process. On shutdown the
indexer waits for the in-flight delivery run, bounded by
`SHUTDOWN_TIMEOUT_MS`. A new subscription starts at the newest stored event:
it receives events indexed from then on, not the history.

Each subscription has its own ordered queue (#851). Queues run in parallel,
at most `WEBHOOK_DELIVERY_CONCURRENCY` at a time (default `4`), so an
unreachable receiver does not delay healthy ones. Each event gets one inline
attempt. A failed attempt is stored in the `webhook_deliveries` outbox and
retried by the background sweep with exponential backoff
(`WEBHOOK_RETRY_BASE_DELAY_MS`, default `60000`, doubling up to one hour),
until `WEBHOOK_MAX_DELIVERY_ATTEMPTS` (default `25`) or
`WEBHOOK_RETRY_MAX_AGE_DAYS` (default `7`) is reached.

Order is preserved per subscription: events are sent in the order they were
indexed, and while a subscription has a failed delivery waiting for retry,
no later event is sent to it (#682, #851).

## URL requirements

`webhook_url` is validated when the subscription is created and again before
every delivery attempt, so the backend is never turned into a probe into its
own network:

- `https` is required in production. Plain `http` is accepted outside
  production so a local receiver can be used during development.
- URLs carrying credentials (`https://user:pass@host/...`) are rejected.
- `localhost` (and `*.localhost`) is rejected.
- IP literals in private (RFC 1918), carrier-grade NAT (`100.64.0.0/10`),
  loopback, link-local (including the cloud metadata address
  `169.254.169.254`), unique-local IPv6 and reserved ranges are rejected.
- At delivery time the hostname is resolved again and the attempt is refused
  when any resolved address falls into those ranges, because a public name
  can be re-pointed at an internal address after the subscription exists.
- Redirects are never followed. A `3xx` response is treated as a failed
  attempt and retried like any other delivery failure.

## Envelope

Every delivery uses the same envelope. `version` is an integer that is
bumped on every breaking change so subscribers can tell which schema they
received (current: `1`).

```jsonc
{
  "version": 1,
  "event_id": "CABC...XYZ:12345678:fund",
  "event_type": "fund",
  "contract_id": "CABC...XYZ",
  "ledger_sequence": 12345678,
  "timestamp": 1735689600,
  "tx_hash": "9f2c...aa71",
  "txHash": "9f2c...aa71",
  "event_id": "00000000...-0000",
  "data": { /* per-event shape, see below */ }
}
```

| Field             | Type   | Description                                             |
| ----------------- | ------ | ------------------------------------------------------- |
| `version`         | number | Envelope schema version. Currently always `1`.          |
| `event_id`        | string | Stable event identifier, `<contract_id>:<ledger_sequence>:<event_type>`. Same value as the `X-Milesto-Event-Id` header. |
| `event_type`      | string | Contract topic that fired, e.g. `fund`, `approve`.      |
| `contract_id`     | string | Soroban contract address (`C...`) that emitted the event. |
| `ledger_sequence` | number | Ledger the event was ingested from.                     |
| `timestamp`       | number | Ledger close time (unix seconds) recorded at ingestion. |
| `tx_hash`         | string\|null | Hash of the transaction that emitted the event. Link it to a block explorer. `null` for events indexed before the column existed. |
| `txHash`          | string\|null | Camel-case alias of `tx_hash`.                           |
| `event_id`        | string\|null | RPC event id (`ledger-transaction-index`). `null` for events indexed before the column existed. |
| `data`            | object | Event-specific payload (native JSON form of the Soroban struct). |

Amounts are stroop-scale integers (`i128` on-chain). Addresses are
`G...`/`C...` strings. Enum fields (e.g. `status`) serialise to their
variant name.

## Idempotency

Delivery is **at-least-once**: a timeout, a lost response, or a re-index
can make the same event arrive more than once. Every POST carries these
headers so receivers can dedupe:

| Header                       | Value                                                                 |
| ---------------------------- | --------------------------------------------------------------------- |
| `X-Milesto-Event-Id`         | The event's stable id (same as body `event_id`). Identical for every delivery of the same on-chain event, to every subscriber, including after a re-index. |
| `X-Milesto-Delivery-Id`      | UUID for one logical delivery (one event to one subscription), derived from that pair. Stays the same across all of that delivery's retries, including those made by the background retry sweep. |
| `X-Milesto-Delivery-Attempt` | Attempt number within the delivery, starting at `1`. Failed deliveries are retried until `WEBHOOK_MAX_DELIVERY_ATTEMPTS`. |

Recommended receiver contract:

- **Deduplicate on `X-Milesto-Event-Id`.** Record processed event ids
  (for example a unique column) and return `2xx` without reprocessing when
  one is seen again.
- Use `X-Milesto-Delivery-Id` + `X-Milesto-Delivery-Attempt` for logging
  and tracing retries. An attempt above `1` means an earlier attempt failed
  or timed out from the indexer's point of view, which may still have been
  processed on your side.
- Return `2xx` only once the event is durably handled. Any other status (or
  no response) is retried up to the attempt limit.

## Automatic disabling of dead subscriptions

A subscription whose endpoint is permanently dead (expired domain, removed
route) would otherwise be retried for every matching event, forever.

Each subscription therefore tracks its consecutive delivery failures. After
`WEBHOOK_DISABLE_AFTER` consecutive failed deliveries (default `50`) the
subscription is disabled: it is skipped by the delivery loop and shows up in
`GET /api/admin/webhook-subscriptions` under `disabled`.

A successful delivery resets the counter, and calling `POST
/api/webhooks/subscribe` again for the same `(contract_id, webhook_url)` pair
re-enables the subscription and clears the failure history. Re-subscribing
also rotates the signing secret (see below).

## Subscription event types

Set `event_types` to a non-empty array of unique emitted topic names, such as
`["approve", "fund"]`, or use `"*"` to subscribe to every event. Topic names
are validated against the exported `EVENT_TYPES` constant in
[`src/indexer/event_type_filter.ts`](../src/indexer/event_type_filter.ts),
which is the source of truth and follows the contract's
[`EVENTS.md`](https://github.com/Goldii-locks/escrow-contract/blob/main/EVENTS.md).
Names not in that list, duplicate values, non-strings, empty arrays, and names
longer than the contract's 9-character topic limit are rejected with HTTP 400.

## Event `data` shapes

Shapes below mirror the contract's event structs
(`contracts/milestone-escrow/src/lib.rs` in `goldii-locks/escrow-contract`).

### `init`

Emitted once when the escrow is initialised.

```jsonc
{
  "client": "GCLIENT...",
  "freelancer": "GFREELANCER...",
  "arbiter": "GARBITER...",
  "token": "CTOKEN...",
  "auto_release_seconds": 604800,
  "milestone_amounts": ["10000000", "20000000"],
  "total_amount": "30000000",
  "milestone_count": 2
}
```

| Field                  | Type      | Description                              |
| ---------------------- | --------- | ---------------------------------------- |
| `client`               | string    | Funding party (`G...`).                  |
| `freelancer`           | string    | Work party (`G...`).                     |
| `arbiter`              | string    | Dispute arbiter (`G...`).                |
| `token`                | string    | Stellar Asset Contract (`C...`).         |
| `auto_release_seconds` | number    | Auto-release window in seconds.          |
| `milestone_amounts`    | string[]  | Per-milestone amounts in stroops.        |
| `total_amount`         | string    | Sum of all milestones in stroops.        |
| `milestone_count`      | number    | Number of milestones.                    |

### `fund`

Emitted when the client funds the escrow (`total_amount` stroops move
client → escrow). This is the **inflow** event used by reconciliation.

```jsonc
{
  "contract_id": "CESCROW...",
  "client": "GCLIENT...",
  "freelancer": "GFREELANCER...",
  "arbiter": "GARBITER...",
  "token": "CTOKEN...",
  "total_amount": "30000000",
  "milestone_count": 2,
  "auto_release_seconds": 604800,
  "funded": true
}
```

### `deliver`

Emitted when the freelancer marks a milestone delivered.

```jsonc
{
  "contract_id": "CESCROW...",
  "milestone_index": 0,
  "freelancer": "GFREELANCER...",
  "client": "GCLIENT...",
  "delivered_at": 1735689600,
  "status": "Delivered",
  "amount": "10000000"
}
```

| Field             | Type   | Description                                    |
| ----------------- | ------ | ---------------------------------------------- |
| `milestone_index` | number | Zero-based milestone index.                    |
| `delivered_at`    | number | Ledger timestamp of delivery (unix seconds).   |
| `status`          | string | Milestone status after the call.               |
| `amount`          | string | Full milestone amount in stroops (not the delta). |

### `approve`

Emitted when the client approves a milestone (full or partial). The
`amount` field is the **incremental amount transferred in that call**, so
summing `amount` across `approve` events equals total approved payouts.

```jsonc
{
  "contract_id": "CESCROW...",
  "milestone_index": 0,
  "client": "GCLIENT...",
  "freelancer": "GFREELANCER...",
  "arbiter": "GARBITER...",
  "token": "CTOKEN...",
  "amount": "10000000",
  "released_amount": "10000000",
  "remaining": "0",
  "status": "Released",
  "milestone_count": 2,
  "total_amount": "30000000",
  "auto_release_seconds": 604800
}
```

| Field             | Type   | Description                                            |
| ----------------- | ------ | ------------------------------------------------------ |
| `amount`          | string | Stroops transferred by this approval (incremental).    |
| `released_amount` | string | Cumulative released amount including this approval.   |
| `remaining`       | string | Balance left on the milestone after this approval.     |

### `claim`

Emitted when the freelancer claims an auto-released milestone.
`amount` equals the transferred balance.

```jsonc
{
  "contract_id": "CESCROW...",
  "milestone_index": 0,
  "freelancer": "GFREELANCER...",
  "token": "CTOKEN...",
  "amount": "10000000"
}
```

### `dispute`

Emitted when a dispute is raised on a milestone.

```jsonc
{
  "milestone_index": 0,
  "caller": "GCLIENT...",
  "milestone_amount": "10000000",
  "new_status": "Disputed"
}
```

### `resolve`

Emitted when the arbiter resolves a dispute. `paid_amount` is what
actually moved; `amount` is what was owed before capping to the
available balance.

```jsonc
{
  "contract_id": "CESCROW...",
  "milestone_index": 0,
  "arbiter": "GARBITER...",
  "client": "GCLIENT...",
  "freelancer": "GFREELANCER...",
  "token": "CTOKEN...",
  "amount": "10000000",
  "paid_amount": "9500000",
  "released_to_freelancer": true,
  "status": "Released"
}
```

## Related events

Split-refund calculators (`splitref`, `epspltref`, `cxlspref`) and the
arbitration split (`arbsplit`) carry `client_refund` / `freelancer_payout`
fields whose sum equals the settled split. See `docs` on reconciliation
for how inflow/outflow event types map to on-chain balances.

## Signature verification (#849)

Every delivery, including every retry, is signed with HMAC-SHA256 using a
secret that belongs to the subscription. The signature lets a receiver prove
that a request came from this backend and was not replayed.

### The signing secret

`POST /api/webhooks/subscribe` generates a random 32-byte secret (64 hex
characters) and returns it **once**, as `subscription.signing_secret` in the
response. Store it on the receiver side. It is never returned by
`GET /api/webhooks/subscriptions` or the admin subscription listing, and it is
never logged.

Calling `POST /api/webhooks/subscribe` again for the same
`(contract_id, webhook_url)` pair generates a new secret and returns it. The
old secret stops working immediately, so this is how you rotate a secret or
recover a lost one. Subscriptions that existed before signing was introduced
were given a random secret by the migration; re-subscribe to obtain it.

### Headers

| Header                | Value                                                              |
| --------------------- | ------------------------------------------------------------------ |
| `X-Webhook-Timestamp` | Unix time in **seconds** when the attempt was signed. Each retry is signed again with a fresh timestamp. |
| `X-Webhook-Signature` | `sha256=<hex>`: `HMAC-SHA256(secret, timestamp + "." + body)` over the exact raw request body. |

### Verifying a delivery

Receivers must:

1. Read the **raw** body exactly as received. Do not parse and re-serialize
   it before verifying: any whitespace or key-order change breaks the
   signature.
2. Reject the request when either header is missing.
3. Reject it when the timestamp is not an integer within 5 minutes
   (300 seconds) of the receiver's clock.
4. Recompute `HMAC-SHA256(secret, timestamp + "." + body)` as hex and compare
   it with the signature header in constant time.

`verifySignedRequest` in
[`src/utils/webhook_signature_verifier.ts`](../src/utils/webhook_signature_verifier.ts)
does all four steps. An Express receiver built on it:

```ts
import express from "express";
import { verifySignedRequest } from "./webhook_signature_verifier.js";

const app = express();
const SECRET = process.env.MILESTO_WEBHOOK_SECRET; // subscription.signing_secret

// express.text keeps the body as the exact string that was signed.
app.post("/hook", express.text({ type: "application/json" }), (req, res) => {
  const result = verifySignedRequest(req.body, req.headers, SECRET, {
    toleranceSeconds: 300,
  });
  if (!result.ok) {
    return res.status(401).json({ error: result.code });
  }

  const event = JSON.parse(req.body);
  // Deduplicate on event.event_id / X-Milesto-Event-Id, then handle it.
  res.sendStatus(204);
});
```

Without the helper, the same check in plain Node:

```ts
import { createHmac, timingSafeEqual } from "crypto";

function isValid(rawBody: string, timestamp: string, signature: string, secret: string) {
  const ts = Number(timestamp);
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest();
  const provided = Buffer.from(signature.replace(/^sha256=/, ""), "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
```
