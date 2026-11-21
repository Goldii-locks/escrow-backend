import { Router } from "express";
import type { Request, Response } from "express";
import {
  Contract,
  TransactionBuilder,
  nativeToScVal,
  Address,
  partialReleaseRateLimit,
  partialReleaseCors,
  partialReleaseSecurityHeaders,
  sendError,
  validateWithFields,
  contractMilestoneParamsSchema,
  partialReleaseBodySchema,
  logger,
  randomUUID,
  NETWORK_PASSPHRASE,
  server,
  sendSuccess,
} from "./shared.js";
import { rejectedRequestLogMeta } from "../../utils/log-redaction.js";
import { getInclusionFee } from "../../utils/fee-helper.js";

import {
  partialReleaseCache,
  partialReleaseCacheKey,
  inFlightPartialReleaseRequests,
  UNSIGNED_TX_TIMEOUT_S,
  unsignedTxValidUntil,
  setCachedBuildTx,
  isFreshBuildTx,
  PARTIAL_RELEASE_CACHE_TTL,
  type BuildTxPayload,
} from "./caches.js";
import { cachedSingleFlight } from "./dedupe.js";
import {
  classifySimError,
} from "./errors.js";
import { formatError } from "../../utils/format-error.js";

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
  validateWithFields(partialReleaseBodySchema, "body", (req, error) =>
    logger.warn("Invalid body for partial-release", rejectedRequestLogMeta(req, error)),
  ),
  async (req: Request, res: Response) => {
    // Reuse the request id (#773); a fresh one when mounted without it.
    const traceId = req.id ?? randomUUID();
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

      const cacheKey = partialReleaseCacheKey(
        contractId as string,
        index as string,
        amount,
        sourceAddress,
      );

      logger.debug("Checking partial-release cache", { traceId, contractId, index, cacheKey });
      let wasInFlight = false;
      const payload = await cachedSingleFlight({
        cache: partialReleaseCache,
        inFlight: inFlightPartialReleaseRequests,
        key: cacheKey,
        isFresh: isFreshBuildTx,
        log: (source) => {
          if (source === "cache") {
            const cached = partialReleaseCache.get<BuildTxPayload>(cacheKey);
            logger.info("Partial-release XDR served from cache", {
              traceId,
              contractId,
              index,
              source: "cache",
              xdrLength: cached?.xdr.length ?? 0,
            });
          } else if (source === "in-flight") {
            wasInFlight = true;
          }
        },
        produce: async () => {
          let account;
          try {
            account = await server.getAccount(sourceAddress as string);
          } catch (err: unknown) {
            const errMsg = formatError(err);
            const { status, message } = classifySimError(errMsg);
            logger.error("Failed to get account for partial release", {
              traceId,
              contractId,
              index,
              sourceAddress,
              error: errMsg,
              stack: err instanceof Error ? err.stack : undefined,
            });
            throw { status, message };
          }

          const contract = new Contract(contractId as string);
          const amountNum = BigInt(amount);
          const inclusionFee = await getInclusionFee(server);

          const tx = new TransactionBuilder(account, {
            fee: inclusionFee,
            networkPassphrase: NETWORK_PASSPHRASE,
          })
            .addOperation(contract.call(
              "approve_partial",
              Address.fromString(sourceAddress).toScVal(),
              nativeToScVal(Number(index), { type: "u32" }),
              nativeToScVal(amountNum, { type: "i128" })
            ))
            .setTimeout(UNSIGNED_TX_TIMEOUT_S)
            .build();

          let prepared;
          try {
            prepared = await server.prepareTransaction(tx);
          } catch (err: unknown) {
            const errMsg = formatError(err);
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
          const totalFee = String(prepared.fee);
          const resourceFee = String(
            BigInt(totalFee) >= BigInt(inclusionFee)
              ? BigInt(totalFee) - BigInt(inclusionFee)
              : 0n,
          );
          const payload: BuildTxPayload = {
            xdr,
            hash: Buffer.from(prepared.hash()).toString("hex"),
            validUntil: unsignedTxValidUntil(tx),
            fee: { total: totalFee, inclusion: String(inclusionFee), resource: resourceFee },
          };
          setCachedBuildTx(partialReleaseCache, cacheKey, payload, PARTIAL_RELEASE_CACHE_TTL);
          return payload;
        },
      });

      if (wasInFlight) {
        logger.info("Partial-release XDR served from in-flight cache", { contractId, index });
      }

      sendSuccess(res, payload);
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        "status" in err &&
        "message" in err
      ) {
        const { status, message } = err as { status: number; message: string };
        sendError(res, status, message);
        return;
      }
      const errMsg = formatError(err);
      // Structured, server-side-only error detail – the client receives a clean
      // 500 body with no internal stack trace leakage (#117).
      logger.error("Unexpected error in partial release", {
        traceId,
        contractId: req.params.contractId,
        index: req.params.index,
        error: errMsg,
        stack: err instanceof Error ? err.stack : undefined,
      });
      sendError(res, 500, "Internal server error");
    }
  }
);
export default router;
