import { Router } from "express";
import type { Request, Response } from "express";
import {
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import NodeCache from "node-cache";
import {
  jobContractSecurityHeaders,
} from "../middleware/job-contract-security.js";
import { jobContractRateLimit } from "../middleware/job-contract-rate-limit.js";
import { sendError, sendSuccess } from "../utils/api-response.js";
import { isValidStellarContractId } from "../utils/stellar.js";
import {
  server,
  NETWORK_PASSPHRASE,
  simulationSource,
  classifySimError,
  SimError,
} from "../utils/soroban-call.js";
import { getInclusionFee } from "../utils/fee-helper.js";
import { maskAddress, convertScValToNativeStrings, parseJobFromResult } from "./jobs/shared.js";
import { getCachedJobState, JOB_STATE_CACHE_TTL_S } from "../indexer/job-state-cache.js";
import { getDb, EventDbRow } from "../indexer/db.js";
import logger from "../utils/logger.js";
import { formatError } from "../utils/format-error.js";

const router = Router();

export const disputeStateCache = new NodeCache({
  stdTTL: JOB_STATE_CACHE_TTL_S,
  useClones: false,
});

const inFlightDisputeRequests = new Map<string, Promise<unknown>>();

export function resetDisputeStateCache(): void {
  disputeStateCache.flushAll();
  inFlightDisputeRequests.clear();
}

export function parseDisputeId(disputeId: string): {
  contractId: string;
  milestoneIndex: number;
} | null {
  if (typeof disputeId !== "string") return null;
  const parts = disputeId.split(":");
  if (parts.length !== 2) return null;
  const [contractId, indexStr] = parts;
  if (!isValidStellarContractId(contractId)) return null;
  if (!/^\d+$/.test(indexStr)) return null;
  const milestoneIndex = parseInt(indexStr, 10);
  if (!Number.isSafeInteger(milestoneIndex) || milestoneIndex < 0) return null;
  return { contractId, milestoneIndex };
}

export function hasMilestoneBeenDisputed(
  contractId: string,
  milestoneIndex: number,
): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM events
       WHERE contract_id = ?
         AND event_type IN ('dispute', 'evidence', 'dispescal', 'resolve', 'arbsplit', 'dispute_raised', 'dispute_resolved')
         AND (
           CAST(json_extract(data_json, '$.milestone_index') AS INTEGER) = ?
           OR CAST(json_extract(data_json, '$.milestoneIndex') AS INTEGER) = ?
         )
       LIMIT 1`,
    )
    .get(contractId, milestoneIndex, milestoneIndex);
  return Boolean(row);
}

function getIndexedEventsForMilestone(
  contractId: string,
  milestoneIndex: number,
): Array<{ row: EventDbRow; data: Record<string, unknown> }> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM events
       WHERE contract_id = ?
       ORDER BY ledger_sequence ASC, id ASC`,
    )
    .all(contractId) as EventDbRow[];

  const matched: Array<{ row: EventDbRow; data: Record<string, unknown> }> = [];
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data_json) as Record<string, unknown>;
      const idx =
        data.milestone_index !== undefined
          ? Number(data.milestone_index)
          : data.milestoneIndex !== undefined
            ? Number(data.milestoneIndex)
            : null;
      if (idx === milestoneIndex) {
        matched.push({ row, data });
      }
    } catch {
      // ignore invalid json
    }
  }
  return matched;
}

