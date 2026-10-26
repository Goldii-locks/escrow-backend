import { Router } from "express";
import type { Request, Response } from "express";
import {
  getEventsByContract,
  sendError,
  sendSuccess,
  logger,
  jobContractCors,
  jobContractSecurityHeaders,
  jobContractRateLimit,
  validate,
  contractIdParamsSchema,
  historyQuerySchema,
} from "./shared.js";
import type { RequestWithValidatedQuery, ByWalletQuery } from "./shared.js";
import { formatError } from "../../utils/format-error.js";

const router = Router();

// GET /api/jobs/:contractId/history - event timeline for a single job

router.options("/:contractId/history", jobContractCors);

router.get(
  "/:contractId/history",
  jobContractCors,
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
      const { page, limit } = (req as RequestWithValidatedQuery)
        .validatedQuery as ByWalletQuery;

      const result = getEventsByContract(contractId, page, limit);
      sendSuccess(res, result);
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
