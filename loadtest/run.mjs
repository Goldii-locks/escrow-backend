#!/usr/bin/env node
/**
 * One-command load-test baseline for the public read endpoints (#965).
 *
 *   npm run loadtest              # build, seed, run, print the baseline table
 *   npm run loadtest -- --write   # ...and update docs/PERFORMANCE.md
 *
 * Steps: seed a synthetic events DB (loadtest/seed.mjs), start the mock RPC
 * (loadtest/mock-rpc.mjs), start the compiled backend against both with the
 * rate limits lifted, wait for /ready, then run loadtest/read-endpoints.js
 * once per endpoint with k6 and collect RPS, p50/p95/p99, error rate and RPC
 * simulations per request. Needs k6 on PATH (or K6_BIN); see
 * docs/PERFORMANCE.md.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const resultsDir = path.join(here, "results");
const write = process.argv.includes("--write");

const ENDPOINTS = (process.env.LOADTEST_ENDPOINTS ?? "get_job,by_wallet,history,query").split(",");
const BACKEND_PORT = Number(process.env.LOADTEST_BACKEND_PORT ?? 3101);
const RPC_PORT = Number(process.env.MOCK_RPC_PORT ?? 8100);
const VUS = process.env.VUS ?? "20";
const DURATION = process.env.DURATION ?? "30s";
const K6 = process.env.K6_BIN ?? "k6";
const DB_PATH = path.resolve(root, process.env.DB_PATH ?? "data/loadtest.db");
const PASSPHRASE = "Standalone Network ; February 2017";
const BASE_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;

const ENDPOINT_LABELS = {
  get_job: "`GET /api/jobs/:contractId`",
  by_wallet: "`GET /api/jobs/by-wallet/:address`",
  history: "`GET /api/jobs/:contractId/history`",
  query: "`GET /api/jobs/query`",
};
// The RPC method each endpoint may reach, for the RPC-calls-per-request column.
const ENDPOINT_RPC = {
  get_job: "simulateTransaction:get_job",
  query: "simulateTransaction:is_paused",
};

const children = [];
function stopAll() {
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
}
process.on("exit", stopAll);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopAll();
    process.exit(130);
  });
}

function run(cmd, args, env = {}) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with ${result.status}`);
}

function start(name, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...env },
  });
  child.on("exit", (code) => {
    if (code !== null && code !== 0) console.error(`${name} exited with ${code}`);
  });
  children.push(child);
  return child;
}

async function waitFor(description, url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${description} (${url})`);
}

const rpcStats = async () => (await fetch(`${RPC_URL}/stats`)).json();

function k6Available() {
  const probe = spawnSync(K6, ["version"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

const fmt = (ms) => ms.toFixed(1);

function renderTable(rows) {
  const lines = [
    "| Endpoint | RPS | p50 (ms) | p95 (ms) | p99 (ms) | Error rate | RPC simulations / request |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${ENDPOINT_LABELS[r.endpoint] ?? r.endpoint} | ${r.rps.toFixed(0)} | ${fmt(r.p50)} | ` +
        `${fmt(r.p95)} | ${fmt(r.p99)} | ${(r.errorRate * 100).toFixed(2)}% | ` +
        `${r.rpcPerRequest === null ? "—" : r.rpcPerRequest.toFixed(3)} |`,
    );
  }
  return lines.join("\n");
}

function renderRunInfo(seed) {
  const cpu = os.cpus()[0]?.model?.trim() ?? "unknown CPU";
  return [
    `- Date: ${new Date().toISOString().slice(0, 10)}`,
    `- Machine: ${cpu} × ${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GiB, ${os.platform()} ${os.release()}`,
    `- Node ${process.version}; ${VUS} VUs for ${DURATION} per endpoint, one endpoint at a time`,
    `- Data: ${seed.contracts.length} contracts, ${seed.events} events, ${seed.wallets.length} wallets`,
    `- Mock RPC simulate latency: ${process.env.MOCK_RPC_LATENCY_MS ?? 50} ms`,
  ].join("\n");
}

async function main() {
  if (!k6Available()) {
    console.error(
      `k6 not found (${K6}). Install it (https://grafana.com/docs/k6/latest/set-up/install-k6/, ` +
        "e.g. `brew install k6`) or point K6_BIN at a k6 binary.",
    );
    process.exit(1);
  }
  fs.mkdirSync(resultsDir, { recursive: true });

  console.log("== Seeding synthetic events database");
  run(process.execPath, [path.join(here, "seed.mjs")], { DB_PATH });
  const seed = JSON.parse(fs.readFileSync(path.join(resultsDir, "seed.json"), "utf8"));

  console.log("== Starting mock RPC");
  start("mock RPC", [path.join(here, "mock-rpc.mjs")], {
    MOCK_RPC_PORT: String(RPC_PORT),
    MOCK_RPC_START_LEDGER: String(seed.latestLedger + 1),
    SOROBAN_NETWORK_PASSPHRASE: PASSPHRASE,
  });
  await waitFor("mock RPC", `${RPC_URL}/stats`);

  console.log("== Starting backend");
  const unlimited = "1000000000";
  start("backend", [path.join(root, "dist", "index.js")], {
    NODE_ENV: "development",
    PORT: String(BACKEND_PORT),
    LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
    DB_PATH,
    SOROBAN_RPC_URL: RPC_URL,
    SOROBAN_NETWORK_PASSPHRASE: PASSPHRASE,
    CONTRACT_ID: seed.contracts[0],
    // Lift every limiter on these routes: k6 sends everything from one IP,
    // and the point is to measure the handlers, not the 429 path.
    RATE_LIMIT_MAX: unlimited,
    JOB_CONTRACT_RATE_MAX: unlimited,
    BY_WALLET_RATE_LIMIT_MAX: unlimited,
  });
  await waitFor("backend /ready", `${BASE_URL}/ready`);

  const rows = [];
  for (const endpoint of ENDPOINTS) {
    console.log(`== k6: ${endpoint}`);
    const summaryPath = path.join(resultsDir, `${endpoint}.json`);
    const before = await rpcStats();
    run(K6, ["run", "--quiet", path.join(here, "read-endpoints.js")], {
      ENDPOINT: endpoint,
      BASE_URL,
      VUS,
      DURATION,
      SUMMARY_PATH: summaryPath,
    });
    const after = await rpcStats();
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    const method = ENDPOINT_RPC[endpoint];
    summary.rpcPerRequest = method
      ? ((after[method] ?? 0) - (before[method] ?? 0)) / Math.max(1, summary.requests)
      : null;
    rows.push(summary);
  }

  const table = renderTable(rows);
  const info = renderRunInfo(seed);
  fs.writeFileSync(path.join(resultsDir, "baseline.md"), `${info}\n\n${table}\n`);
  console.log(`\n${info}\n\n${table}\n`);

  if (write) {
    const doc = path.join(root, "docs", "PERFORMANCE.md");
    const content = fs.readFileSync(doc, "utf8");
    const start = "<!-- baseline:start -->";
    const end = "<!-- baseline:end -->";
    const from = content.indexOf(start);
    const to = content.indexOf(end);
    if (from === -1 || to < from) throw new Error(`${doc} needs ${start} and ${end} markers`);
    fs.writeFileSync(
      doc,
      `${content.slice(0, from)}${start}\n${info}\n\n${table}\n${content.slice(to)}`,
    );
    console.log("Updated docs/PERFORMANCE.md");
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(stopAll);
