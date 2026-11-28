import { Router } from "express";
import type { Request, Response } from "express";
import { byWalletSecurityHeaders } from "../middleware/job-contract-security.js";
import { walletLookupLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import type { RequestWithValidatedQuery } from "../middleware/validate.js";
import {
  walletActivityParamsSchema,
  walletActivityQuerySchema,
  type WalletActivityQuery,
} from "../schemas/jobs.js";
import {
  getWalletActivity,
} from "../indexer/db.js";
import { sendError, sendSuccess } from "../utils/api-response.js";
import logger from "../utils/logger.js";
import { maskAddress } from "../utils/log-redaction.js";
import { formatError } from "../utils/format-error.js";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/wallets/:address/activity
// Returns activity notifications for contracts the wallet participates in.
// Query params: ?since=&limit=
// ---------------------------------------------------------------------------

router.get(
  "/:address/activity",
  byWalletSecurityHeaders,
  walletLookupLimiter,
  validate(walletActivityParamsSchema, "params", (req) =>
    logger.warn("Invalid wallet activity address", {
      address: maskAddress(typeof req.params.address === "string" ? req.params.address : undefined),
    }),
  ),
  validate(walletActivityQuerySchema, "query", (req) =>
    logger.warn("Invalid wallet activity query", { query: req.query }),
  ),
  async (req: Request, res: Response) => {
    const address = req.params.address as string;
    try {
      const { since, limit } = (req as RequestWithValidatedQuery)
        .validatedQuery as WalletActivityQuery;

      logger.info("Fetching wallet activity", { address: maskAddress(address), since, limit });
      logger.debug("Fetching wallet activity (masked address)", { address: maskAddress(address), since, limit });

      const result = await getWalletActivity(address, { since, limit });

      logger.info("Wallet activity lookup completed", {
        address: maskAddress(address),
        since,
        limit,
        count: result.activity.length,
      });
      logger.debug("Wallet activity lookup completed (masked address)", {
        address: maskAddress(address),
        since,
        limit,
        count: result.activity.length,
      });

      sendSuccess(res, result);
    } catch (err: unknown) {
      logger.error("Wallet activity lookup failed", {
        address: maskAddress(address),
        error: formatError(err),
      });
      sendError(res, 500, "Internal server error");
    }
  },
);

export default router;
