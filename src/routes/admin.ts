import { Router } from "express";
import { randomUUID } from "crypto";
import { requireAdmin } from "../middleware/adminAuth.js";
import { getIndexerStatusData } from "../indexer/db.js";
import { getIndexerUptimeSeconds } from "../indexer/status.js";
import { getLatestReconciliationResults } from "../indexer/reconciliation.js";
import {
  fetchHistoricalEvents,
  getLatestLedgerSequence,
  validateHistoricalRange,
  type HistoricalImportResult,
} from "../indexer/poller.js";

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

router.get("/indexer-status", (_req, res) => {
  const status = getIndexerStatusData();
  res.json({
    success: true,
    lastIndexedLedger: status.lastIndexedLedger,
    totalEvents: status.totalEvents,
    uptimeSeconds: getIndexerUptimeSeconds(),
    lastEventAt: status.lastEventAt,
    eventsByType: status.eventsByType,
    reconciliation: getLatestReconciliationResults(),
  });
});

export default router;
