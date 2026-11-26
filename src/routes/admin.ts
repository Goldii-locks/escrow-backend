import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import { requireAdmin, type AdminRequest } from "../middleware/adminAuth.js";
import {
  getIndexerStatusData,
  getSubscriptions,
  getSubscriptionById,
  getActiveSubscriptions,
  getDisabledSubscriptions,
  getAdminJobs,
} from "../indexer/db.js";
import { getIndexerUptimeSeconds } from "../indexer/status.js";
import { getLatestReconciliationResults } from "../indexer/reconciliation.js";
import {
  DELIVERY_STATUSES,
  getDeadDeliveries,
  getSubscriptionDeliveries,
  getFailedDeliveryCount,
  replayWebhookDeliveries,
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
import { sendError, sendSuccess } from "../utils/api-response.js";
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

const backfillBodySchema = z
  .object({
    startLedger: z.number().int().positive(),
    endLedger: z.number().int().positive(),
    contractId: contractIdSchema.optional(),
  })
  .refine((d) => d.endLedger >= d.startLedger, {
    message: "endLedger must be greater than or equal to startLedger",
  });

router.post("/backfill", validate(backfillBodySchema, "body"), async (req, res) => {
  auditAction(req, res, "backfill", () => (req.body?.contractId as string) || "all", () => req.body);
  const { startLedger, endLedger, contractId } = req.body as {
    startLedger: number;
    endLedger: number;
    contractId?: string;
  };

  if (backfillStarting || backfillJob?.status === "running") {
    return sendError(res, 409, "A backfill is already running");
  }

  backfillStarting = true;
  try {
    const chainHead = await getLatestLedgerSequence();
    const validation = validateHistoricalRange(startLedger, endLedger, chainHead);
    if (!validation.valid) {
      return sendError(res, 400, validation.error ?? "Invalid ledger range");
    }

    const job: BackfillJob = {
      jobId: randomUUID(),
      status: "running",
      startLedger,
      endLedger,
      ...(contractId !== undefined ? { contractId } : {}),
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

    return sendSuccess(res, job, { status: 202 });
  } catch {
    return sendError(res, 503, "Unable to validate backfill range");
  } finally {
    backfillStarting = false;
  }
});

router.get("/backfill", (_req, res) => {
  sendSuccess(res, backfillJob ?? { status: "idle" });
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
  const contracts = getAllContracts().map((c) => ({
    contractId: c.contract_id,
    label: c.label,
    active: Boolean(c.active),
    registered_at: c.registered_at,
    lastLedgerSequence: c.last_ledger_sequence,
    startLedger: c.start_ledger,
  }));
  // Deprecated: top-level `contracts` is kept alongside `data` (#874).
  sendSuccess(res, contracts, { legacy: { contracts } });
});

router.post("/contracts", validate(registerContractBodySchema, "body"), (req, res) => {
  auditAction(req, res, "register_contract", () => req.body?.contractId, () => req.body);
  const { contractId, label, startLedger } = req.body as {
    contractId: string;
    label?: string;
    startLedger?: number;
  };
  registerContract(contractId, label, startLedger);
  const contract = {
    contractId,
    label: label ?? null,
    active: true,
    startLedger: startLedger ?? 0,
  };
  // Deprecated: top-level `message`/`contract` are kept alongside `data` (#874).
  sendSuccess(res, contract, {
    status: 201,
    legacy: { message: "Contract registered successfully", contract },
  });
});

router.delete("/contracts/:contractId", validate(contractParamSchema, "params"), (req, res) => {
  auditAction(req, res, "deregister_contract", () => req.params?.contractId, () => req.params);
  const { contractId } = req.params as { contractId: string };
  deregisterContract(contractId);
  // Deprecated: top-level `message`/`contractId` are kept alongside `data` (#874).
  sendSuccess(
    res,
    { contractId },
    { legacy: { message: "Contract deregistered successfully", contractId } },
  );
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
  const data = {
    subscriptions: getSubscriptions(),
    active: getActiveSubscriptions(),
    disabled: getDisabledSubscriptions(),
  };
  // Deprecated: the same keys are kept at the top level alongside `data` (#874).
  sendSuccess(res, data, { legacy: data });
});

/** Hide credentials that integrators put in webhook URL query strings. */
function maskUrlQuery(url: string): string {
  const i = url.indexOf("?");
  return i === -1 ? url : `${url.slice(0, i)}?***`;
}

// GET /api/admin/webhook-subscriptions/:id/deliveries - one subscription's
// delivery attempts, newest first, keyset-paginated on the delivery id (#941).
router.get("/webhook-subscriptions/:id/deliveries", (req, res) => {
  const id = Number(req.params.id);
  const subscription = Number.isInteger(id) && id > 0 ? getSubscriptionById(id) : undefined;
  if (!subscription) {
    return sendError(res, 404, "Webhook subscription not found");
  }

  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  if (status && !(DELIVERY_STATUSES as readonly string[]).includes(status)) {
    return sendError(res, 400, `status must be one of ${DELIVERY_STATUSES.join(", ")}`);
  }
  const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return sendError(res, 400, "limit must be an integer between 1 and 200");
  }
  const before = req.query.before === undefined ? undefined : Number(req.query.before);
  if (before !== undefined && (!Number.isInteger(before) || before < 1)) {
    return sendError(res, 400, "before must be a positive integer");
  }

  try {
    // Fetch one extra row to know whether another page exists.
    const rows = getSubscriptionDeliveries(id, { status, limit: limit + 1, before });
    const deliveries = rows.slice(0, limit);
    const data = {
      subscription: {
        id: subscription.id,
        contract_id: subscription.contract_id,
        webhook_url: maskUrlQuery(subscription.webhook_url),
        consecutive_failures: subscription.consecutive_failures,
        disabled_at: subscription.disabled_at,
        last_error: subscription.last_error,
      },
      deliveries,
      nextBefore: rows.length > limit ? deliveries[deliveries.length - 1].id : null,
    };
    // Deprecated: the same keys are kept at the top level alongside `data` (#874).
    sendSuccess(res, data, { legacy: data });
  } catch (err) {
    logger.error("Failed to list webhook deliveries", { error: formatError(err) });
    sendError(res, 500, "Internal server error");
  }
});

// POST /api/admin/webhook-deliveries/replay - reset dead (or matching)
// deliveries back to retryable, since otherwise the only recovery from a
// receiver outage of more than WEBHOOK_MAX_DELIVERY_ATTEMPTS/
// WEBHOOK_RETRY_MAX_AGE_DAYS is hand-editing SQLite (#857).
const replayDeliveriesBodySchema = z
  .object({
    ids: z.array(z.number().int().positive()).min(1).optional(),
    subscription_id: z.number().int().positive().optional(),
    status: z.literal("dead").optional(),
    since: z.number().int().nonnegative().optional(),
  })
  .refine(
    (body) =>
      (body.ids && body.ids.length > 0) ||
      body.subscription_id !== undefined ||
      body.status !== undefined ||
      body.since !== undefined,
    {
      message:
        "Provide either ids, or at least one filter field (subscription_id, status, since)",
    },
  );

router.post(
  "/webhook-deliveries/replay",
  validate(replayDeliveriesBodySchema, "body"),
  (req, res) => {
    const { ids, subscription_id, status, since } = req.body as {
      ids?: number[];
      subscription_id?: number;
      status?: "dead";
      since?: number;
    };
    try {
      const queued = replayWebhookDeliveries({
        ids,
        subscriptionId: subscription_id,
        status,
        since,
      });
      sendSuccess(res, { queued });
    } catch (err) {
      logger.error("Failed to replay webhook deliveries", { error: formatError(err) });
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  },
);

router.get("/metrics", (_req, res) => {
  try {
    const metrics = collectIndexerMetrics();
    // Deprecated: top-level `metrics` is kept alongside `data` (#874).
    sendSuccess(res, metrics, { legacy: { metrics } });
  } catch (err) {
    logger.error("admin metrics endpoint failed to collect metrics", {
      error: formatError(err),
    });
    sendError(res, 500, "Failed to collect indexer metrics");
  }
});


router.get("/jobs", (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
  if (status && !["disputed", "active", "completed"].includes(status)) {
    return sendError(res, 400, "status must be disputed, active, or completed");
  }
  try {
    const result = getAdminJobs({ status: status as "disputed" | "active" | "completed" | undefined, cursor, limit });
    // Deprecated: the same keys are kept at the top level alongside `data` (#874).
    sendSuccess(res, result, { legacy: { ...result } });
  } catch (err) {
    logger.error("Failed to list admin jobs", { error: formatError(err) });
    sendError(res, 500, "Internal server error");
  }
});

// POST /api/admin/undecodable-events/retry - re-decode events that were parked
// after a decoder failure, now that a fix is deployed (#933).
router.post("/undecodable-events/retry", async (_req, res) => {
  try {
    const { retryUndecodableEvents } = await import("../indexer/poller.js");
    const result = await retryUndecodableEvents();
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error("Failed to retry undecodable events", { error: formatError(err) });
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
