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
} from "./shared.js";
import { rejectedRequestLogMeta, xdrLogMeta } from "../../utils/log-redaction.js";
import { createHash } from "crypto";
import { TransactionBuilder } from "@stellar/stellar-sdk";

import {
  submitCache,
  inFlightSubmitRequests,
} from "./caches.js";
import {
  classifySubmitError,
} from "./errors.js";
import { safeCacheSet } from "../../utils/safe-cache.js";

const router = Router();

/**
 * Cache/dedupe key for a signed submission: the Stellar transaction hash
 * (sha256 of the network-bound signature payload) rather than the 1–2 kB XDR
 * string. Two encodings of the same transaction — e.g. re-signed with a
 * different signer order — share a hash and therefore dedupe, and the key
 * stays a fixed 64 characters. Malformed XDR falls back to a sha256 of the
 * input so the key is still bounded; the request is rejected downstream.
 */
export function submitCacheKey(signedXdr: string): string {
  try {
    const hash = TransactionBuilder.fromXDR(
      signedXdr,
      NETWORK_PASSPHRASE,
    ).hash();
    return Buffer.from(hash as Uint8Array).toString("hex");
  } catch {
    return createHash("sha256").update(signedXdr).digest("hex");
  }
}

// ---------------------------------------------------------------------------
// POST /api/jobs/submit – submit a signed transaction
// Caches results by transaction hash to deduplicate concurrent identical
// submissions without retaining the full signed XDR in memory.
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
    const cacheKey = submitCacheKey(signedXdr);
    // Reuse the request id (#773); a fresh one when mounted without it.
    const traceId = req.id ?? randomUUID();

    logger.info("Submit transaction request received", {
      traceId,
      ...xdrLogMeta(signedXdr),
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
          safeCacheSet(submitCache, cacheKey, result);
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
