import { Router } from "express";
import type { Request, Response } from "express";
import {
  submitRateLimit,
  submitCors,
  submitSecurityHeaders,
  sendError,
  sendSuccess,
  validate,
  submitBodySchema,
  logger,
  randomUUID,
  NETWORK_PASSPHRASE,
  server,
} from "./shared.js";

import {
  submitCache,
  inFlightSubmitRequests,
} from "./caches.js";
import {
  classifySubmitError,
} from "./errors.js";

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/jobs/submit – submit a signed transaction
// Caches results by signedXdr to deduplicate concurrent identical submissions.
// ---------------------------------------------------------------------------
router.options("/submit", submitCors);

router.post(
  "/submit",
  submitCors,
  submitSecurityHeaders,
  submitRateLimit,
  validate(submitBodySchema, "body", (req) =>
    logger.warn("Invalid submit request body", {
      body: req.body,
      xdrLength: typeof req.body?.signedXdr === "string" ? req.body.signedXdr.length : undefined,
    }),
  ),
  async (req: Request, res: Response) => {
    const { signedXdr, sourceAddress } = req.body as { signedXdr: string; sourceAddress?: string };
    const cacheKey = signedXdr;
    const traceId = randomUUID();

    logger.info("Submit transaction request received", {
      traceId,
      xdrLength: signedXdr.length,
      ...(sourceAddress && { sourceAddress }),
    });

    try {
      const cached = submitCache.get<unknown>(cacheKey);
      if (cached !== undefined) {
        logger.info("Submit result served from cache", { traceId, source: "cache" });
        sendSuccess(res, cached);
        return;
      }

      const inFlight = inFlightSubmitRequests.get(cacheKey);
      if (inFlight) {
        logger.info("Submit result served from in-flight cache", { traceId, source: "in-flight" });
        const result = await inFlight;
        sendSuccess(res, result);
        return;
      }

      logger.info("Submitting transaction to network", { traceId });

      const requestPromise = (async (): Promise<unknown> => {
        const { TransactionBuilder: TB } = await import("@stellar/stellar-sdk");
        const tx = TB.fromXDR(signedXdr, NETWORK_PASSPHRASE);
        const result = await server.sendTransaction(tx);
        // Only cache successful submissions. ERROR and TRY_AGAIN_LATER must
        // never be cached: the former would mask the failure as success on
        // retry, the latter would serve stale advice instead of resubmitting
        // (#614).
        const txStatus = (result as { status?: string })?.status;
        if (txStatus === "PENDING" || txStatus === "DUPLICATE") {
          submitCache.set(cacheKey, result);
        }
        return result;
      })();

      inFlightSubmitRequests.set(cacheKey, requestPromise);
      let result: unknown;
      try {
        result = await requestPromise;
      } catch (err: unknown) {
        submitCache.del(cacheKey);
        throw err;
      } finally {
        inFlightSubmitRequests.delete(cacheKey);
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
