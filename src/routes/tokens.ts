import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { strictLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import { contractIdSchema } from "../schemas/jobs.js";
import {
  resolveTokenMetadata,
  getTokenLabel,
  TokenMetadataError,
} from "../utils/token-metadata.js";
import { sendError, sendSuccess } from "../utils/api-response.js";
import logger from "../utils/logger.js";

const tokenParamsSchema = z.object({ contractId: contractIdSchema });

const router = Router();

/**
 * GET /api/tokens/:contractId (#957).
 *
 * Exposes the already-cached SEP-41 resolver so clients can render amounts
 * without simulating `decimals()` / `symbol()` themselves. Deliberately
 * unauthenticated: token metadata is public contract state. The general API
 * limiter plus `strictLimiter` bound the RPC work done for anonymous callers.
 */
router.get(
  "/:contractId",
  strictLimiter,
  validate(tokenParamsSchema, "params"),
  async (req: Request, res: Response) => {
    const contractId = req.params.contractId as string;
    try {
      const metadata = await resolveTokenMetadata(contractId);
      res.setHeader("Cache-Control", "public, max-age=3600");
      sendSuccess(res, {
        contractId,
        symbol: metadata.symbol,
        name: metadata.name,
        decimals: metadata.decimals,
        label: getTokenLabel(metadata.symbol),
      });
    } catch (err: unknown) {
      if (err instanceof TokenMetadataError) {
        sendError(res, 404, "Token metadata not found for this contract");
        return;
      }
      logger.error("Token metadata lookup failed", {
        contractId,
        error: err instanceof Error ? err.message : String(err),
      });
      sendError(res, 500, "Internal server error");
    }
  },
);

export default router;
