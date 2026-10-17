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
  inFlightPartialReleaseRequests,
} from "./caches.js";
import { SimError, classifySimError, classifySubmitError } from "./errors.js";

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/jobs/:contractId/milestones/:index/partial-release
// ---------------------------------------------------------------------------
router.options(
  "/:contractId/milestones/:index/partial-release",
  partialReleaseCors,
);

router.post(
  "/:contractId/milestones/:index/partial-release",
  partialReleaseCors,
  partialReleaseSecurityHeaders,
  partialReleaseRateLimit,
  validateWithFields(contractMilestoneParamsSchema, "params", (req) =>
    logger.warn("Invalid params for partial-release", { params: req.params }),
  ),
  validateWithFields(partialReleaseBodySchema, "body", (req) =>
    logger.warn("Invalid body for partial-release", { body: req.body }),
  ),
  async (req: Request, res: Response) => {
    const traceId = randomUUID();
    try {
      const { contractId, index } = req.params;

      // Deliberately unauthenticated: this route only builds an unsigned XDR
      // for approve_partial that the caller's own wallet must sign. The key
      // protected nothing the signature doesn't already protect. Rate limited
      // via the route limiter rather than a key. (#693)

      const { amount, sourceAddress } = req.body;

      logger.debug("Partial-release handler entered", {
        traceId,
        contractId,
        index,
        ip: req.ip ?? req.socket?.remoteAddress,
      });

      logger.info("Processing partial-release", {
        traceId,
        contractId,
        index,
        amount,
        sourceAddress,
      });

      let account;
      try {
        account = await server.getAccount(sourceAddress as string);
      } catch (err: any) {
        const errMsg = String(err?.message || err);
        const { status, message } = classifySimError(errMsg);
        logger.error("Failed to get account for partial release", {
          traceId,
          contractId,
          index,
          sourceAddress,
          error: errMsg,
          stack: err?.stack,
        });
        sendError(res, status, message);
        return;
      }

      const cacheKey = partialReleaseCacheKey(
        contractId as string,
        index as string,
        amount,
        sourceAddress,
      );

      logger.debug("Checking partial-release cache", { traceId, contractId, index, cacheKey });
      const cachedXdr = partialReleaseCache.get<string>(cacheKey);
      if (cachedXdr !== undefined) {
        logger.info("Partial-release XDR served from cache", {
          traceId,
          contractId,
          index,
          source: "cache",
          xdrLength: cachedXdr.length,
        });
        res.json({ success: true, xdr: cachedXdr });
        return;
      }

      let requestPromise = inFlightPartialReleaseRequests.get(cacheKey);
      const servedFromInFlight = Boolean(requestPromise);

      if (!requestPromise) {
        requestPromise = (async (): Promise<string> => {
          const contract = new Contract(contractId as string);
          const amountNum = BigInt(amount);

          const tx = new TransactionBuilder(account, {
            fee: BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
          })
            .addOperation(contract.call(
              "approve_partial",
              Address.fromString(sourceAddress).toScVal(),
              nativeToScVal(Number(index), { type: "u32" }),
              nativeToScVal(amountNum, { type: "i128" })
            ))
            .setTimeout(30)
            .build();

          let prepared;
          try {
            prepared = await server.prepareTransaction(tx);
          } catch (err: any) {
            const errMsg = String(err?.message || err);
            const { status, message } = classifySimError(errMsg);
            logger.error("Failed to prepare transaction for partial release", {
              traceId,
              contractId,
              index,
              error: errMsg,
            });
            throw { status, message };
          }

          const xdr = prepared.toXDR();
          partialReleaseCache.set(cacheKey, xdr);
          return xdr;
        })();

        inFlightPartialReleaseRequests.set(cacheKey, requestPromise);
      }

      let xdr: string;
      try {
        xdr = await requestPromise;
      } catch (err: any) {
        partialReleaseCache.del(cacheKey);
        if (err && err.status) {
          sendError(res, err.status, err.message);
          return;
        }
        throw err;
      } finally {
        inFlightPartialReleaseRequests.delete(cacheKey);
      }

      if (servedFromInFlight) {
        logger.info("Partial-release XDR served from in-flight cache", { contractId, index });
      }

      res.json({ success: true, xdr });
    } catch (err: any) {
      const errMsg = String(err?.message || err);
      // Structured, server-side-only error detail – the client receives a clean
      // 500 body with no internal stack trace leakage (#117).
      logger.error("Unexpected error in partial release", {
        traceId,
        contractId: req.params.contractId,
        index: req.params.index,
        error: errMsg,
        stack: err?.stack,
      });
      sendError(res, 500, "Internal server error");
    }
  }
);
export default router;
