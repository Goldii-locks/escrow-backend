# Webhook Delivery

The indexer POSTs a JSON payload to each registered `webhook_url` whenever a
matching on-chain event is ingested. Deliveries are retried up to 3 times
with backoff (`500ms`, `1500ms`, `4500ms`).

## Envelope

Every delivery uses the same envelope. `version` is an integer that is
bumped on every breaking change so subscribers can tell which schema they
received (current: `1`).

```jsonc
{
  "version": 1,
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
