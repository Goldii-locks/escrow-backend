# Webhook Delivery

The indexer POSTs a JSON payload to each registered `webhook_url` whenever a
matching on-chain event is ingested. Deliveries are retried up to 3 times
with backoff (`500ms`, `1500ms`, `4500ms`). Each attempt has a hard timeout
(`WEBHOOK_TIMEOUT_MS`, default `5000`): a receiver that never answers fails
the attempt, and delivery continues with the next subscriber.

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

Amounts are stroop-scale integers (`i128` on-chain) delivered as decimal
strings. Addresses are `G...`/`C...` strings. Enum fields (e.g. `status`)
arrive as a one-element array holding the variant name, e.g. `["Released"]`.
See [Event `data` shapes](#event-data-shapes) for every encoding rule and a
generated example per event type.

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
route) would otherwise be retried for every matching event, forever, and
delay every healthy subscriber behind it in the sequential delivery loop.

Each subscription therefore tracks its consecutive delivery failures. After
`WEBHOOK_DISABLE_AFTER` consecutive failed deliveries (default `50`) the
subscription is disabled: it is skipped by the delivery loop and shows up in
`GET /api/admin/webhook-subscriptions` under `disabled`.

A successful delivery resets the counter, and calling `POST
/api/webhooks/subscribe` again for the same `(contract_id, webhook_url)` pair
re-enables the subscription and clears the failure history.

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

`data` is the event's contract struct (from
`contracts/milestone-escrow/src/lib.rs` in `goldii-locks/escrow-contract`),
decoded with `scValToNative` and serialised as JSON. The examples below are
generated by
[`__tests__/webhook-event-payloads.test.ts`](../__tests__/webhook-event-payloads.test.ts),
which runs contract-shaped values through the indexer's real decoding path
(`toEventRow`) and fails if any example here drifts from its output.
Regenerate them with
`UPDATE_WEBHOOK_DOCS=1 npx jest __tests__/webhook-event-payloads.test.ts`.