// ---------------------------------------------------------------------------
// GET /api/disputes/:disputeId
// ---------------------------------------------------------------------------
router.get(
  "/:disputeId",
  jobContractSecurityHeaders,
  jobContractRateLimit,
  async (req: Request, res: Response) => {
    const rawDisputeId = Array.isArray(req.params.disputeId)
      ? req.params.disputeId[0]
      : req.params.disputeId;
    const parsed = parseDisputeId(rawDisputeId);
    if (!parsed) {
      sendError(res, 400, "Invalid dispute ID format. Expected <contractId>:<milestoneIndex>");
      return;
    }

    const { contractId, milestoneIndex } = parsed;

    try {
      // Simulate and cache dispute state in the same manner as GET /:contractId
      const cached = disputeStateCache.get<Record<string, unknown>>(rawDisputeId);
      if (cached !== undefined) {
        sendSuccess(res, cached);
        return;
      }

      let requestPromise = inFlightDisputeRequests.get(rawDisputeId) as
        | Promise<Record<string, unknown> | null>
        | undefined;

      if (!requestPromise) {
        requestPromise = (async (): Promise<Record<string, unknown> | null> => {
          const contract = new Contract(contractId);
          const account = simulationSource();
          const tx = new TransactionBuilder(account, {
            fee: await getInclusionFee(server),
            networkPassphrase: NETWORK_PASSPHRASE,
          })
            .addOperation(
              contract.call(
                "get_dispute_info",
                nativeToScVal(milestoneIndex, { type: "u32" }),
              ),
            )
            .setTimeout(30)
            .build();

          const result = await server.simulateTransaction(tx);

          if ("error" in result) {
            const { status } = classifySimError(String(result.error));
            if (status === 404) return null;
            logger.error("Failed to simulate get_dispute_info", {
              contractId,
              milestoneIndex,
              error: String(result.error),
            });
            throw new SimError(500, "Internal server error");
          }

          if (!("result" in result) || !result.result?.retval) {
            return null;
          }

          let rawRetval: unknown;
          try {
            rawRetval = scValToNative(result.result.retval);
          } catch {
            rawRetval = result.result.retval;
          }

          if (rawRetval === null || rawRetval === undefined) {
            return null;
          }

          return convertScValToNativeStrings(rawRetval) as Record<string, unknown>;
        })();

        inFlightDisputeRequests.set(rawDisputeId, requestPromise);
      }

      let disputeData: Record<string, unknown> | null = null;
      try {
        disputeData = await requestPromise;
      } finally {
        inFlightDisputeRequests.delete(rawDisputeId);
      }

      const wasDisputedInDb = hasMilestoneBeenDisputed(contractId, milestoneIndex);

      if (!disputeData && !wasDisputedInDb) {
        sendError(res, 404, "Dispute not found");
        return;
      }

      // Also get job state to include milestone details and party addresses
      let jobClient = "";
      let jobFreelancer = "";
      let jobArbiter = "";
      let milestoneInfo: unknown = { index: milestoneIndex };

      try {
        const { value: job } = await getCachedJobState(contractId, async () => {
          const contract = new Contract(contractId);
          const account = simulationSource();
          const tx = new TransactionBuilder(account, {
            fee: await getInclusionFee(server),
            networkPassphrase: NETWORK_PASSPHRASE,
          })
            .addOperation(contract.call("get_job"))
            .setTimeout(30)
            .build();
          const resSim = await server.simulateTransaction(tx);
          return parseJobFromResult(resSim as Parameters<typeof parseJobFromResult>[0], contractId);
        });

        if (job) {
          jobClient = job.client;
          jobFreelancer = job.freelancer;
          jobArbiter = job.arbiter;
          if (job.milestones && job.milestones[milestoneIndex]) {
            milestoneInfo = job.milestones[milestoneIndex];
          }
        }
      } catch {
        // Fall back to DB addresses if get_job simulation fails
      }

      // If addresses not found from simulation, check DB init event
      if (!jobClient || !jobFreelancer || !jobArbiter) {
        const db = getDb();
        const initRow = db
          .prepare(
            `SELECT data_json FROM events WHERE contract_id = ? AND event_type IN ('init', 'initialized') LIMIT 1`,
          )
          .get(contractId) as { data_json: string } | undefined;
        if (initRow) {
          try {
            const initData = JSON.parse(initRow.data_json) as Record<string, string>;
            jobClient = jobClient || initData.client || "";
            jobFreelancer = jobFreelancer || initData.freelancer || "";
            jobArbiter = jobArbiter || initData.arbiter || "";
          } catch {
            // ignore
          }
        }
      }

      const responsePayload: Record<string, unknown> = {
        disputeId: rawDisputeId,
        contractId,
        milestoneIndex,
        client: jobClient,
        freelancer: jobFreelancer,
        arbiter: jobArbiter,
        parties: {
          client: jobClient,
          freelancer: jobFreelancer,
          arbiter: jobArbiter,
        },
        milestone: milestoneInfo,
        dispute: disputeData,
        ...(typeof disputeData === "object" && disputeData !== null
          ? disputeData
          : { state: disputeData }),
      };

      if (disputeData !== null && JOB_STATE_CACHE_TTL_S > 0) {
        disputeStateCache.set(rawDisputeId, responsePayload);
      }

      logger.info("Dispute fetched successfully", {
        disputeId: rawDisputeId,
        client: maskAddress(jobClient),
        freelancer: maskAddress(jobFreelancer),
        arbiter: maskAddress(jobArbiter),
      });

      sendSuccess(res, responsePayload);
    } catch (err: unknown) {
      if (err instanceof SimError) {
        sendError(res, err.status, err.message);
        return;
      }
      logger.error("Failed to fetch dispute", {
        disputeId: rawDisputeId,
        error: formatError(err),
      });
      sendError(res, 500, "Internal server error");
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/disputes/:disputeId/history
// ---------------------------------------------------------------------------
router.get(
  "/:disputeId/history",
  jobContractSecurityHeaders,
  jobContractRateLimit,
  (req: Request, res: Response) => {
    const rawDisputeId = Array.isArray(req.params.disputeId)
      ? req.params.disputeId[0]
      : req.params.disputeId;
    const parsed = parseDisputeId(rawDisputeId);
    if (!parsed) {
      sendError(res, 400, "Invalid dispute ID format. Expected <contractId>:<milestoneIndex>");
      return;
    }

    const { contractId, milestoneIndex } = parsed;

    if (!hasMilestoneBeenDisputed(contractId, milestoneIndex)) {
      sendError(res, 404, "Milestone has never been disputed");
      return;
    }

    const events = getIndexedEventsForMilestone(contractId, milestoneIndex);

    const history: Array<{
      type: "raised" | "evidence_submitted" | "escalated" | "resolved";
      actor: string | null;
      timestamp: number | null;
      ledger: number;
      txHash: string | null;
    }> = [];

    for (const { row, data } of events) {
      let mappedType: "raised" | "evidence_submitted" | "escalated" | "resolved" | null = null;
      if (row.event_type === "dispute" || row.event_type === "dispute_raised") {
        mappedType = "raised";
      } else if (row.event_type === "evidence" || row.event_type === "evidence_submitted") {
        mappedType = "evidence_submitted";
      } else if (row.event_type === "dispescal" || row.event_type === "dispute_escalated") {
        mappedType = "escalated";
      } else if (
        row.event_type === "resolve" ||
        row.event_type === "arbsplit" ||
        row.event_type === "dispute_resolved"
      ) {
        mappedType = "resolved";
      }

      if (!mappedType) continue;

      const actor =
        (data.actor as string) ||
        (data.caller as string) ||
        (data.submitter as string) ||
        (data.arbiter as string) ||
        (data.client as string) ||
        (data.freelancer as string) ||
        null;

      history.push({
        type: mappedType,
        actor,
        timestamp: row.timestamp ?? null,
        ledger: row.ledger_sequence,
        txHash: row.tx_hash ?? null,
      });
    }

    sendSuccess(res, history);
  },
);

// ---------------------------------------------------------------------------
// GET /api/disputes/:disputeId/evidence
// ---------------------------------------------------------------------------
router.get(
  "/:disputeId/evidence",
  jobContractSecurityHeaders,
  jobContractRateLimit,
  (req: Request, res: Response) => {
    const rawDisputeId = Array.isArray(req.params.disputeId)
      ? req.params.disputeId[0]
      : req.params.disputeId;
    const parsed = parseDisputeId(rawDisputeId);
    if (!parsed) {
      sendError(res, 400, "Invalid dispute ID format. Expected <contractId>:<milestoneIndex>");
      return;
    }

    const { contractId, milestoneIndex } = parsed;

    if (!hasMilestoneBeenDisputed(contractId, milestoneIndex)) {
      sendError(res, 404, "Milestone has never been disputed");
      return;
    }

    const events = getIndexedEventsForMilestone(contractId, milestoneIndex);

    const evidenceList: Array<{
      evidenceHash: string | null;
      evidence_hash?: string | null;
      submitter: string | null;
      timestamp: number | null;
      ledger: number;
      txHash: string | null;
    }> = [];

    for (const { row, data } of events) {
      if (row.event_type !== "evidence" && row.event_type !== "evidence_submitted") {
        continue;
      }

      const hash =
        (data.evidence_hash as string) ||
        (data.evidenceHash as string) ||
        (data.hash as string) ||
        (data.evidence as string) ||
        null;

      const submitter =
        (data.submitter as string) ||
        (data.submitter_address as string) ||
        (data.actor as string) ||
        (data.caller as string) ||
        null;

      evidenceList.push({
        evidenceHash: hash,
        evidence_hash: hash,
        submitter,
        timestamp: row.timestamp ?? null,
        ledger: row.ledger_sequence,
        txHash: row.tx_hash ?? null,
      });
    }

    sendSuccess(res, evidenceList);
  },
);

export default router;
