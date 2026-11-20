/**
 * k6 load test for the public read endpoints (#965).
 *
 * One endpoint per run, chosen by ENDPOINT:
 *   get_job    GET /api/jobs/:contractId          (job-state cache, then RPC)
 *   by_wallet  GET /api/jobs/by-wallet/:address    (SQLite + by-wallet cache)
 *   history    GET /api/jobs/:contractId/history   (SQLite)
 *   query      GET /api/jobs/query                 (RPC simulation)
 *
 * Normally started by `npm run loadtest` (loadtest/run.mjs), which seeds the
 * database, starts the mock RPC and the backend first. Standalone:
 *
 *   k6 run -e ENDPOINT=get_job -e BASE_URL=http://127.0.0.1:3101 loadtest/read-endpoints.js
 *
 * Other variables: VUS (default 20), DURATION (default 30s),
 * HOT_CONTRACTS (get_job draws from the first N seeded contracts, default 50),
 * SUMMARY_PATH (JSON summary file the runner reads).
 */
import http from "k6/http";
import { check } from "k6";

const seed = JSON.parse(open("./results/seed.json"));

const BASE_URL = __ENV.BASE_URL || "http://127.0.0.1:3101";
const ENDPOINT = __ENV.ENDPOINT || "get_job";
const HOT_CONTRACTS = Number(__ENV.HOT_CONTRACTS || 50);

const hotContracts = seed.contracts.slice(0, HOT_CONTRACTS);
const pickFrom = (list) => list[Math.floor(Math.random() * list.length)];

const REQUESTS = {
  get_job: () => `/api/jobs/${pickFrom(hotContracts)}`,
  // Mostly random wallets (cache misses), one in ten for the hot wallet
  // that takes part in the most jobs.
  by_wallet: () =>
    `/api/jobs/by-wallet/${Math.random() < 0.1 ? seed.hotWallet : pickFrom(seed.wallets)}?page=1&limit=20`,
  history: () => `/api/jobs/${pickFrom(seed.contracts)}/history?page=1&limit=10`,
  query: () => `/api/jobs/query?contractId=${pickFrom(seed.contracts)}&method=is_paused`,
};

if (!REQUESTS[ENDPOINT]) {
  throw new Error(`Unknown ENDPOINT ${ENDPOINT}; one of ${Object.keys(REQUESTS).join(", ")}`);
}

export const options = {
  scenarios: {
    [ENDPOINT]: {
      executor: "constant-vus",
      vus: Number(__ENV.VUS || 20),
      duration: __ENV.DURATION || "30s",
    },
  },
  summaryTrendStats: ["avg", "min", "med", "p(50)", "p(95)", "p(99)", "max"],
  // Recorded, not enforced: the runner reports whatever the baseline is.
  thresholds: {
    http_req_failed: [{ threshold: "rate<0.01", abortOnFail: false }],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}${REQUESTS[ENDPOINT]()}`, { tags: { endpoint: ENDPOINT } });
  check(res, { "status is 200": (r) => r.status === 200 });
}

export function handleSummary(data) {
  const duration = data.metrics.http_req_duration.values;
  const summary = {
    endpoint: ENDPOINT,
    requests: data.metrics.http_reqs.values.count,
    rps: data.metrics.http_reqs.values.rate,
    p50: duration["p(50)"],
    p95: duration["p(95)"],
    p99: duration["p(99)"],
    errorRate: data.metrics.http_req_failed.values.rate,
    vus: Number(__ENV.VUS || 20),
    duration: __ENV.DURATION || "30s",
  };
  const line =
    `${ENDPOINT}: ${summary.rps.toFixed(1)} req/s, p50 ${summary.p50.toFixed(1)} ms, ` +
    `p95 ${summary.p95.toFixed(1)} ms, p99 ${summary.p99.toFixed(1)} ms, ` +
    `errors ${(summary.errorRate * 100).toFixed(2)}%\n`;
  const out = { stdout: line };
  if (__ENV.SUMMARY_PATH) out[__ENV.SUMMARY_PATH] = JSON.stringify(summary, null, 2);
  return out;
}
