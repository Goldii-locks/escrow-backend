# Webhook Delivery

The indexer POSTs a JSON payload to each registered `webhook_url` whenever a
matching on-chain event is ingested. Deliveries are retried up to 3 times
with backoff (`500ms`, `1500ms`, `4500ms`).

Deliveries are ordered by ledger: each poll's ledger range is queued behind
the previous one, so every event from an earlier range (including its
retries) is sent before any event from a later range (#682).
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

## Outgoing webhook signature verification (#694)

Email-alert webhooks are signed with HMAC-SHA256 over
`${timestamp}.${body}` (Stripe/Slack-style) so captured deliveries cannot
be replayed. Each delivery sends:

- `X-Webhook-Signature: sha256=<hex>`
- `X-Milesto-Timestamp: <millis-since-epoch>`

Receivers must:

1. Read the raw body bytes, both headers, and reject when any is missing.
2. Reject when `timestamp` is not an integer within 5 minutes of now
   (tolerance is configurable; see
   `DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_MS`).
3. Recompute `HMAC-SHA256(secret, timestamp + "." + body)` as hex and
   compare with the signature header in constant time.
