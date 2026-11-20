# Performance baseline

How the public read endpoints behave under load, measured with the k6 kit in
[`loadtest/`](../loadtest) (#965). The point is a repeatable number to compare
against, not a capacity guarantee: rerun it before and after changes to the
caches, the SQLite queries or the rate limiters.

## Reproduce

Prerequisites: Node 24, `npm install`, and [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/)
on `PATH` (`brew install k6`, or set `K6_BIN`). No Docker or network access
is needed.

```bash
npm run loadtest              # prints the table below
npm run loadtest -- --write   # also rewrites the baseline section of this file
```

That one command:

1. builds the backend (`npm run build`);
2. seeds a fresh SQLite file at `data/loadtest.db` through the backend's own
   migrations and insert path ([`loadtest/seed.mjs`](../loadtest/seed.mjs)):
   1,000 monitored contracts, 100,000 events (an `init` naming the parties,
   then fund/deliver/approve), 2,000 wallets, one of which is a party to every
   tenth job;
3. starts a mock Soroban RPC ([`loadtest/mock-rpc.mjs`](../loadtest/mock-rpc.mjs))
   that answers `simulateTransaction` after a fixed 50 ms, and counts calls;
4. starts `dist/index.js` against both on port 3101, with the rate limits
   lifted (k6 sends everything from one IP), and waits for `/ready`;
5. runs [`loadtest/read-endpoints.js`](../loadtest/read-endpoints.js) once per
   endpoint, 20 VUs for 30 s each, one endpoint at a time.

Results land in `loadtest/results/` (git-ignored). The knobs:

| Variable | Default | Meaning |
|---|---|---|
| `LOADTEST_CONTRACTS` | `1000` | Seeded contracts |
| `LOADTEST_EVENTS` | `100000` | Seeded events, spread evenly over the contracts |
| `LOADTEST_WALLETS` | `2000` | Wallet pool the parties are drawn from |
| `LOADTEST_ENDPOINTS` | `get_job,by_wallet,history,query` | Endpoints to run |
| `VUS` / `DURATION` | `20` / `30s` | k6 load per endpoint |
| `HOT_CONTRACTS` | `50` | `get_job` draws from this many contracts |
| `MOCK_RPC_LATENCY_MS` | `50` | Simulated RPC round trip |
| `K6_BIN` | `k6` | k6 executable |

The same run is available as the manual
[Load test workflow](../.github/workflows/loadtest.yml) (`workflow_dispatch`
only, never on PRs). Shared runners are noisy, so use its numbers for trends
and keep the baseline below from one stated machine.

## What each endpoint exercises

| Endpoint | Request mix | Path under test |
|---|---|---|
| `GET /api/jobs/:contractId` | random contract of the first 50 | job-state cache (`JOB_STATE_CACHE_TTL_S`, 5 s) with in-flight dedupe, then an RPC simulation on a miss |
| `GET /api/jobs/by-wallet/:address` | random wallet; 10 % the hot wallet (100 jobs) | `job_participants` + events query in better-sqlite3 on the event loop, `JOBS_BY_WALLET_CACHE_TTL_S` cache |
| `GET /api/jobs/:contractId/history` | random contract, page 1, 10 events | events query, uncached |
| `GET /api/jobs/query` | `is_paused` on a random contract | an RPC simulation on every request |

The last column of the table, RPC simulations per request, is how many
`simulateTransaction` calls the mock RPC saw per HTTP request: `0` would be
all cache hits, `1` none. For `GET /:contractId` it answers "at what request
rate does it hit the RPC instead of the cache": with a 5 s TTL and N hot
contracts the RPC sees at most about N / 5 calls per second however high the
request rate gets, so the ratio falls as the rate rises.

## Baseline

> **Not recorded yet.** The kit was added without a measurement run. Fill
> this in with `npm run loadtest -- --write` on a stated machine and commit
> the result.

<!-- baseline:start -->
- Date: —
- Machine: —
- Node —; 20 VUs for 30s per endpoint, one endpoint at a time
- Data: 1000 contracts, 100000 events, 2000 wallets
- Mock RPC simulate latency: 50 ms

| Endpoint | RPS | p50 (ms) | p95 (ms) | p99 (ms) | Error rate | RPC simulations / request |
|---|---|---|---|---|---|---|
| `GET /api/jobs/:contractId` | — | — | — | — | — | — |
| `GET /api/jobs/by-wallet/:address` | — | — | — | — | — | — |
| `GET /api/jobs/:contractId/history` | — | — | — | — | — | — |
| `GET /api/jobs/query` | — | — | — | — | — | — |
<!-- baseline:end -->

## Caveats

- Rate limits are lifted for the run. In production `GET /:contractId` and
  `/query` share `JOB_CONTRACT_RATE_MAX` (30/min per IP) and
  `GET /by-wallet/:address` has `BY_WALLET_RATE_LIMIT_MAX`, keyed on `req.ip`
  behind nginx (`TRUST_PROXY_HOPS`), so a single client hits 429 long before
  these rates.
- The mock RPC has a fixed latency and never fails; a real RPC adds variance
  and its own limits to the RPC-bound endpoints.
- k6 and the backend share the machine, so the client's CPU use counts
  against the server's.
