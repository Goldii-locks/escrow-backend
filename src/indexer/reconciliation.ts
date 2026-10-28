/**
 * Scheduled ledger reconciliation (#714).
 *
 * For each active monitored contract this job:
 *   1. Sums indexed `fund` inflows and known outflow events from the local
 *      `events` table (via `sumLedgerAmounts`, which validates digit limits).
 *   2. Reads the contract's on-chain token balance (SEP-41 `balance(contract)`).
 *   3. Compares `expected = inflow - outflow` against the on-chain balance and
 *      records the result in `reconciliation_results`.
 *
 * The balance reader is injectable so the comparison logic can be tested
 * without an RPC node. A non-zero `delta` is recorded as `mismatch`; a failed
 * read is recorded as `error` and never throws out of the job.
 */

import {
  Account,
  Contract,
  Keypair,
  TransactionBuilder,
  Address,
  scValToNative,
} from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";
import { getDb } from "./db.js";
import { sumLedgerAmounts } from "../utils/audit_ledger_sum_checker.js";
import logger from "../utils/logger.js";
import { rpcAllowHttp } from "../utils/rpc-allow-http.js";

const RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.SOROBAN_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
const BASE_FEE = "100";

/** Event types counted as inflows to the escrow. */
export const INFLOW_EVENT_TYPES = ["fund"] as const;

/**
 * Event types counted as outflows from the escrow. The amount field used for
 * each type is listed in `EVENT_AMOUNT_FIELDS`; types not listed there use
 * `amount`.
 */
export const OUTFLOW_EVENT_TYPES = [
  "approve",
  "claim",
  "splitref",
  "arbsplit",
  "epspltref",
  "cxlspref",
  "admovrls",
  "admovrf",
  "admstrm",
  "adtxrls",
  "msadmrel",
  "msadmref",
] as const;

const EVENT_AMOUNT_FIELDS: Partial<Record<string, string>> = {
  fund: "total_amount",
};

export type ReconciliationStatus = "match" | "mismatch" | "error";

export interface ReconciliationResult {
  contract_id: string;
  token: string | null;
  inflow_total: string;
  outflow_total: string;
  expected_balance: string;
  onchain_balance: string | null;
  delta: string | null;
  status: ReconciliationStatus;
  error: string | null;
  checked_at: number;
}

/** Reads the on-chain token balance held by `contractId` for `token`. */
export type BalanceReader = (contractId: string, token: string) => Promise<bigint>;

// ---------------------------------------------------------------------------
// Ledger aggregation
// ---------------------------------------------------------------------------

function extractAmounts(
  contractId: string,
  eventTypes: readonly string[]
): Array<string | number | bigint> {
  const db = getDb();
  const placeholders = eventTypes.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT event_type, data_json FROM events
       WHERE contract_id = ? AND event_type IN (${placeholders})`
    )
    .all(contractId, ...eventTypes) as Array<{ event_type: string; data_json: string }>;

  const amounts: Array<string | number | bigint> = [];
  for (const row of rows) {
    const field = EVENT_AMOUNT_FIELDS[row.event_type] ?? "amount";
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(row.data_json) as Record<string, unknown>;
    } catch {
      throw new Error(`events row for ${row.event_type} has invalid data_json`);
    }
    const value = data[field];
    if (value === undefined || value === null) {
      throw new Error(`${row.event_type} event is missing field "${field}"`);
    }
    amounts.push(value as string | number);
  }
  return amounts;
}

function sumOrThrow(
  amounts: Array<string | number | bigint>,
  clientKey: string
): bigint {
  const result = sumLedgerAmounts(amounts, { clientKey });
  if (!result.ok) {
    throw new Error(`${result.code}: ${result.error}`);
  }
  return result.value;
}

/** Token address for a contract, taken from its most recent init/fund event. */
function resolveToken(contractId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT data_json FROM events
       WHERE contract_id = ? AND event_type IN ('init', 'fund')
       ORDER BY ledger_sequence DESC, id DESC LIMIT 1`
    )
    .get(contractId) as { data_json: string } | undefined;
  if (!row) return null;
  try {
    const token = (JSON.parse(row.data_json) as { token?: unknown }).token;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// On-chain balance (SEP-41 `balance`)
// ---------------------------------------------------------------------------

/**
 * Default balance reader: simulates `balance(id)` on the token contract. A
 * read-only simulation does not need a funded source account, so a random
 * keypair is used as the transaction source.
 */
export const readOnChainBalance: BalanceReader = async (contractId, token) => {
  const server = new Server(RPC_URL, { allowHttp: rpcAllowHttp(RPC_URL) });
  const source = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      new Contract(token).call("balance", new Address(contractId).toScVal())
    )
    .setTimeout(30)
    .build();

  const sim = (await server.simulateTransaction(tx)) as unknown as {
    error?: string;
    result?: { retval?: unknown };
  };
  if (sim.error || !sim.result?.retval) {
    throw new Error(`balance simulation failed: ${sim.error ?? "no result"}`);
  }
  const value = scValToNative(sim.result.retval as never);
  if (typeof value !== "bigint") {
    throw new Error("balance simulation returned a non-integer value");
  }
  return value;
};

