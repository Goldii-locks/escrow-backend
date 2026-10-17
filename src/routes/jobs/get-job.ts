import { Router } from "express";
import type { Request, Response } from "express";
import {
  Contract, Networks, TransactionBuilder, BASE_FEE, nativeToScVal, scValToNative, Address,
  getJobsByWallet, getEventsByContract,
  jobContractRateLimit, jobWhitelistRateLimit, whitelistUpdateRateLimit, partialReleaseRateLimit,
  buildTxRateLimit, timeRemainingRateLimit, createJobDraftRateLimit, claimAutoReleaseRateLimit,
  submitRateLimit,
  jobContractCors, jobContractSecurityHeaders, createJobDraftCors, createJobDraftSecurityHeaders,
  submitCors, submitSecurityHeaders, timeRemainingCors, timeRemainingSecurityHeaders,
  byWalletCors, byWalletSecurityHeaders, partialReleaseCors, partialReleaseSecurityHeaders,
  claimAutoReleaseCors, claimAutoReleaseSecurityHeaders, updateWhitelistCors,
  updateWhitelistSecurityHeaders, buildTxCors, buildTxSecurityHeaders,
  sendError, sendSuccess, validate, validateWithFields, createJobDraftValidation,
  contractIdParamsSchema, whitelistParamsSchema, contractMilestoneParamsSchema, buildTxBodySchema,
  submitBodySchema, partialReleaseBodySchema, claimAutoReleaseBodySchema, byWalletParamsSchema,
  byWalletQuerySchema, createJobDraftBodySchema, createJobDraftLegacyBodySchema,
  whitelistUpdateBodySchema, whitelistUpdateRequestSchema, feePreviewQuerySchema,
  strictLimiter, walletLookupLimiter, logger, isValidStellarContractId, randomUUID,
  CONTRACT_ID, NETWORK_PASSPHRASE, server, parseJobFromResult, convertScValToNativeStrings, assertRpcNetworkMatches,
} from "./shared.js";
import type {
  NextFunction, RequestWithValidatedQuery, ByWalletQuery,
  CreateJobDraftBody, CreateJobDraftLegacyBody, UpdateWhitelistBody, WhitelistUpdateBody,
  WhitelistUpdateRequestBody, FeePreviewQuery,
} from "./shared.js";
import {
  whitelistCache, resetWhitelistCache, claimAutoReleaseCache, resetClaimAutoReleaseCache,
  submitCache, resetSubmitCache, buildTxCache, resetBuildTxCache, timeRemainingCache,
  resetTimeRemainingCache, partialReleaseCache, resetPartialReleaseCache, feePreviewCache,
  resetFeePreviewCache, buildTxCacheKey, partialReleaseCacheKey,
  inFlightFeePreviewRequests,
} from "./caches.js";
import { SimError, classifySimError, classifySubmitError } from "./errors.js";

const router = Router();


// ---------------------------------------------------------------------------
// GET|POST /api/jobs/query – allowlisted read-only contract views (#696)
// ---------------------------------------------------------------------------
// The frontend calls this path; arbitrary method simulation is never allowed.
const READ_ONLY_QUERY_METHODS = new Set([
  "is_paused",
  "get_whitelisted_tokens",
  "get_platform_fee_allocation",
]);

async function handleReadOnlyQuery(req: Request, res: Response): Promise<void> {
  const contractId = req.method === "GET" ? req.query.contractId : req.body?.contractId;
  const method = req.method === "GET" ? req.query.method : req.body?.method;
  if (typeof contractId !== "string" || !contractId.trim()) {
    sendError(res, 400, "contractId is required");
    return;
  }
  if (!isValidStellarContractId(contractId)) {
    sendError(res, 400, "contractId must be a valid Stellar contract address (C...)");
    return;
  }
  if (typeof method !== "string" || !READ_ONLY_QUERY_METHODS.has(method)) {
    sendError(res, 400, "Unsupported query method");
    return;
  }

  try {
    const contract = new Contract(contractId);
    const account = await server.getAccount(process.env.DEPLOYER_ADDRESS || "");
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call(method))
      .setTimeout(30)
      .build();
    const result = await server.simulateTransaction(tx);

    if ("error" in result) {
      const { status, message } = classifySimError(String(result.error));
      sendError(res, status, message);
      return;
    }
    if (!("result" in result) || !result.result?.retval) {
      sendError(res, 500, "Internal server error");
      return;
    }

    // i128/u64 values decode to bigint, which JSON cannot carry; send strings.
    sendSuccess(res, {
      contractId,
      method,
      result: convertScValToNativeStrings(scValToNative(result.result.retval)),
    });
  } catch (err: unknown) {
    logger.error("Read-only contract query failed", {
      contractId,
      method,
      error: err instanceof Error ? err.message : String(err),
    });
    sendError(res, 500, "Internal server error");
  }
}

router.get("/query", jobContractCors, jobContractSecurityHeaders, jobContractRateLimit, handleReadOnlyQuery);
router.post("/query", jobContractCors, jobContractSecurityHeaders, jobContractRateLimit, handleReadOnlyQuery);

