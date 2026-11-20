#!/usr/bin/env node
/**
 * Synthetic indexer database for the read-endpoint load test (#965).
 *
 * Writes LOADTEST_CONTRACTS monitored escrows and LOADTEST_EVENTS events
 * (an `init` naming the parties, then fund/deliver/approve events) into a
 * fresh SQLite file at DB_PATH, through the backend's own migrations and
 * insert path so the schema, indexes and job_participants rows match
 * production. Needs the compiled backend: run `npm run build` first.
 *
 * Also writes loadtest/results/seed.json (contract ids, wallets) for the k6
 * script and the mock RPC.
 *
 *   node loadtest/seed.mjs
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StrKey } from "@stellar/stellar-sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const CONTRACTS = Number(process.env.LOADTEST_CONTRACTS ?? 1000);
const EVENTS = Number(process.env.LOADTEST_EVENTS ?? 100_000);
const WALLETS = Number(process.env.LOADTEST_WALLETS ?? 2000);
// One wallet takes part in every HOT_EVERY-th job: the worst case for
// GET /by-wallet/:address.
const HOT_EVERY = Number(process.env.LOADTEST_HOT_WALLET_EVERY ?? 10);
const DB_PATH = path.resolve(root, process.env.DB_PATH ?? "data/loadtest.db");
const SEED_FILE = path.join(here, "results", "seed.json");

if (!(CONTRACTS > 0 && EVENTS >= CONTRACTS && WALLETS >= 3)) {
  console.error("Need LOADTEST_CONTRACTS > 0, LOADTEST_EVENTS >= contracts, LOADTEST_WALLETS >= 3");
  process.exit(1);
}

// The db module resolves DB_PATH when first used; keep its logs quiet.
process.env.DB_PATH = DB_PATH;
process.env.LOG_LEVEL ??= "warn";

const distDb = path.join(root, "dist", "indexer", "db.js");
if (!fs.existsSync(distDb)) {
  console.error("dist/ not found: run `npm run build` first.");
  process.exit(1);
}
const { runMigrations, registerContract, insertEventBatch, closeDb } = await import(distDb);

for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(DB_PATH + suffix, { force: true });
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

/** Deterministic 32 bytes per label, so every run seeds the same data. */
const bytes = (label) => createHash("sha256").update(`loadtest:${label}`).digest();

const wallets = Array.from({ length: WALLETS }, (_, i) =>
  StrKey.encodeEd25519PublicKey(bytes(`wallet:${i}`)),
);
const contracts = Array.from({ length: CONTRACTS }, (_, i) =>
  StrKey.encodeContract(bytes(`contract:${i}`)),
);
const token = StrKey.encodeContract(bytes("token"));
const hotWallet = wallets[0];

// Small deterministic PRNG (mulberry32) for party assignment.
let state = 0x9e3779b9;
const random = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = () => wallets[1 + Math.floor(random() * (WALLETS - 1))];

runMigrations();
contracts.forEach((id, i) => registerContract(id, `loadtest-${i}`, 1));

const FOLLOW_UPS = ["fund", "deliver", "approve"];
const BATCH = 5000;
const baseTime = 1_700_000_000;
let ledger = 0;
let batch = [];
let written = 0;

const flush = () => {
  if (batch.length === 0) return;
  insertEventBatch(batch, ledger);
  written += batch.length;
  batch = [];
};

// Events are spread evenly; the first contracts take the remainder.
const perContract = Math.floor(EVENTS / CONTRACTS);
const remainder = EVENTS % CONTRACTS;

contracts.forEach((contractId, i) => {
  const count = perContract + (i < remainder ? 1 : 0);
  const client = pick();
  const freelancer = pick();
  const arbiter = i % HOT_EVERY === 0 ? hotWallet : pick();
  for (let e = 0; e < count; e++) {
    ledger += 1;
    const eventType = e === 0 ? "init" : FOLLOW_UPS[(e - 1) % FOLLOW_UPS.length];
    const data =
      e === 0
        ? { client, freelancer, arbiter, token, milestones: ["1000", "2500"] }
        : { milestone_index: (e - 1) % 2, amount: "1000" };
    batch.push({
      contractId,
      eventType,
      ledgerSequence: ledger,
      timestamp: baseTime + ledger * 5,
      dataJson: JSON.stringify(data),
      eventId: `loadtest-${ledger}`,
    });
    if (batch.length >= BATCH) flush();
  }
});
flush();
closeDb();

fs.mkdirSync(path.dirname(SEED_FILE), { recursive: true });
fs.writeFileSync(
  SEED_FILE,
  JSON.stringify(
    { dbPath: DB_PATH, contracts, wallets, hotWallet, token, events: written, latestLedger: ledger },
    null,
    2,
  ),
);

console.log(
  `Seeded ${DB_PATH}: ${CONTRACTS} contracts, ${written} events, ${WALLETS} wallets ` +
    `(hot wallet in ${Math.ceil(CONTRACTS / HOT_EVERY)} jobs), latest ledger ${ledger}.`,
);
