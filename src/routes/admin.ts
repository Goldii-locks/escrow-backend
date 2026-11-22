import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import { requireAdmin, type AdminRequest } from "../middleware/adminAuth.js";
import {
  getIndexerStatusData,
  getSubscriptions,
  getActiveSubscriptions,
  getDisabledSubscriptions,
  getAdminJobs,
} from "../indexer/db.js";
import { getIndexerUptimeSeconds } from "../indexer/status.js";
import { getLatestReconciliationResults } from "../indexer/reconciliation.js";
import {
  getDeadDeliveries,
  getFailedDeliveryCount,
} from "../indexer/webhook-delivery.js";
import {
  fetchHistoricalEvents,
  getConsecutiveFailures,
  getCurrentPollIntervalMs,
  getLastSuccessfulPollAt,
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
  recordAdminAuditLog,
  getAdminAuditLogs,
} from "../indexer/db.js";
import { sendSuccess } from "../utils/api-response.js";
import logger from "../utils/logger.js";
import { formatError } from "../utils/format-error.js";
import { collectIndexerMetrics } from "../indexer/indexer_metrics_collector.js";

const router = Router();

router.use(requireAdmin);

type TargetResolver = string | null | undefined | ((req: Request) => unknown);
type ParamsResolver = unknown;

function isCallableResolver(val: unknown): val is (req: Request) => unknown {
  return typeof val === "function";
}

function auditAction(
  req: Request,
  res: Response,
  action: string,
  targetOrFn: TargetResolver,
  paramsOrFn?: ParamsResolver,
): void {
  res.on("finish", () => {
    try {
      const adminReq = req as AdminRequest;
      const keyIndex = adminReq.adminKeyIndex ?? 0;
      const rawTarget = isCallableResolver(targetOrFn) ? targetOrFn(req) : targetOrFn;
      const target = Array.isArray(rawTarget)
        ? rawTarget.join(",")
        : (rawTarget !== undefined && rawTarget !== null ? String(rawTarget) : null);
      const params = isCallableResolver(paramsOrFn) ? paramsOrFn(req) : (paramsOrFn ?? req.body);
      recordAdminAuditLog({
        key_index: keyIndex,
        request_id: req.id ?? null,
        method: req.method,
        path: req.originalUrl || req.path,
        action,
        target,
        params,
        status: res.statusCode,
      });
    } catch (err) {
      logger.error("Failed to record admin audit log", { error: formatError(err) });
    }
  });
}

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
  auditAction(req, res, "backfill", () => (req.body?.contractId as string) || "all", () => req.body);
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
  auditAction(req, res, "register_contract", () => req.body?.contractId, () => req.body);
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
  auditAction(req, res, "deregister_contract", () => req.params?.contractId, () => req.params);
  const { contractId } = req.params as { contractId: string };
  deregisterContract(contractId);
  res.json({
    success: true,
    message: "Contract deregistered successfully",
    contractId,
  });
});

/**
 * ledgerLag (chain head - lastIndexedLedger) requires an RPC call, so cache it
 * for a few seconds to avoid hitting the RPC on every status refresh. An RPC
 * failure reports ledgerLag as null instead of failing the whole status call.
 */
const LEDGER_LAG_CACHE_TTL_MS = 5000;
let ledgerLagCache: { value: number; at: number } | null = null;

async function getLedgerLagCached(lastIndexedLedger: number): Promise<number | null> {
  const now = Date.now();
  if (ledgerLagCache && now - ledgerLagCache.at < LEDGER_LAG_CACHE_TTL_MS) {
    return ledgerLagCache.value;
  }
  try {
    const lag = (await getLatestLedgerSequence()) - lastIndexedLedger;
    ledgerLagCache = { value: lag, at: now };
    return lag;
  } catch (err) {
    logger.warn("Could not read chain head for indexer status", { error: formatError(err) });
    return null;
  }
}

router.get("/indexer-status", async (_req, res) => {
  const status = getIndexerStatusData();
  const ledgerLag = await getLedgerLagCached(status.lastIndexedLedger);
  sendSuccess(res, {
    lastIndexedLedger: status.lastIndexedLedger,
    totalEvents: status.totalEvents,
    uptimeSeconds: getIndexerUptimeSeconds(),
    lastEventAt: status.lastEventAt,
    eventsByType: status.eventsByType,
    skippedLedgerRange: status.skippedLedgerRange ?? null,
    undecodableEvents: status.undecodableEvents,
    reconciliation: getLatestReconciliationResults(),
    failedDeliveries: getFailedDeliveryCount(),
    deadDeliveries: getDeadDeliveries(),
    consecutiveFailures: getConsecutiveFailures(),
    lastSuccessfulPollAt: getLastSuccessfulPollAt(),
    pollIntervalMs: getCurrentPollIntervalMs(),
    ledgerLag,
  });
});

// GET /api/admin/webhook-subscriptions - every webhook subscription,
// including the ones that were auto-disabled after repeated delivery
// failures (#701).
router.get("/webhook-subscriptions", (_req, res) => {
  res.json({
    success: true,
    subscriptions: getSubscriptions(),
    active: getActiveSubscriptions(),
    disabled: getDisabledSubscriptions(),
  });
});

router.get("/metrics", (_req, res) => {
  try {
    const metrics = collectIndexerMetrics();
    res.json({ success: true, metrics });
  } catch (err) {
    logger.error("admin metrics endpoint failed to collect metrics", {
      error: formatError(err),
    });
    res
      .status(500)
      .json({ success: false, error: "Failed to collect indexer metrics" });
  }
});


router.get("/jobs", (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
  if (status && !["disputed", "active", "completed"].includes(status)) {
    return res.status(400).json({ success: false, error: "status must be disputed, active, or completed" });
  }
  try {
    const result = getAdminJobs({ status: status as "disputed" | "active" | "completed" | undefined, cursor, limit });
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error("Failed to list admin jobs", { error: formatError(err) });
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.get("/audit-log", (req, res) => {
  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
  const before = typeof req.query.before === "string" ? req.query.before : undefined;
  try {
    const entries = getAdminAuditLogs({
      limit: typeof limit === "number" && Number.isFinite(limit) ? limit : undefined,
      before,
    });
    res.json({ success: true, entries, auditLog: entries, logs: entries });
  } catch (err) {
    logger.error("Failed to list admin audit log", { error: formatError(err) });
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;
