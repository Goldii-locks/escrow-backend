# Escrow Backend

Express + TypeScript backend for the Soroban milestone escrow platform.

## Tech Stack

- Node.js + Express
- TypeScript
- Stellar SDK
- Soroban RPC

## Table of Contents

- [Setup](#setup)
- [Architecture](#architecture)
- [API Documentation](#api-documentation)
- [API Endpoints](#api-endpoints)
  - [System & Health](#system--health)
    - [GET /health](#get-health)
  - [Jobs API](#jobs-api)
    - [GET /api/jobs/:contractId](#get-apijobscontractid)
    - [GET /api/jobs/by-wallet/:address](#get-apijobsby-walletaddress)
    - [POST /api/jobs/create-job-draft](#post-apijobscreate-job-draft)
    - [GET /api/jobs/drafts/:id](#get-apijobsdraftsid)
    - [GET /api/jobs/query](#get-apijobsquery-and-post-apijobsquery)
    - [GET /api/jobs/whitelisted-tokens](#get-apijobswhitelisted-tokens)
    - [GET /api/jobs/:contractId/history](#get-apijobscontractidhistory)
    - [GET /api/jobs/:contractId/fee-preview](#get-apijobscontractidfee-preview)
    - [GET /api/jobs/:contractId/whitelist](#get-apijobscontractidwhitelist)
    - [POST /api/jobs/:contractId/whitelist/update](#post-apijobscontractidwhitelistupdate)
    - [POST /api/jobs/build-tx](#post-apijobsbuild-tx)
    - [POST /api/jobs/:contractId/milestones/:index/partial-release](#post-apijobscontractidmilestonesindexpartial-release)
    - [GET /api/jobs/:contractId/milestones/:index/time-remaining](#get-apijobscontractidmilestonesindextime-remaining)
    - [POST /api/jobs/:contractId/milestones/:index/claim-auto-release](#post-apijobscontractidmilestonesindexclaim-auto-release)
    - [POST /api/jobs/submit](#post-apijobssubmit)
  - [Admin API](#admin-api)
    - [GET /api/admin/indexer-status](#get-apiadminindexer-status)
    - [POST /api/admin/backfill](#post-apiadminbackfill)
    - [GET /api/admin/backfill](#get-apiadminbackfill)
    - [GET /api/admin/contracts](#get-apiadmincontracts)
    - [POST /api/admin/contracts](#post-apiadmincontracts)
    - [DELETE /api/admin/contracts/:contractId](#delete-apiadmincontractscontractid)
  - [Webhooks API](#webhooks-api)
    - [POST /api/webhooks/subscribe](#post-apiwebhookssubscribe)
    - [POST /api/webhooks/unsubscribe](#post-apiwebhooksunsubscribe)
    - [GET /api/webhooks/subscriptions](#get-apiwebhookssubscriptions)
- [Error Responses](#error-responses)
- [Related Repos](#related-repos)

## Setup

```bash
npm install
cp .env.example .env  # configure required production / local keys
npm run dev
```

## Architecture

- [Architecture overview](./docs/ARCHITECTURE.md) — live request/indexer paths and reachability table
- [CSV serialization guide](./docs/CSV_SERIALIZATION_GUIDE.md)
- [Webhook delivery](./docs/webhooks.md) — event types, payload shapes, retry policy, idempotency
- [OpenAPI 3.0 specification](./docs/openapi.yaml) — complete machine-readable route definitions, parameter schemas, and response shapes

### Webhook idempotency

Webhooks are delivered at least once, so receivers must tolerate duplicates.
Each POST body includes an `event_id`, and each request carries:

- `X-Milesto-Event-Id`: stable per on-chain event (the RPC event id; events indexed before it was stored use `<contract_id>:<ledger_sequence>:<event_type>`). **Dedupe on this.**
- `X-Milesto-Delivery-Id`: UUID per logical delivery (event to subscriber), constant across all of its retries, including those made by the background retry sweep.
- `X-Milesto-Delivery-Attempt`: the attempt number, starting at `1`.

See [docs/webhooks.md](./docs/webhooks.md#idempotency) for the full contract.

## API Documentation

The complete OpenAPI specification is maintained in [docs/openapi.yaml](./docs/openapi.yaml).

### API Versioning

New integrations should use `/api/v1`. Existing `/api` routes remain available
for backwards compatibility and return `Deprecation: true`.

### Authentication Model

- **Public endpoints**: Endpoints that simulate public contract reads (`/api/jobs/:contractId`, `/api/jobs/by-wallet/:address`, `/api/jobs/:contractId/whitelist`, etc.) or construct unsigned transactions for the caller's wallet to sign require no API key.
- **Admin endpoints**: `/api/admin/*` requires an admin key passed via `x-api-key: <ADMIN_API_KEY>` or `Authorization: Bearer <ADMIN_API_KEY>`.
- **Client endpoints**: When `API_KEYS` is configured, client integrations pass their key via `x-api-key: <API_KEY>`.

---

## API Endpoints

### System & Health

#### GET /health

Check server and contract configuration health.
- **Auth**: None (Public)
- **Response**: `{ "status": "ok", "contract": "<CONTRACT_ID>" }`

---

### Jobs API

#### GET /api/jobs/:contractId

Get current job state simulated directly from the Soroban contract.
- **Auth**: None (Public read)
- **Rate Limit**: 30 requests / minute (`JOB_CONTRACT_RATE_MAX`)
- **Params**: `contractId` (Stellar contract C... address)

#### GET /api/jobs/by-wallet/:address

Get indexed jobs associated with a participant wallet address (as client, freelancer, or arbiter).
- **Auth**: None (Public read)
- **Rate Limit**: 30 requests / minute (`BY_WALLET_RATE_LIMIT_MAX`)
- **Params**: `address` (Stellar G... account address)
- **Query**: `page` (default: 1), `limit` (default: 20, max: 100)

#### POST /api/jobs/create-job-draft

Validate and persist an off-chain job escrow draft before deploying on-chain.
- **Auth**: None (Public)
- **Rate Limit**: 5 requests / minute (`CREATE_JOB_DRAFT_RATE_MAX`)
- **Body**: `{ client, freelancer, arbiter, token, autoReleaseDays?, milestones: [{ amount, description? }] }`

#### GET /api/jobs/drafts/:id

Fetch a job draft saved by `create-job-draft` (#667).
- **Auth**: None (Public)
- **Response**: the stored draft, or `404` when no draft has that ID

#### GET /api/jobs/query and POST /api/jobs/query

Execute read-only simulation queries against a Soroban contract.
- **Auth**: None (Public)
- **Rate Limit**: 30 requests / minute (`JOB_CONTRACT_RATE_MAX`)

#### GET /api/jobs/whitelisted-tokens

Frontend query alias to fetch accepted token contract IDs for a contract.
- **Auth**: None (Public)
- **Query**: `contractId` (required)

#### GET /api/jobs/:contractId/history

Fetch indexed contract lifecycle events (funded, milestone approved, completed, etc.).
- **Auth**: None (Public)
- **Query**: `page` (default: 1), `limit` (default: 10, max: 100)

#### GET /api/jobs/:contractId/fee-preview

Calculate the platform fee breakdown for a specified amount.
- **Auth**: None (Public)
- **Query**: `amount` (required)

#### GET /api/jobs/:contractId/whitelist

Get the list of whitelisted payment token contract addresses accepted by the escrow contract.
- **Auth**: None (Public)
- **Rate Limit**: 20 requests / minute (`JOB_WHITELIST_RATE_MAX`)

#### POST /api/jobs/:contractId/whitelist/update

Build an unsigned transaction to add or remove whitelisted tokens.
- **Auth**: None (Public; wallet signature required on-chain)
- **Rate Limit**: 10 requests / minute (`JOB_WHITELIST_UPDATE_RATE_MAX`)
- **Body**: `{ token, action: "add" | "remove", adminAddress }` or `{ addresses: [...] }`

#### POST /api/jobs/build-tx

Build an unsigned transaction XDR for authorized contract entrypoints.
- **Auth**: None (Public; caller wallet signs)
- **Rate Limit**: 20 requests / minute (`BUILD_TX_RATE_MAX`)
- **Body**: `{ contractId, method, args, sourceAddress }`

#### POST /api/jobs/:contractId/milestones/:index/partial-release

Build an unsigned transaction XDR for partial milestone release.
- **Auth**: None (Public; caller wallet signs)
- **Rate Limit**: 10 requests / minute (`PARTIAL_RELEASE_RATE_MAX`)
- **Params**: `contractId`, `index` (milestone index)
- **Body**: `{ amount, sourceAddress }`

#### GET /api/jobs/:contractId/milestones/:index/time-remaining (and /auto-release)

Get seconds remaining until an unapproved milestone is eligible for auto-release.
Also available via alias route `GET /api/jobs/:contractId/milestones/:index/auto-release`.
- **Auth**: None (Public)
- **Rate Limit**: 60 requests / minute (`TIME_REMAINING_RATE_MAX`)
- **Params**: `contractId`, `index` (milestone index)

#### POST /api/jobs/:contractId/milestones/:index/claim-auto-release

Build an unsigned transaction XDR to claim an auto-released milestone.
- **Auth**: None (Public; caller wallet signs)
- **Rate Limit**: 10 requests / minute (`CLAIM_AUTO_RELEASE_RATE_MAX`)
- **Params**: `contractId`, `index`
- **Body**: `{ sourceAddress }`

#### POST /api/jobs/submit

Submit a signed transaction to the Stellar network and return execution status.
- **Auth**: None (Public)
- **Rate Limit**: 5 requests / minute (`SUBMIT_RATE_MAX`)
- **Body**: `{ signedXdr, sourceAddress? }`

---

### Admin API

#### GET /api/admin/indexer-status

Retrieve indexer health, current ledger, event counters, uptime, and reconciliation status.
- **Auth**: Admin API Key (`x-api-key: <ADMIN_API_KEY>` or `Bearer`)
- **Response**: `{ success: true, lastIndexedLedger, totalEvents, uptimeSeconds, lastEventAt, eventsByType, reconciliation }`

#### POST /api/admin/backfill

Import a historical ledger range in the background (#703). One backfill runs at a time.
- **Auth**: Admin API Key
- **Body**: `{ startLedger, endLedger, contractId? }` (inclusive range; `contractId` limits the import to one contract)
- **Response**: `202` with the job ID; `409` while another backfill is running; `400` for an invalid range

#### GET /api/admin/backfill

Status of the current or last backfill: `running`, `done` or `failed`, with `eventsFound` / `eventsImported`, or `{ status: "idle" }`.
- **Auth**: Admin API Key

#### GET /api/admin/contracts

List the contracts the indexer monitors, with label, active flag, ledger pointer and start ledger (#659).
- **Auth**: Admin API Key

#### POST /api/admin/contracts

Register a contract for indexing (#659).
- **Auth**: Admin API Key
- **Body**: `{ contractId, label?, startLedger? }`
- **Response**: `201` with the registered contract

#### DELETE /api/admin/contracts/:contractId

Stop indexing a contract (#659).
- **Auth**: Admin API Key

---

### Webhooks API

#### POST /api/webhooks/subscribe

Register a webhook URL to receive real-time notifications for contract events.
- **Auth**: None (Public)
- **Body**: `{ contract_id, webhook_url, event_types?: [...] }`

#### POST /api/webhooks/unsubscribe

Unsubscribe an existing webhook registration.
- **Auth**: None (Public)
- **Body**: `{ contract_id, webhook_url }`

#### GET /api/webhooks/subscriptions

List the webhook subscriptions for a contract (#705). Query strings in webhook URLs are masked.
- **Auth**: API Key
- **Query**: `?contract_id=C...`
- **Response**: `{ success: true, data: { subscriptions: [{ id, webhook_url, event_types, created_at }] } }`

---

## Error Responses

All endpoints return JSON errors in a consistent shape.

### Validation error

```json
{
  "success": false,
  "error": "Request validation failed",
  "fields": [
    {
      "field": "contractId",
      "message": "contractId is required"
    }
  ]
}
```

### Unauthorized

```json
{
  "success": false,
  "error": "Unauthorized"
}
```

### Rate limited

```json
{
  "success": false,
  "error": "Too many requests, please try again later"
}
```

### Not found

```json
{
  "success": false,
  "error": "Job not found"
}
```

### Server error

```json
{
  "success": false,
  "error": "Internal server error"
}
```

## Related Repos

- [escrow-contract](https://github.com/Goldii-locks/escrow-contract) — Soroban smart contract
- [escrow-frontend](https://github.com/Goldii-locks/escrow-frontend) — Next.js frontend
