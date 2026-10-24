import { Router } from "express";
import { randomUUID } from "crypto";
import { requireAdmin } from "../middleware/adminAuth.js";
import { getIndexerStatusData } from "../indexer/db.js";
import { getIndexerUptimeSeconds } from "../indexer/status.js";
import { getLatestReconciliationResults } from "../indexer/reconciliation.js";
import {
  getDeadDeliveries,
  getFailedDeliveryCount,
} from "../indexer/webhook-delivery.js";
import {
  fetchHistoricalEvents,
  getLatestLedgerSequence,
  validateHistoricalRange,
  type HistoricalImportResult,
} from "../indexer/poller.js";

import { z } from "zod";
import { contractIdSchema } from "../schemas/jobs.js";
import { validate } from "../middleware/validate.js";
import {
  getAllContracts,
  registerContract,
  deregisterContract,
} from "../indexer/db.js";

const router = Router();

router.use(requireAdmin);

type BackfillJob = HistoricalImportResult & {
  jobId: string;
  status: "running" | "done" | "failed";
  startLedger: number;
  endLedger: number;
  contractId?: string;
};

let backfillJob: BackfillJob | null = null;
let backfillStarting = false;

router.post("/backfill", async (req, res) => {
  const body = req.body as Record<string, unknown> | undefined;
  const startLedger = body?.startLedger;
  const endLedger = body?.endLedger;
  const contractId = body?.contractId;

  if (
    typeof startLedger !== "number" ||
    !Number.isInteger(startLedger) ||
    typeof endLedger !== "number" ||
    !Number.isInteger(endLedger)
  ) {
    return res.status(400).json({
      success: false,
      error: "startLedger and endLedger must be integers",
    });
  }

  if (
    contractId !== undefined &&
    (typeof contractId !== "string" || contractId.trim().length === 0)
  ) {
    return res.status(400).json({
      success: false,
      error: "contractId must be a non-empty string",
    });
  }

  if (backfillStarting || backfillJob?.status === "running") {
    return res.status(409).json({ success: false, error: "A backfill is already running" });
  }

  backfillStarting = true;
  try {
    const chainHead = await getLatestLedgerSequence();
    const validation = validateHistoricalRange(startLedger, endLedger, chainHead);
    if (!validation.valid) {
      return res.status(400).json({ success: false, error: validation.error });
    }

    const job: BackfillJob = {
      jobId: randomUUID(),
      status: "running",
      startLedger,
      endLedger,
      ...(typeof contractId === "string" ? { contractId } : {}),
      eventsFound: 0,
      eventsImported: 0,
    };
    backfillJob = job;

    void fetchHistoricalEvents(startLedger, endLedger, job.contractId, (progress) => {
      if (backfillJob?.jobId === job.jobId) {
        backfillJob = { ...backfillJob, ...progress };
      }
    }).then(
      (result) => {
        if (backfillJob?.jobId === job.jobId) {
          backfillJob = { ...job, ...result, status: "done" };
        }
      },
      () => {
        if (backfillJob?.jobId === job.jobId) {
          backfillJob = { ...backfillJob, status: "failed" };
        }
      },
    );

    return res.status(202).json({ success: true, data: job });
  } catch {
    return res.status(503).json({
      success: false,
      error: "Unable to validate backfill range",
    });
  } finally {
    backfillStarting = false;
  }
});

router.get("/backfill", (_req, res) => {
  res.json({
    success: true,
    data: backfillJob ?? { status: "idle" },
  });
});

const registerContractBodySchema = z.object({
  contractId: contractIdSchema,
  label: z.string().optional(),
  startLedger: z.number().int().nonnegative().optional(),
});

const contractParamSchema = z.object({
  contractId: contractIdSchema,
});

router.get("/contracts", (_req, res) => {
  const contracts = getAllContracts();
  res.json({
    success: true,
    contracts: contracts.map((c) => ({
      contractId: c.contract_id,
      label: c.label,
      active: Boolean(c.active),
      registered_at: c.registered_at,
      lastLedgerSequence: c.last_ledger_sequence,
      startLedger: c.start_ledger,
    })),
  });
});

router.post("/contracts", validate(registerContractBodySchema, "body"), (req, res) => {
  const { contractId, label, startLedger } = req.body as {
    contractId: string;
    label?: string;
    startLedger?: number;
  };
  registerContract(contractId, label, startLedger);
  res.status(201).json({
    success: true,
    message: "Contract registered successfully",
    contract: {
      contractId,
      label: label ?? null,
      active: true,
      startLedger: startLedger ?? 0,
    },
  });
});

router.delete("/contracts/:contractId", validate(contractParamSchema, "params"), (req, res) => {
  const { contractId } = req.params as { contractId: string };
  deregisterContract(contractId);
  res.json({
    success: true,
    message: "Contract deregistered successfully",
    contractId,
  });
});

router.get("/indexer-status", (_req, res) => {
  const status = getIndexerStatusData();
  res.json({
    success: true,
    lastIndexedLedger: status.lastIndexedLedger,
    totalEvents: status.totalEvents,
    uptimeSeconds: getIndexerUptimeSeconds(),
    lastEventAt: status.lastEventAt,
    eventsByType: status.eventsByType,
    skippedLedgerRange: status.skippedLedgerRange ?? null,
    reconciliation: getLatestReconciliationResults(),
    failedDeliveries: getFailedDeliveryCount(),
    deadDeliveries: getDeadDeliveries(),
  });
});

export default router;

