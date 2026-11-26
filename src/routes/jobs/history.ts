import { Router } from "express";
import type { Request, Response } from "express";
import {
  getEventsByContract,
  sendError,
  sendSuccess,
  logger,
  jobContractSecurityHeaders,
  jobContractRateLimit,
  validate,
  contractIdParamsSchema,
  historyQuerySchema,
} from "./shared.js";
import type { RequestWithValidatedQuery } from "./shared.js";
import type { EventDbRow } from "../../indexer/db.js";
import type { HistoryQuery } from "../../schemas/jobs.js";
import { formatError } from "../../utils/format-error.js";

const router = Router();

/** Public event shape returned by the history endpoint (#931). */
export interface HistoryEvent {
  eventId: string | null;
  eventType: string;
  ledger: number;
  timestamp: number | null;
  txHash: string | null;
  data: unknown;
}

/** Map a raw DB row to the parsed, snake_case-free API event (#931). */
export function toHistoryEvent(row: EventDbRow): HistoryEvent {
  let data: unknown = null;
  try {
    data = JSON.parse(row.data_json) as unknown;
  } catch {
    data = null;
  }
  return {
    eventId: row.event_id ?? null,
    eventType: row.event_type,
    ledger: row.ledger_sequence,
    timestamp: row.timestamp,
    txHash: row.txHash ?? row.tx_hash ?? null,
    data,
  };
}

function isVersionedPath(originalUrl: string): boolean {
  return /^\/api\/v1(?:[/?]|$)/.test(originalUrl);
}

// GET /api/jobs/:contractId/history - event timeline for a single job


router.get(
  "/:contractId/history",
  jobContractSecurityHeaders,
  jobContractRateLimit,
  validate(contractIdParamsSchema, "params", (req) =>
    logger.warn("Invalid contractId provided", { contractId: req.params.contractId }),
  ),
  validate(historyQuerySchema, "query", (req) =>
    logger.warn("Invalid history query", { query: req.query }),
  ),
  (req: Request, res: Response) => {
    try {
      const contractId = req.params.contractId as string;
      const { page, limit, order, before, after, includeTotal } = (req as RequestWithValidatedQuery)
        .validatedQuery as HistoryQuery;

      const result = getEventsByContract(contractId, page, limit, {
        order: order ?? (isVersionedPath(req.originalUrl) ? "desc" : "asc"),
        before,
        after,
        includeTotal,
      });

      const body: Record<string, unknown> = {
        events: result.events.map(toHistoryEvent),
        page: result.page,
        limit: result.limit,
        nextCursor: result.nextCursor,
      };
      if (includeTotal) body.total = result.total;
      sendSuccess(res, body);
    } catch (err: unknown) {
      // Log the detail server-side only; never forward raw DB errors (#672).
      logger.error("Failed to fetch job history", {
        contractId: req.params.contractId,
        error: formatError(err),
      });
      sendError(res, 500, "Internal server error");
    }
  },
);
export default router;
