/**
 * Escrow state for GET /api/jobs/:contractId (#967).
 *
 * The job page needs more than `get_job`: per-milestone due dates
 * (`get_milestone_due_at`, used by `reclaim_overdue`), revision counts
 * (`get_revision_count`, capped by the contract's MAX_REVISIONS), whether the
 * freelancer and arbiter have accepted, and the pause / cancel state.
 *
 * RPC cost per uncached request is bounded and independent of the milestone
 * count:
 *
 * 1. one `simulateTransaction` of `get_escrow_state`, which returns the job,
 *    both pause flags and the cancel lock / approval mask in a single read;
 * 2. one `getLedgerEntries` call that reads every milestone's `DueAt(i)` and
 *    `RevCnt(i)` persistent entry directly. The per-milestone getters would
 *    cost one simulation each (2 × milestones); the contract caps an escrow at
 *    50 milestones, so the 100 keys always fit in one request (the RPC
 *    accepts up to 200).
 *
 * Acceptance has no contract getter (`DataKey::Acceptance` is private), so it
 * is derived from the indexed `acceptjob` / `acceptarb` events with no RPC
 * call at all. The result is cached by the job-state cache, which the poller
 * invalidates whenever it stores a new event for the contract.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { scValToNative } from "@stellar/stellar-sdk";
import { server } from "../../utils/soroban-call.js";
import { getJobAcceptance } from "../../indexer/db.js";
import logger from "../../utils/logger.js";
import { formatError } from "../../utils/format-error.js";
import { convertScValToNativeStrings } from "./shared.js";

/** Most keys one Soroban RPC `getLedgerEntries` request accepts. */
export const LEDGER_ENTRIES_MAX_KEYS = 200;

export interface MilestoneView {
  index: number;
  amount: string;
  status: string;
  /** Delivery deadline (unix seconds, decimal string); null when none is set. */
  dueAt: string | null;
  /** Revisions requested so far; null when the ledger read failed. */
  revisionCount: number | null;
}

export interface EscrowJobView {
  id: string;
  client: string;
  freelancer: string;
  arbiter: string;
  token: string;
  funded: unknown;
  milestones: MilestoneView[];
  /** Null when the indexed events could not be read. */
  acceptance: { freelancer: boolean; arbiter: boolean } | null;
  /** `emergency` is the party pause, `admin` the admin pause. */
  paused: { emergency: boolean; admin: boolean } | null;
  /** Mutual cancellation: the lock and which parties have approved. */
  cancel: {
    locked: boolean;
    clientApproved: boolean;
    freelancerApproved: boolean;
  } | null;
}

type DecodedRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is DecodedRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Unit enum variants decode to a one-element array, e.g. ["Pending"].
const decodeStatus = (status: unknown): string =>
  String(Array.isArray(status) ? status[0] : status);

/**
 * Decode a `get_escrow_state` retval. A bare `Job` retval (the `get_job`
 * shape) is still accepted, with the escrow-only fields reported as null.
 * Returns null when the simulation produced no retval.
 */
export function parseEscrowStateFromResult(result: any, contractId: string) {
  if (!("result" in result) || !result.result?.retval) return null;

  const decoded = scValToNative(result.result.retval);
  const state: DecodedRecord | null =
    isRecord(decoded) && isRecord(decoded.job) ? decoded : null;
  const job = state ? state.job : decoded;
  if (!isRecord(job) || !Array.isArray(job.milestones)) {
    throw new Error("unexpected get_escrow_state retval shape");
  }

  const pausedState = state?.paused;
  const paused = isRecord(pausedState)
    ? { emergency: Boolean(pausedState.emergency), admin: Boolean(pausedState.admin) }
    : null;

  // approval_mask: bit 1 = client approved, bit 2 = freelancer approved.
  const cancelState = state?.cancel;
  const cancelMask = isRecord(cancelState) ? Number(cancelState.approval_mask ?? 0) : 0;
  const cancel = isRecord(cancelState)
    ? {
        locked: Boolean(cancelState.locked),
        clientApproved: (cancelMask & 1) !== 0,
        freelancerApproved: (cancelMask & 2) !== 0,
      }
    : null;

  return {
    id: contractId,
    client: String(job.client),
    freelancer: String(job.freelancer),
    arbiter: String(job.arbiter),
    token: String(job.token),
    funded: convertScValToNativeStrings(job.funded),
    milestones: (job.milestones as unknown[]).map((m, i) => {
      const milestone: DecodedRecord = isRecord(m) ? m : {};
      return {
        index: i,
        amount: String(milestone.amount),
        status: decodeStatus(milestone.status),
      };
    }),
    paused,
    cancel,
  };
}

