import { Router } from "express";
import type { Request, Response } from "express";
import {
  getJobsByWallet,
  byWalletCors,
  byWalletSecurityHeaders,
  sendError,
  sendSuccess,
  validate,
  byWalletParamsSchema,
  byWalletQuerySchema,
  logger,
} from "./shared.js";
import type {
  RequestWithValidatedQuery,
  ByWalletQuery,
} from "./shared.js";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/jobs/by-wallet/:address
// Returns all jobs (from local SQLite event index) where the address is
// the client, freelancer, or arbiter.
// Query params: ?page=1&limit=10
// ---------------------------------------------------------------------------

router.options("/by-wallet/:address", byWalletCors);

router.get(
  "/by-wallet/:address",
  byWalletCors,
  byWalletSecurityHeaders,
  validate(byWalletParamsSchema, "params", (req) =>
    logger.warn("Invalid by-wallet address", { address: req.params.address }),
  ),
  validate(byWalletQuerySchema, "query", (req) =>
    logger.warn("Invalid by-wallet query", { query: req.query }),
  ),
  async (req: Request, res: Response) => {
    const address = req.params.address as string;

    // Deliberately unauthenticated. Every field this returns (contract_id,
    // role, milestone_count, latest_event_type, latest_ledger,
    // latest_timestamp) is derived from Soroban contract events that the
    // indexer reads from public RPC, so an API key here protected nothing
    // that is not already on the ledger. It only stopped the browser, which
    // cannot hold a secret, from reading its own job list.
    //
    // It is still a reverse index (address -> contracts) that the chain does
    // not offer directly, so nginx rate limits this path separately. See
    // escrow-frontend/nginx.conf, zone=api_public_read.

    try {
      const { page, limit } = (req as RequestWithValidatedQuery)
        .validatedQuery as ByWalletQuery;

      logger.info("Fetching jobs by wallet", { address, page, limit });
      const result = await getJobsByWallet(address, page, limit);
      logger.info("Jobs lookup completed", { address, page, limit, total: result.total });
      sendSuccess(res, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Jobs lookup failed", { address, error: message });
      sendError(res, 500, "Internal server error");
    }
  },
);
export default router;