The contract emits around 80 event types; the user-facing ones are listed
here. See escrow-contract's
[`EVENTS.md`](https://github.com/Goldii-locks/escrow-contract/blob/main/EVENTS.md)
for the full list. `event_type` and `event_types` filters always use these
short `symbol_short!` topics (`msfund`, `arbchg`, `freerot`, ...), never the
struct names.

### Encoding rules

| Contract type                  | JSON in `data`                                     | Example                          |
| ------------------------------ | -------------------------------------------------- | -------------------------------- |
| `i128` amounts                 | decimal **string** (BigInt-safe, stroop scale)     | `"10000000"`                     |
| `u64` timestamps / seconds     | decimal **string**                                 | `"1735689600"`                   |
| `u32` (indices, counts, bps)   | number                                             | `0`                              |
| `bool`                         | boolean                                            | `true`                           |
| `Address`                      | `G...` / `C...` string                             | `"GAOD...VZRX"`                  |
| unit enum (`MilestoneStatus`)  | one-element array holding the variant name         | `["Released"]`                   |
| `BytesN<32>` hashes            | `{ "type": "Buffer", "data": [32 byte values] }`   | see `deliver` below              |
| `Vec<T>`                       | array of the element encoding                      | `["10000000", "20000000"]`       |

Struct fields arrive in alphabetical order (Soroban sorts struct map keys).
Party addresses (`client`, `freelancer`, ...) are also published as extra
event topics, but webhooks deliver only `data`; the fields below are what
`data` contains.

### Event types

| `event_type` | Contract struct | Meaning |
| ------------ | --------------- | ------- |
| [`init`](#init) | `InitializedEvent` | The escrow was initialised. |
| [`fund`](#fund) | `FundedEvent` | The client funded the whole escrow (`total_amount` moves client → escrow). Inflow for reconciliation. |
| [`msfund`](#msfund) | `MilestoneFundedEvent` | The client funded a single milestone (per-milestone funding mode). Inflow for reconciliation. |
| [`deliver`](#deliver) | `DeliveredEvent` | The freelancer marked a milestone delivered. `amount` is the full milestone amount, `deliverable` the committed deliverable hash. |
| [`approve`](#approve) | `ApprovedEvent` | The client approved a milestone, fully or partially. `amount` is the incremental payout of this call; `released_amount` is cumulative; `remaining` is what is left on the milestone. |
| [`claim`](#claim) | `ClaimedEvent` | An auto-released milestone was paid out. `caller` is who triggered it (attribution only). |
| [`withdraw`](#withdraw) | `WithdrawnEvent` | Funds were withdrawn to `recipient`. |
| [`dispute`](#dispute) | `DisputeRaisedEvent` | A dispute was raised on a milestone. `reason_hash` commits to the off-chain reason. |
| [`evidence`](#evidence) | `EvidenceSubmittedEvent` | A party submitted evidence for an open dispute. |
| [`resolve`](#resolve) | `DisputeResolvedEvent` | The arbiter resolved a dispute. `amount` is what was owed, `paid_amount` what actually moved, `arbiter_fee_amount` the fee taken first. |
| [`arbsplit`](#arbsplit) | `ArbitrationSplitAppliedEvent` | The arbiter split a disputed milestone between the parties. `client_refund` + `freelancer_payout` is the settled split. |
| [`dispescal`](#dispescal) | `DisputeEscalatedEvent` | A dispute timed out and was escalated; the milestone returns to `restored_status`. |
| [`cancel`](#cancel) | `CancelEscrowInitiatedEvent` | The escrow was cancelled. `total_amount` is the stored total, not the unreleased balance. |
| [`ms_add`](#ms_add) | `MilestoneAddedEvent` | A milestone was appended. `total_amount` / `milestone_count` are the values after the addition. |
| [`ms_reduce`](#ms_reduce) | `MilestoneReducedEvent` | A milestone amount was reduced; `refund` (`old_amount - new_amount`) went back to the client. |
| [`arbchg`](#arbchg) | `ArbiterReplacedEvent` | Client and freelancer replaced the arbiter (`old` → `new`). |
| [`freerot`](#freerot) | `FreelancerRotatedEvent` | The freelancer was rotated to `new_freelancer`. |
| [`overdue`](#overdue) | `OverdueReclaimedEvent` | The client reclaimed an overdue milestone after `due_at` (`reclaim_overdue`). |
| [`unaccref`](#unaccref) | `UnacceptedWithdrawnEvent` | The client withdrew funds from a job that was never accepted (`withdraw_unaccepted`). |

### `init`

`InitializedEvent`. The escrow was initialised.

<!-- webhook-example:init -->
```json
{
  "admin": "GAQSEIZEEUTCOKBJFIVSYLJOF4YDCMRTGQ2TMNZYHE5DWPB5HY7UAIOK",
  "arbiter": "GABNCQRZNTG6MMITD33VHFITKJZ5PSYW2XVEXMP52BSMTPLU7WORDQNT",
  "auto_release_seconds": "604800",
  "client": "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
  "created_at": "1735603200",
  "freelancer": "GB5CRPXUGXZCG6BESL4CM4F3VUAGQGFNYNBHPBRJAGLXXSRYJSEGZHUV",
  "milestone_amounts": ["10000000", "20000000"],
  "milestone_count": 2,
  "milestone_spec_hashes": [
    {
      "type": "Buffer",
      "data": [171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171]
    },
    {
      "type": "Buffer",
      "data": [171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171]
    }
  ],
  "token": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  "total_amount": "30000000"
}
```

### `fund`

`FundedEvent`. The client funded the whole escrow (`total_amount` moves client → escrow). Inflow for reconciliation.

<!-- webhook-example:fund -->
```json
{
  "client": "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
  "total_amount": "30000000"
}
```

### `msfund`

`MilestoneFundedEvent`. The client funded a single milestone (per-milestone funding mode). Inflow for reconciliation.

<!-- webhook-example:msfund -->
```json
{
  "amount": "20000000",
  "client": "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
  "milestone_index": 1,
  "token": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
}
```

### `deliver`

`DeliveredEvent`. The freelancer marked a milestone delivered. `amount` is the full milestone amount, `deliverable` the committed deliverable hash.

<!-- webhook-example:deliver -->
```json
{
  "amount": "10000000",
  "client": "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
  "deliverable": {
    "type": "Buffer",
    "data": [171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171]
  },
  "delivered_at": "1735689600",
  "freelancer": "GB5CRPXUGXZCG6BESL4CM4F3VUAGQGFNYNBHPBRJAGLXXSRYJSEGZHUV",
  "milestone_index": 0,
  "status": ["Delivered"]
}
```

### `approve`

`ApprovedEvent`. The client approved a milestone, fully or partially. `amount` is the incremental payout of this call; `released_amount` is cumulative; `remaining` is what is left on the milestone.

<!-- webhook-example:approve -->
```json
{
  "amount": "10000000",
  "milestone_index": 0,
  "released_amount": "10000000",
  "remaining": "0",
  "status": ["Released"]
}
```

### `claim`

`ClaimedEvent`. An auto-released milestone was paid out. `caller` is who triggered it (attribution only).

<!-- webhook-example:claim -->
```json
{
  "amount": "10000000",
  "caller": "GB5CRPXUGXZCG6BESL4CM4F3VUAGQGFNYNBHPBRJAGLXXSRYJSEGZHUV",
  "freelancer": "GB5CRPXUGXZCG6BESL4CM4F3VUAGQGFNYNBHPBRJAGLXXSRYJSEGZHUV",
  "milestone_index": 0,
  "token": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
}
```

### `withdraw`

`WithdrawnEvent`. Funds were withdrawn to `recipient`.

<!-- webhook-example:withdraw -->
```json
{
  "amount": "20000000",
  "recipient": "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
  "token": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
}
```

### `dispute`

`DisputeRaisedEvent`. A dispute was raised on a milestone. `reason_hash` commits to the off-chain reason.

<!-- webhook-example:dispute -->
```json
{
  "caller": "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
  "disputed_at": "1735776000",
  "milestone_amount": "10000000",
  "milestone_index": 0,
  "new_status": ["Disputed"],
  "reason_hash": {
    "type": "Buffer",
    "data": [171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171]
  }
}
```

### `evidence`

`EvidenceSubmittedEvent`. A party submitted evidence for an open dispute.

<!-- webhook-example:evidence -->
```json
{
  "caller": "GB5CRPXUGXZCG6BESL4CM4F3VUAGQGFNYNBHPBRJAGLXXSRYJSEGZHUV",
  "evidence_hash": {
    "type": "Buffer",
    "data": [171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171]
  },
  "milestone_index": 0,
  "submitted_at": "1735779600"
}
```

### `resolve`

`DisputeResolvedEvent`. The arbiter resolved a dispute. `amount` is what was owed, `paid_amount` what actually moved, `arbiter_fee_amount` the fee taken first.

<!-- webhook-example:resolve -->
```json
{
  "amount": "10000000",
  "arbiter": "GABNCQRZNTG6MMITD33VHFITKJZ5PSYW2XVEXMP52BSMTPLU7WORDQNT",
  "arbiter_fee_amount": "500000",
  "decision_hash": {
    "type": "Buffer",
    "data": [171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171]
  },
  "milestone_index": 0,
  "paid_amount": "9500000",
  "released_to_freelancer": true,
  "status": ["Released"]
}
```

### `arbsplit`

`ArbitrationSplitAppliedEvent`. The arbiter split a disputed milestone between the parties. `client_refund` + `freelancer_payout` is the settled split.

<!-- webhook-example:arbsplit -->
```json
{
  "arbiter": "GABNCQRZNTG6MMITD33VHFITKJZ5PSYW2XVEXMP52BSMTPLU7WORDQNT",
  "arbiter_fee_amount": "0",
  "client": "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
  "client_refund": "4000000",
  "client_refund_bps": 4000,
  "decision_hash": {
    "type": "Buffer",
    "data": [171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171, 171]
  },
  "freelancer": "GB5CRPXUGXZCG6BESL4CM4F3VUAGQGFNYNBHPBRJAGLXXSRYJSEGZHUV",
  "freelancer_payout": "6000000",
  "freelancer_payout_bps": 6000,
  "milestone_index": 0,
  "released_amount": "6000000",
  "status": ["Split"],
  "token": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
}
```

### `dispescal`

`DisputeEscalatedEvent`. A dispute timed out and was escalated; the milestone returns to `restored_status`.

<!-- webhook-example:dispescal -->
```json
{
  "caller": "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
  "disputed_at": "1735776000",
  "escalated_at": "1736380800",
  "milestone_index": 0,
  "restored_status": ["Delivered"]
}
```

### `cancel`

`CancelEscrowInitiatedEvent`. The escrow was cancelled. `total_amount` is the stored total, not the unreleased balance.

<!-- webhook-example:cancel -->
```json
{
  "caller": "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
  "caller_is_client": true,
  "client": "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
  "freelancer": "GB5CRPXUGXZCG6BESL4CM4F3VUAGQGFNYNBHPBRJAGLXXSRYJSEGZHUV",
  "milestone_count": 2,
  "token": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  "total_amount": "30000000"
}
```

### `ms_add`

`MilestoneAddedEvent`. A milestone was appended. `total_amount` / `milestone_count` are the values after the addition.

<!-- webhook-example:ms_add -->
```json
{
  "amount": "5000000",
  "client": "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
  "freelancer": "GB5CRPXUGXZCG6BESL4CM4F3VUAGQGFNYNBHPBRJAGLXXSRYJSEGZHUV",
  "milestone_count": 3,
  "milestone_index": 2,
  "total_amount": "35000000"
}
```

### `ms_reduce`

`MilestoneReducedEvent`. A milestone amount was reduced; `refund` (`old_amount - new_amount`) went back to the client.

<!-- webhook-example:ms_reduce -->
```json
{
  "client": "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
  "freelancer": "GB5CRPXUGXZCG6BESL4CM4F3VUAGQGFNYNBHPBRJAGLXXSRYJSEGZHUV",
  "milestone_count": 2,
  "milestone_index": 1,
  "new_amount": "15000000",
  "old_amount": "20000000",
  "refund": "5000000",
  "total_amount": "25000000"
}
```

### `arbchg`

`ArbiterReplacedEvent`. Client and freelancer replaced the arbiter (`old` → `new`).

<!-- webhook-example:arbchg -->
```json
{
  "client": "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
  "freelancer": "GB5CRPXUGXZCG6BESL4CM4F3VUAGQGFNYNBHPBRJAGLXXSRYJSEGZHUV",
  "new": "GAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPSABOV",
  "old": "GABNCQRZNTG6MMITD33VHFITKJZ5PSYW2XVEXMP52BSMTPLU7WORDQNT"
}
```

### `freerot`

`FreelancerRotatedEvent`. The freelancer was rotated to `new_freelancer`.

<!-- webhook-example:freerot -->
```json
{
  "client": "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
  "new_freelancer": "GAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPSABOV",
  "previous_freelancer": "GB5CRPXUGXZCG6BESL4CM4F3VUAGQGFNYNBHPBRJAGLXXSRYJSEGZHUV"
}
```

### `overdue`

`OverdueReclaimedEvent`. The client reclaimed an overdue milestone after `due_at` (`reclaim_overdue`).

<!-- webhook-example:overdue -->
```json
{
  "amount": "20000000",
  "client": "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
  "due_at": "1736380800",
  "milestone_index": 1
}
```

### `unaccref`

`UnacceptedWithdrawnEvent`. The client withdrew funds from a job that was never accepted (`withdraw_unaccepted`).

<!-- webhook-example:unaccref -->
```json
{
  "amount": "30000000",
  "client": "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX",
  "token": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
}
```

## Related events

Split-refund calculators (`splitref`, `epspltref`, `cxlspref`) and the
arbitration split (`arbsplit`) carry `client_refund` / `freelancer_payout`
fields whose sum equals the settled split. See `docs` on reconciliation
for how inflow/outflow event types map to on-chain balances.

## Outgoing webhook signature verification (#694)

> **Not active for event deliveries.** The indexer's event webhooks
> (`src/indexer/webhook-delivery.ts`) are currently sent unsigned. The
> signing senders (the email-alert sender and the unreachable
> `src/indexer/webhook_dispatcher.ts`) were removed as dead code (#782,
> #631). The scheme below is what `src/utils/webhook_signature_verifier.ts`
> verifies, for when signing is wired into live delivery.

Email-alert webhooks were signed with HMAC-SHA256 over
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