/** `DataKey::<variant>(index)` as the contract encodes it: `vec![Symbol, u32]`. */
function milestoneLedgerKey(
  contractAddress: StellarSdk.xdr.ScAddress,
  variant: string,
  index: number,
): StellarSdk.xdr.LedgerKey {
  // Read through the namespace, not a named import: suites that replace the
  // SDK with a partial mock must still be able to load this module.
  const { xdr } = StellarSdk;
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractAddress,
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant), xdr.ScVal.scvU32(index)]),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/**
 * Read every milestone's due date and revision count with `getLedgerEntries`
 * (ceil(2 × milestones / 200) requests, i.e. one for any real escrow). A
 * missing entry is the contract's default: no due date, zero revisions.
 */
export async function readMilestoneCounters(
  contractId: string,
  milestoneCount: number,
): Promise<{ dueAt: Array<string | null>; revisionCount: number[] }> {
  const dueAt: Array<string | null> = Array.from({ length: milestoneCount }, () => null);
  const revisionCount: number[] = Array.from({ length: milestoneCount }, () => 0);
  if (milestoneCount === 0) return { dueAt, revisionCount };

  const contractAddress = new StellarSdk.Address(contractId).toScAddress();
  const wanted = new Map<string, { field: "dueAt" | "revisionCount"; index: number }>();
  const keys: StellarSdk.xdr.LedgerKey[] = [];
  for (let index = 0; index < milestoneCount; index++) {
    for (const [variant, field] of [["DueAt", "dueAt"], ["RevCnt", "revisionCount"]] as const) {
      const key = milestoneLedgerKey(contractAddress, variant, index);
      wanted.set(key.toXDR("base64"), { field, index });
      keys.push(key);
    }
  }

  for (let start = 0; start < keys.length; start += LEDGER_ENTRIES_MAX_KEYS) {
    const response = await server.getLedgerEntries(
      ...keys.slice(start, start + LEDGER_ENTRIES_MAX_KEYS),
    );
    for (const entry of response.entries ?? []) {
      const target = wanted.get(entry.key.toXDR("base64"));
      if (!target) continue;
      const value = scValToNative(entry.val.contractData().val()) as bigint | number;
      if (target.field === "dueAt") {
        // get_milestone_due_at returns 0 for "no due date".
        dueAt[target.index] = BigInt(value) === 0n ? null : BigInt(value).toString();
      } else {
        revisionCount[target.index] = Number(value);
      }
    }
  }

  return { dueAt, revisionCount };
}

/**
 * Complete a parsed escrow state with the per-milestone counters and the
 * acceptance flags. Either auxiliary read failing degrades its fields to null
 * instead of failing the whole job view.
 */
export async function completeEscrowJobView(
  parsed: NonNullable<ReturnType<typeof parseEscrowStateFromResult>>,
  contractId: string,
): Promise<EscrowJobView> {
  let counters: Awaited<ReturnType<typeof readMilestoneCounters>> | null = null;
  try {
    counters = await readMilestoneCounters(contractId, parsed.milestones.length);
  } catch (err) {
    logger.warn("Failed to read milestone due dates and revision counts", {
      contractId,
      error: formatError(err),
    });
  }

  let acceptance: EscrowJobView["acceptance"] = null;
  try {
    acceptance = getJobAcceptance(contractId);
  } catch (err) {
    logger.warn("Failed to read job acceptance from indexed events", {
      contractId,
      error: formatError(err),
    });
  }

  return {
    ...parsed,
    milestones: parsed.milestones.map((m) => ({
      ...m,
      dueAt: counters ? counters.dueAt[m.index] : null,
      revisionCount: counters ? counters.revisionCount[m.index] : null,
    })),
    acceptance,
  };
}
