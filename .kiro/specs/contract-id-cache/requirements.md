# Requirements Document

## Introduction

This document specifies the requirements for adding an efficient, in-memory
cache layer to the `GET /api/jobs/:contractId` endpoint in the
`escrow-backend` service. The cache must dramatically reduce duplicate
Stellar RPC calls (`getAccount` + `simulateTransaction`) without introducing
new runtime dependencies or breaking existing behaviour.

## Requirements

### Functional Requirements

#### MUST-1 — Cache Lookup Before Every RPC Call
When a valid `contractId` arrives at `GET /api/jobs/:contractId`, the
handler MUST check the cache before issuing any Stellar RPC call.

- If a live (non-expired) entry exists for that `contractId`, the cached
  data MUST be returned immediately without touching the RPC server.
- If no live entry exists, the handler proceeds to the RPC and stores the
  result.

#### MUST-2 — Promise-Level Cache Stampede Protection
When the cache entry for a `contractId` is absent (cold or expired), the
implementation MUST store the **in-flight Promise** of the RPC lookup as the
cache entry before `await`-ing it.

- Any concurrent request for the **same** `contractId` that arrives while
  the first lookup is still pending MUST await the **same** Promise.
- This guarantees that, for N concurrent cold-cache requests, the Stellar
  RPC is called **exactly once**, not N times.

#### MUST-3 — TTL (Time-To-Live) Expiration
Every cache entry MUST expire after a configurable TTL.

- Default TTL: **15 000 ms** (15 seconds).
- Override: `CACHE_TTL_MS` environment variable (parsed as a positive
  integer number of milliseconds). Invalid or absent values fall back to the
  default.
- After the TTL elapses, the next request MUST trigger a fresh RPC call and
  repopulate the cache.

#### MUST-4 — Immediate Error Eviction
If the RPC lookup Promise rejects (network error, contract not found, etc.),
the failed entry MUST be immediately removed from the cache.

- Subsequent requests after a failed lookup MUST be free to retry the RPC;
  they must NOT receive the rejected Promise.
- The error MUST still propagate to the caller so existing 404/500 response
  handling is unaffected.

#### MUST-5 — No Unbounded Memory Growth
The cache MUST NOT grow without bound.

- Expired entries MUST be lazily evicted: at minimum, on the next read for
  the same key after the TTL has elapsed.
- A periodic sweep is a nice-to-have but not required.

#### MUST-6 — Test Isolation Export
The cache module MUST export a `clearContractCache(): void` function that
resets all internal state (map entries and any active timers). This mirrors
the pattern established by `resetJobContractRateLimitBuckets()` in the
rate-limiter middleware.

### Non-Functional Requirements

#### NFR-1 — No New Runtime Dependencies
The cache MUST be implemented using only primitives already available in the
project (native `Map`, Promises, `setTimeout`). No new packages may be added
to `package.json`.

#### NFR-2 — TypeScript Strict Compliance
All new and modified files MUST compile cleanly under the project's existing
`tsconfig.json` settings with zero type errors.

#### NFR-3 — ESM Compatibility
The cache module MUST use ES Module syntax (`export`/`import`) consistent
with the repo's `"type": "module"` setting.

#### NFR-4 — Zero Regression on Pre-Existing Tests
All tests that currently pass in `__tests__/` MUST continue to pass after
the feature is implemented.

### Testing Requirements

A dedicated test file (`__tests__/contract-id-cache.test.ts`) MUST cover
the following cases. Each test case MUST call `clearContractCache()` in
`beforeEach` to prevent cross-test contamination.

#### TEST-1 — Cache Hit (Sequential)
Send two sequential requests for the same valid `contractId` with a
populated mock. Assert that the RPC mocks (`getAccount`, `simulateTransaction`)
are called **exactly once** across both requests.

#### TEST-2 — Concurrent Request Deduplication
Fire 5–10 concurrent requests for the same `contractId` simultaneously (via
`Promise.all`) against a cold cache. Assert that the underlying RPC mock is
called **exactly once** regardless of concurrency.

#### TEST-3 — TTL Expiration
Using Jest fake timers: populate the cache with one request, advance time
past `CACHE_TTL_MS`, send a second request, and assert the RPC mock was
called **twice** (once before expiry, once after).

#### TEST-4 — Error Eviction
Make the RPC mock reject on the first call and resolve on the second. Assert
that the first request returns an error response (4xx/5xx), the second
returns `200`, and the RPC mock was called **twice** (the rejected Promise is
not reused).

## Glossary

| Term | Definition |
|------|------------|
| Cache entry | A `Map` record keyed by `contractId` holding the in-flight or resolved Promise and a `expiresAt` timestamp |
| Stampede | The scenario where many concurrent requests for the same missing key each independently trigger a backend call |
| TTL | Time-To-Live — the maximum age of a cache entry before it is considered stale |
| RPC | Stellar Soroban RPC server accessed via `@stellar/stellar-sdk/rpc` `Server` |
| Cold cache | State where a given `contractId` has no valid entry in the cache |
