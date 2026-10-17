import { Router } from "express";
import type { Request, Response } from "express";
import {
  Contract, Networks, TransactionBuilder, BASE_FEE, nativeToScVal, scValToNative, Address,
  getJobsByWallet, getEventsByContract,
  jobContractRateLimit, jobWhitelistRateLimit, whitelistUpdateRateLimit, partialReleaseRateLimit,
  buildTxRateLimit, timeRemainingRateLimit, createJobDraftRateLimit, claimAutoReleaseRateLimit,
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
  inFlightBuildTxRequests,
  BUILD_TX_CACHE_TTL,
} from "./caches.js";
import { SimError, classifySimError, classifySubmitError } from "./errors.js";
const router = Router();

// ---------------------------------------------------------------------------
// POST /api/jobs/build-tx – build an unsigned transaction for the frontend
// ---------------------------------------------------------------------------
router.post(
  "/build-tx",
  buildTxCors,
  buildTxSecurityHeaders,
  // buildTxRateLimit supersedes the generic strictLimiter for this route.
  buildTxRateLimit,
  // Schema validation for POST /api/jobs/build-tx payload
  validateWithFields(buildTxBodySchema, "body", (req) =>
    logger.warn("Invalid build-tx request body", { body: req.body }),
  ),
  async (req: Request, res: Response) => {
    const { contractId, method, args, sourceAddress } = req.body;
    const traceId = randomUUID();
    const pathVars = { contractId, method, sourceAddress };

    logger.debug("Build-tx handler entered", {
      traceId,
      ...pathVars,
      params: req.params,
      bodyKeys: Object.keys(req.body ?? {}),
      argCount: (args || []).length,
    });

    logger.info("Build-tx request received", {
      traceId,
      ...pathVars,
    });

    try {
      // Validate for whitelist management methods
      if (method === "add_whitelisted_token" || method === "remove_whitelisted_token") {
        const adminArg = args.find((a: any) => a.type === "address" && a.value);
        const tokenArg = args.find((a: any) => a.type === "address" && a.value && a !== adminArg);

        if (!adminArg || !tokenArg) {
          logger.warn("Missing admin/token args for whitelist management", {
            traceId,
            ...pathVars,
          });
          logger.debug("Build-tx error response body prepared", {
            traceId,
            ...pathVars,
            success: false,
            clientError:
              "Both admin (address) and token (address) arguments are required for whitelist management methods",
          });
          logger.info("Build-tx response sent", {
            traceId,
            ...pathVars,
            status: 400,
            success: false,
            error: "whitelist management args validation",
          });
          sendError(
            res,
            400,
            "Both admin (address) and token (address) arguments are required for whitelist management methods",
          );
          return;
        }
      }

      const cacheKey = buildTxCacheKey(contractId, method, sourceAddress, args || []);

      logger.debug("Checking build-tx cache", { traceId, ...pathVars, cacheKey });
      const cached = buildTxCache.get<string>(cacheKey);
      if (cached !== undefined) {
        logger.info("Build-tx XDR served from cache", {
          traceId,
          ...pathVars,
          source: "cache",
          xdrLength: cached.length,
        });
        logger.debug("Build-tx response body prepared", {
          traceId,
          ...pathVars,
          success: true,
          xdrLength: cached.length,
        });
        logger.info("Build-tx response sent", {
          traceId,
          ...pathVars,
          status: 200,
          success: true,
          cached: true,
          xdrLength: cached.length,
        });
        res.json({ success: true, xdr: cached });
        return;
      }

      let requestPromise = inFlightBuildTxRequests.get(cacheKey);
      const servedFromInFlight = Boolean(requestPromise);

      logger.debug("Checking in-flight build-tx requests", {
        traceId,
        ...pathVars,
        cacheKey,
      });

      if (!requestPromise) {
        requestPromise = (async (): Promise<string> => {
          logger.info("Fetching build-tx XDR from Stellar RPC", {
            traceId,
            ...pathVars,
          });

          logger.debug("Building Stellar transaction for build-tx", {
            traceId,
            ...pathVars,
            method,
            fee: BASE_FEE,
            timeout: 30,
          });
          const contract = new Contract(contractId as string);
          logger.debug("Fetching Stellar account for build-tx", {
            traceId,
            ...pathVars,
          });
          const account = await server.getAccount(sourceAddress as string);
          logger.debug("Stellar account fetched for build-tx", {
            traceId,
            ...pathVars,
          });

          const scArgs = (args || []).map((a: any) => {
            if (a.type === "address") return Address.fromString(a.value).toScVal();
            if (a.type === "i128") return nativeToScVal(BigInt(a.value), { type: "i128" });
            if (a.type === "u32") return nativeToScVal(a.value, { type: "u32" });
            if (a.type === "u64") return nativeToScVal(BigInt(a.value), { type: "u64" });
            if (a.type === "bool") return nativeToScVal(a.value, { type: "bool" });
            if (a.type === "vec") {
              const vecElements = a.value.map((item: any) => {
                if (item.type === "i128") return nativeToScVal(BigInt(item.value), { type: "i128" });
                if (item.type === "u32") return nativeToScVal(item.value, { type: "u32" });
                if (item.type === "u64") return nativeToScVal(BigInt(item.value), { type: "u64" });
                return nativeToScVal(item.value);
              });
              return nativeToScVal(vecElements);
            }
            return nativeToScVal(a.value);
          });

          const tx = new TransactionBuilder(account, {
            fee: BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
          })
            .addOperation(contract.call(method, ...scArgs))
            .setTimeout(30)
            .build();

          logger.debug("Calling prepareTransaction on Stellar RPC for build-tx", {
            traceId,
            ...pathVars,
          });
          const prepared = await server.prepareTransaction(tx);
          const xdr = prepared.toXDR();
          logger.debug("Storing build-tx XDR in cache", {
            traceId,
            ...pathVars,
            cacheKey,
            xdrLength: xdr.length,
            ttlSeconds: BUILD_TX_CACHE_TTL,
          });
          buildTxCache.set(cacheKey, xdr);
          return xdr;
        })();

        inFlightBuildTxRequests.set(cacheKey, requestPromise);
        logger.debug("In-flight build-tx promise registered", {
          traceId,
          ...pathVars,
          cacheKey,
        });
      }

      let xdr: string;
      try {
        xdr = await requestPromise;
      } catch (err: any) {
        logger.debug("RPC promise rejected for build-tx, clearing cache entry", {
          traceId,
          ...pathVars,
          cacheKey,
          error: err?.message ?? String(err),
        });
        buildTxCache.del(cacheKey);
        throw err;
      } finally {
        inFlightBuildTxRequests.delete(cacheKey);
        logger.debug("In-flight build-tx promise unregistered", {
          traceId,
          ...pathVars,
          cacheKey,
        });
      }

      if (servedFromInFlight) {
        logger.info("Build-tx XDR served from in-flight cache", {
          traceId,
          ...pathVars,
          source: "in-flight",
          xdrLength: xdr.length,
        });
      }

      logger.info("Build-tx XDR built successfully", {
        traceId,
        ...pathVars,
        xdrLength: xdr.length,
      });
      logger.debug("Build-tx response body prepared", {
        traceId,
        ...pathVars,
        success: true,
        xdrLength: xdr.length,
      });
      logger.info("Build-tx response sent", {
        traceId,
        ...pathVars,
        status: 200,
        success: true,
        cached: false,
        xdrLength: xdr.length,
      });

      res.json({ success: true, xdr });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      const stack = err?.stack;
      logger.debug("Build-tx error caught", {
        traceId,
        ...pathVars,
        error: message,
        stack,
      });
      logger.error("Failed to build build-tx transaction", {
        traceId,
        ...pathVars,
        error: message,
        stack,
      });
      logger.debug("Build-tx error response body prepared", {
        traceId,
        ...pathVars,
        success: false,
        clientError: "Internal server error",
      });
      logger.info("Build-tx response sent", {
        traceId,
        ...pathVars,
        status: 500,
        success: false,
        error: message,
      });
      sendError(res, 500, "Internal server error");
    }
  },
);
export default router;