// ---------------------------------------------------------------------------
// Core reconciliation
// ---------------------------------------------------------------------------

function persist(result: ReconciliationResult): void {
  getDb()
    .prepare(
      `INSERT INTO reconciliation_results
        (contract_id, token, inflow_total, outflow_total, expected_balance,
         onchain_balance, delta, status, error, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      result.contract_id,
      result.token,
      result.inflow_total,
      result.outflow_total,
      result.expected_balance,
      result.onchain_balance,
      result.delta,
      result.status,
      result.error,
      result.checked_at
    );
}

/**
 * Reconcile one contract and record the result. Never throws for per-contract
 * failures; those are recorded with `status: "error"`.
 */
export async function reconcileContract(
  contractId: string,
  reader: BalanceReader = readOnChainBalance
): Promise<ReconciliationResult> {
  const checkedAt = Math.floor(Date.now() / 1000);
  const token = resolveToken(contractId);

  let inflow = 0n;
  let outflow = 0n;
  try {
    inflow = sumOrThrow(extractAmounts(contractId, INFLOW_EVENT_TYPES), `reconcile:${contractId}`);
    outflow = sumOrThrow(extractAmounts(contractId, OUTFLOW_EVENT_TYPES), `reconcile:${contractId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result: ReconciliationResult = {
      contract_id: contractId,
      token,
      inflow_total: "0",
      outflow_total: "0",
      expected_balance: "0",
      onchain_balance: null,
      delta: null,
      status: "error",
      error: `ledger sum failed: ${message}`,
      checked_at: checkedAt,
    };
    persist(result);
    logger.error("Reconciliation ledger sum failed", { contractId, error: message });
    return result;
  }

  const expected = inflow - outflow;
  const base = {
    contract_id: contractId,
    token,
    inflow_total: inflow.toString(),
    outflow_total: outflow.toString(),
    expected_balance: expected.toString(),
    checked_at: checkedAt,
  };

  if (!token) {
    const result: ReconciliationResult = {
      ...base,
      onchain_balance: null,
      delta: null,
      status: "error",
      error: "no token address found in init/fund events",
    };
    persist(result);
    return result;
  }

  try {
    const onchain = await reader(contractId, token);
    const delta = onchain - expected;
    const result: ReconciliationResult = {
      ...base,
      onchain_balance: onchain.toString(),
      delta: delta.toString(),
      status: delta === 0n ? "match" : "mismatch",
      error: null,
    };
    persist(result);
    if (result.status === "mismatch") {
      logger.warn("Reconciliation mismatch", { contractId, expected: base.expected_balance, onchain: result.onchain_balance, delta: result.delta });
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result: ReconciliationResult = {
      ...base,
      onchain_balance: null,
      delta: null,
      status: "error",
      error: message,
    };
    persist(result);
    logger.error("Reconciliation balance read failed", { contractId, error: message });
    return result;
  }
}

/** Reconcile every active monitored contract. */
export async function runReconciliation(
  reader: BalanceReader = readOnChainBalance
): Promise<ReconciliationResult[]> {
  const rows = getDb()
    .prepare("SELECT contract_id FROM monitored_contracts WHERE active = 1 ORDER BY id")
    .all() as Array<{ contract_id: string }>;

  const results: ReconciliationResult[] = [];
  for (const row of rows) {
    results.push(await reconcileContract(row.contract_id, reader));
  }
  return results;
}

/** Latest reconciliation row per contract, for the admin status endpoint. */
export function getLatestReconciliationResults(): ReconciliationResult[] {
  return getDb()
    .prepare(
      `SELECT r.* FROM reconciliation_results r
       JOIN (SELECT contract_id, MAX(id) AS max_id FROM reconciliation_results GROUP BY contract_id) m
         ON r.id = m.max_id
       ORDER BY r.contract_id`
    )
    .all() as ReconciliationResult[];
}

/**
 * Start the scheduled reconciliation job. Interval comes from
 * RECONCILE_INTERVAL_MS (default 3600000). Overlapping runs are skipped.
 */
export function startReconciliationJob(
  reader: BalanceReader = readOnChainBalance
): NodeJS.Timeout {
  const configured = Number(process.env.RECONCILE_INTERVAL_MS ?? "3600000");
  const intervalMs = Number.isFinite(configured) && configured > 0 ? configured : 3600000;
  let running = false;

  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runReconciliation(reader);
    } catch (err) {
      logger.error("Reconciliation run failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