// GET /api/jobs/whitelisted-tokens?contractId= – alias the frontend calls (#696).
router.get("/whitelisted-tokens", (req: Request, res: Response) => {
  const contractId = req.query.contractId;
  if (typeof contractId !== "string" || !contractId.trim()) {
    sendError(res, 400, "contractId is required");
    return;
  }
  // Redirect relative to wherever this router is mounted (/api/jobs or
  // /api/v1/jobs), not to the site root.
  res.redirect(307, `${req.baseUrl}/${encodeURIComponent(contractId)}/whitelist`);
});
// ---------------------------------------------------------------------------
// GET /api/jobs/:contractId/fee-preview – simulate calculate_platform_fee_split
// ---------------------------------------------------------------------------

router.get(
  "/:contractId/fee-preview",
  jobContractCors,
  jobContractSecurityHeaders,
  jobContractRateLimit,
  validate(contractIdParamsSchema, "params", (req) =>
    logger.warn("Invalid contractId provided", { contractId: req.params.contractId }),
  ),
  validate(feePreviewQuerySchema, "query", (req) =>
    logger.warn("Invalid fee-preview query", { query: req.query }),
  ),
  async (req: Request, res: Response) => {
    const contractId = req.params.contractId as string;
    const { amount } = (req as RequestWithValidatedQuery)
      .validatedQuery as FeePreviewQuery;
    const cacheKey = `${contractId}:${amount}`;

    // Check cache
    const cached = feePreviewCache.get<Record<string, unknown>>(cacheKey);
    if (cached !== undefined) {
      logger.info("Fee preview served from cache", { contractId, amount });
      sendSuccess(res, cached);
      return;
    }

    let requestPromise = inFlightFeePreviewRequests.get(cacheKey) as
      | Promise<Record<string, unknown>>
      | undefined;
    const servedFromInFlight = Boolean(requestPromise);

    if (!requestPromise) {
      requestPromise = (async (): Promise<Record<string, unknown>> => {
        const contract = new Contract(contractId);
        const account = await server.getAccount(
          process.env.DEPLOYER_ADDRESS || "",
        );
        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: NETWORK_PASSPHRASE,
        })
          .addOperation(
            contract.call(
              "calculate_platform_fee_split",
              nativeToScVal(BigInt(amount), { type: "i128" }),
            ),
          )
          .setTimeout(30)
          .build();

        // Read-only simulation only – never submits a transaction (#719).
        const result = await server.simulateTransaction(tx);

        if ("error" in result) {
          const { status, message } = classifySimError(String(result.error));
          throw new SimError(status, message);
        }

        if ("result" in result && result.result?.retval) {
          const retval = scValToNative(result.result.retval);
          const split = convertScValToNativeStrings(retval) as Record<
            string,
            unknown
          >;
          feePreviewCache.set(cacheKey, split);
          return split;
        }

        throw new SimError(500, "Internal server error");
      })();
      inFlightFeePreviewRequests.set(cacheKey, requestPromise);
    }

    try {
      const split = await requestPromise;
      if (servedFromInFlight) {
        logger.info("Fee preview served from in-flight cache", { contractId, amount });
      }
      sendSuccess(res, split);
    } catch (err: any) {
      // Failures are never cached; the client only sees a classified status
      // and a fixed message, never the raw RPC error.
      if (err instanceof SimError) {
        sendError(res, err.status, err.message);
        return;
      }
      logger.error("Failed to compute fee preview", {
        contractId,
        amount,
        error: err?.message ?? String(err),
      });
      sendError(res, 500, "Internal server error");
    } finally {
      inFlightFeePreviewRequests.delete(cacheKey);
    }
  },
);

// GET /api/jobs/:contractId - get job state
router.get(
  "/:contractId",
  jobContractCors,
  jobContractSecurityHeaders,
  jobContractRateLimit,
  validate(contractIdParamsSchema, "params", (req) =>
    logger.warn("Invalid contractId provided", { contractId: req.params.contractId }),
  ),
  async (req: Request, res: Response) => {
    const contractId = req.params.contractId as string;

    logger.info("Fetching job", { contractId });

    // Deliberately unauthenticated, for the same reason as
    // GET /by-wallet/:address above: this reads contract state that anyone can
    // simulate against the public RPC themselves. Rate limited at nginx via
    // zone=api_public_read rather than by a key the browser would have to ship.

    try {
      const contract = new Contract(contractId);
      const account = await server.getAccount(process.env.DEPLOYER_ADDRESS || "");
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call("get_job"))
        .setTimeout(30)
        .build();

      const result = await server.simulateTransaction(tx);

      if ("error" in result) {
        const { status } = classifySimError(String(result.error));
        if (status === 404) {
          logger.warn("Job not found", { contractId });
          sendError(res, 404, "Job not found");
          return;
        }
        logger.error("Failed to fetch job", { contractId, error: String(result.error) });
        sendError(res, 500, "Internal server error");
        return;
      }

      const job = parseJobFromResult(result, contractId);
      if (!job) {
        logger.warn("Job not found", { contractId });
        sendError(res, 404, "Job not found");
        return;
      }

      logger.info("Job fetched successfully", {
        contractId,
        client: job.client,
        freelancer: job.freelancer,
        arbiter: job.arbiter,
        token: job.token,
        funded: job.funded,
        milestoneCount: job.milestones.length,
      });
      sendSuccess(res, job);
    } catch (err: any) {
      logger.error("Failed to fetch job", { contractId, error: err?.message });
      sendError(res, 500, "Internal server error");
    }
  },
);
export default router;
