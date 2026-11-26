import { Router } from "express";
import type { Request, Response } from "express";
import {
  submitRateLimit,
  submitSecurityHeaders,
  sendError,
  sendSuccess,
  validate,
  submitBodySchema,
  logger,
  randomUUID,
  NETWORK_PASSPHRASE,
  server,
  maskAddress,
} from "./shared.js";
import { rejectedRequestLogMeta, xdrLogMeta } from "../../utils/log-redaction.js";

import {
  submitCache,
  inFlightSubmitRequests,
} from "./caches.js";
import { cachedSingleFlight } from "./dedupe.js";
import {
  classifySubmitError,
} from "./errors.js";

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/jobs/submit – submit a signed transaction
// Caches results by signedXdr to deduplicate concurrent identical submissions.
// ---------------------------------------------------------------------------

router.post(
  "/submit",
  submitSecurityHeaders,
  submitRateLimit,
  // A signed XDR is a replayable transaction: log its length and a hash
  // prefix only, never the envelope or the rest of the body (#680).
  validate(submitBodySchema, "body", (req, error) =>
    logger.warn("Invalid submit request body", {
      ...rejectedRequestLogMeta(req, error),
      ...xdrLogMeta(req.body?.signedXdr),
    }),
  ),
  async (req: Request, res: Response) => {
    const { signedXdr, sourceAddress } = req.body as { signedXdr: string; sourceAddress?: string };
    const cacheKey = signedXdr;
    // Reuse the request id (#773); a fresh one when mounted without it.
    const traceId = req.id ?? randomUUID();

    logger.info("Submit transaction request received", {
      traceId,
      ...xdrLogMeta(signedXdr),
      ...(sourceAddress && { sourceAddress: maskAddress(sourceAddress) }),
    });

    try {
      const sourceRef = { current: "rpc" as "cache" | "in-flight" | "rpc" };
      const result = await cachedSingleFlight<unknown>({
        cache: submitCache,
        inFlight: inFlightSubmitRequests,
        key: cacheKey,
        log: (s) => {
          sourceRef.current = s;
          if (s === "cache") {
            logger.info("Submit result served from cache", { traceId, source: "cache" });
          } else if (s === "in-flight") {
            logger.info("Submit result served from in-flight cache", { traceId, source: "in-flight" });
          } else if (s === "rpc") {
            logger.info("Submitting transaction to network", { traceId });
          }
        },
        produce: async () => {
          const { TransactionBuilder: TB } = await import("@stellar/stellar-sdk");
          const tx = TB.fromXDR(signedXdr, NETWORK_PASSPHRASE);
          const resTx = await server.sendTransaction(tx);
          // Only cache successful submissions. ERROR and TRY_AGAIN_LATER must
          // never be cached: the former would mask the failure as success on
          // retry, the latter would serve stale advice instead of resubmitting
          // (#614).
          const txStatus = (resTx as { status?: string })?.status;
          if (txStatus === "PENDING" || txStatus === "DUPLICATE") {
            submitCache.set(cacheKey, resTx);
          }
          return resTx;
        },
      });

      if (sourceRef.current === "cache" || sourceRef.current === "in-flight") {
        sendSuccess(res, result);
        return;
      }

      const txResult = result as Record<string, unknown>;
      const txStatus = txResult?.status as string | undefined;

      // The RPC resolves (does not throw) for rejected and overloaded
      // states — classify them instead of reporting success (#614).
      if (txStatus === "ERROR") {
        const rawDetail =
          typeof txResult?.errorResult === "string"
            ? (txResult.errorResult as string)
            : JSON.stringify(txResult?.errorResult ?? txResult);
        logger.warn("Transaction rejected by network", { traceId, detail: rawDetail });
        const { status, message } = classifySubmitError(rawDetail);
        sendError(res, status === 500 ? 422 : status, message);
        return;
      }
      if (txStatus === "TRY_AGAIN_LATER") {
        logger.warn("RPC overloaded, client should retry", { traceId });
        res.setHeader("Retry-After", "5");
        sendError(res, 503, "Network busy, retry submission");
        return;
      }

      logger.info("Transaction submitted successfully", {
        traceId,
        status: txResult?.status,
        hash: txResult?.hash,
      });

      sendSuccess(res, result);
    } catch (err: unknown) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      logger.error("Failed to submit transaction", { traceId, error: rawMessage });
      const { status, message } = classifySubmitError(rawMessage);
      sendError(res, status, message);
    }
  },
);
export default router;
