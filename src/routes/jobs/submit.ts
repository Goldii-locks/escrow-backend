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
import { rejectedRequestLogMeta, xdrLogMeta } from "../../utils/log-redaction.js";

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
      ...(sourceAddress && { sourceAddress }),
    });

    await submitAndRespond(res, {
      cacheKey,
      traceId,
      buildTx: async () => {
        const { TransactionBuilder: TB } = await import("@stellar/stellar-sdk");
        return TB.fromXDR(signedXdr, NETWORK_PASSPHRASE);
      },
    });
  },
);

/** How a `submitAndRespond` call ended. */
export type SubmitOutcome =
  /** A new submission the network accepted (PENDING or DUPLICATE). */
  | "submitted"
  /** Answered from the result cache or an identical in-flight submission. */
  | "deduplicated"
  /** Rejected, overloaded or failed; an error response was sent. */
  | "failed";

/**
 * The submission path shared by POST /submit and POST /sponsor (#966): result
 * caching, in-flight deduplication, sendTransaction and the classification of
 * rejected or overloaded RPC answers. Always sends the response.
 */
export async function submitAndRespond(
  res: Response,
  options: {
    cacheKey: string;
    traceId: string;
    buildTx: () => Promise<Parameters<typeof server.sendTransaction>[0]>;
  },
): Promise<SubmitOutcome> {
  const { cacheKey, traceId, buildTx } = options;
  try {
    const cached = submitCache.get<unknown>(cacheKey);
    if (cached !== undefined) {
      logger.info("Submit result served from cache", { traceId, source: "cache" });
      sendSuccess(res, cached);
      return "deduplicated";
    }

    const inFlight = inFlightSubmitRequests.get(cacheKey);
    if (inFlight) {
      logger.info("Submit result served from in-flight cache", { traceId, source: "in-flight" });
      const result = await inFlight;
      sendSuccess(res, result);
      return "deduplicated";
    }

    logger.info("Submitting transaction to network", { traceId });

    const requestPromise = (async (): Promise<unknown> => {
      const tx = await buildTx();
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
      return "failed";
    }
    if (txStatus === "TRY_AGAIN_LATER") {
      logger.warn("RPC overloaded, client should retry", { traceId });
      res.setHeader("Retry-After", "5");
      sendError(res, 503, "Network busy, retry submission");
      return "failed";
    }

    logger.info("Transaction submitted successfully", {
      traceId,
      status: txResult?.status,
      hash: txResult?.hash,
    });

    sendSuccess(res, result);
    return "submitted";
  } catch (err: unknown) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    logger.error("Failed to submit transaction", { traceId, error: rawMessage });
    const { status, message } = classifySubmitError(rawMessage);
    sendError(res, status, message);
    return "failed";
  }
}

export default router;
