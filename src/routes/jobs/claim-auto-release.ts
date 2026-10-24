import { Router } from "express";
import type { Request, Response } from "express";
import {
  Contract,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  Address,
  claimAutoReleaseRateLimit,
  claimAutoReleaseCors,
  claimAutoReleaseSecurityHeaders,
  validate,
  contractMilestoneParamsSchema,
  claimAutoReleaseBodySchema,
  logger,
  randomUUID,
  NETWORK_PASSPHRASE,
  server,
} from "./shared.js";

import {
  claimAutoReleaseCache,
  inFlightClaimAutoReleaseRequests,
  CLAIM_AUTO_RELEASE_TTL,
  UNSIGNED_TX_TIMEOUT_S,
  unsignedTxValidUntil,
  getFreshCachedXdr,
  setCachedXdr,
} from "./caches.js";

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/jobs/:contractId/milestones/:index/claim-auto-release
// ---------------------------------------------------------------------------
router.options("/:contractId/milestones/:index/claim-auto-release", claimAutoReleaseCors);

router.post(
  "/:contractId/milestones/:index/claim-auto-release",
  claimAutoReleaseCors,
  claimAutoReleaseSecurityHeaders,
  claimAutoReleaseRateLimit,
  validate(contractMilestoneParamsSchema, "params", (req) =>
    logger.warn("Invalid params for claim-auto-release", { params: req.params }),
  ),
  validate(claimAutoReleaseBodySchema, "body", (req) =>
    logger.warn("Invalid body for claim-auto-release", { body: req.body }),
  ),
  async (req: Request, res: Response) => {
    const contractId = req.params.contractId as string;
    const { index } = req.params;
    const { sourceAddress } = req.body;
    const cacheKey = `${contractId}:${index}:${sourceAddress}`;
    const traceId = randomUUID();
    const pathVars = { contractId, index, sourceAddress };

    logger.debug("Claim auto-release handler entered", {
      traceId,
      ...pathVars,
      params: req.params,
      bodyKeys: Object.keys(req.body),
    });

    logger.info("Claim auto-release request received", {
      traceId,
      ...pathVars,
    });

    try {
      logger.debug("Checking claim auto-release cache", { traceId, ...pathVars, cacheKey });
      const cached = getFreshCachedXdr(claimAutoReleaseCache, cacheKey);
      if (cached !== undefined) {
        logger.info("Claim auto-release XDR served from cache", {
          traceId,
          ...pathVars,
          source: "cache",
          xdrLength: cached.length,
        });
        const responseBody = { success: true, xdr: cached };
        logger.debug("Claim auto-release response body prepared", {
          traceId,
          ...pathVars,
          success: responseBody.success,
          xdrLength: responseBody.xdr.length,
        });
        logger.info("Claim auto-release response sent", {
          traceId,
          ...pathVars,
          status: 200,
          success: true,
          cached: true,
          xdrLength: cached.length,
        });
        res.json(responseBody);
        return;
      }

      logger.debug("Checking in-flight claim auto-release requests", { traceId, ...pathVars, cacheKey });
      const inFlight = inFlightClaimAutoReleaseRequests.get(cacheKey);
      if (inFlight) {
        const xdr = await inFlight;
        logger.info("Claim auto-release XDR served from in-flight cache", {
          traceId,
          ...pathVars,
          source: "in-flight",
          xdrLength: xdr.length,
        });
        const responseBody = { success: true, xdr };
        logger.debug("Claim auto-release response body prepared", {
          traceId,
          ...pathVars,
          success: responseBody.success,
          xdrLength: responseBody.xdr.length,
        });
        logger.info("Claim auto-release response sent", {
          traceId,
          ...pathVars,
          status: 200,
          success: true,
          cached: true,
          inFlight: true,
          xdrLength: xdr.length,
        });
        res.json(responseBody);
        return;
      }

      logger.info("Fetching claim auto-release XDR from Stellar RPC", {
        traceId,
        ...pathVars,
      });

      const requestPromise = (async (): Promise<string> => {
        logger.debug("Building Stellar transaction for claim auto-release", {
          traceId,
          ...pathVars,
          fee: BASE_FEE,
          timeout: UNSIGNED_TX_TIMEOUT_S,
        });
        const contract = new Contract(contractId);
        logger.debug("Fetching Stellar account", { traceId, ...pathVars });
        const account = await server.getAccount(sourceAddress as string);
        logger.debug("Stellar account fetched", { traceId, ...pathVars });

        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: NETWORK_PASSPHRASE,
        })
          .addOperation(
            contract.call(
              "claim_auto_release",
              Address.fromString(sourceAddress).toScVal(),
              nativeToScVal(Number(index), { type: "u32" }),
            ),
          )
          .setTimeout(UNSIGNED_TX_TIMEOUT_S)
          .build();

        logger.debug("Calling prepareTransaction on Stellar RPC", { traceId, ...pathVars });
        const prepared = await server.prepareTransaction(tx);
        const xdr = prepared.toXDR();
        logger.debug("Storing claim auto-release XDR in cache", {
          traceId,
          ...pathVars,
          cacheKey,
          xdrLength: xdr.length,
          ttlSeconds: CLAIM_AUTO_RELEASE_TTL,
        });
        setCachedXdr(
          claimAutoReleaseCache,
          cacheKey,
          xdr,
          unsignedTxValidUntil(tx),
          CLAIM_AUTO_RELEASE_TTL,
        );
        return xdr;
      })();

      inFlightClaimAutoReleaseRequests.set(cacheKey, requestPromise);
      logger.debug("In-flight promise registered", { traceId, ...pathVars, cacheKey });
      let xdr: string;
      try {
        xdr = await requestPromise;
      } catch (err: any) {
        logger.debug("RPC promise rejected, clearing cache entry", {
          traceId,
          ...pathVars,
          cacheKey,
          error: err?.message ?? String(err),
        });
        claimAutoReleaseCache.del(cacheKey);
        throw err;
      } finally {
        inFlightClaimAutoReleaseRequests.delete(cacheKey);
        logger.debug("In-flight promise unregistered", { traceId, ...pathVars, cacheKey });
      }

      logger.info("Claim auto-release XDR built successfully", {
        traceId,
        ...pathVars,
        xdrLength: xdr.length,
      });
      const responseBody = { success: true, xdr };
      logger.debug("Claim auto-release response body prepared", {
        traceId,
        ...pathVars,
        success: responseBody.success,
        xdrLength: responseBody.xdr.length,
      });
      logger.info("Claim auto-release response sent", {
        traceId,
        ...pathVars,
        status: 200,
        success: true,
        cached: false,
        xdrLength: xdr.length,
      });

      res.json(responseBody);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      const stack = err?.stack;
      logger.debug("Claim auto-release error caught", {
        traceId,
        ...pathVars,
        error: message,
        stack,
      });
      logger.error("Failed to build claim-auto-release tx", {
        traceId,
        ...pathVars,
        error: message,
        stack,
      });
      const responseBody = { success: false, error: "Internal server error" };
      logger.debug("Claim auto-release error response body prepared", {
        traceId,
        ...pathVars,
        success: responseBody.success,
        clientError: responseBody.error,
      });
      logger.info("Claim auto-release response sent", {
        traceId,
        ...pathVars,
        status: 500,
        success: false,
        error: message,
      });
      res.status(500).json(responseBody);
    }
  },
);
export default router;
