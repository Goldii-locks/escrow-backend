import { Router } from "express";
import type { Request, Response } from "express";
import {
  Contract,
  TransactionBuilder,
  nativeToScVal,
  Address,
  buildTxRateLimit,
  buildTxSecurityHeaders,
  sendError,
  validateWithFields,
  buildTxBodySchema,
  logger,
  randomUUID,
  NETWORK_PASSPHRASE,
  server,
} from "./shared.js";
import { rejectedRequestLogMeta } from "../../utils/log-redaction.js";
import { getInclusionFee } from "../../utils/fee-helper.js";

import {
  buildTxCache,
  buildTxCacheKey,
  inFlightBuildTxRequests,
  BUILD_TX_CACHE_TTL,
  UNSIGNED_TX_TIMEOUT_S,
  unsignedTxValidUntil,
  setCachedBuildTx,
  isFreshBuildTx,
  type BuildTxPayload,
} from "./caches.js";
import { cachedSingleFlight } from "./dedupe.js";
import { formatError } from "../../utils/format-error.js";

/** Minimal shape of a validated build-tx argument element. */
type ContractArg = { type: string; value: unknown };


/**
 * build-tx answers with the standard envelope and, additively, the prepared
 * transaction metadata (#962). The top-level `xdr` is kept, deprecated, because
 * the deployed frontend still reads it; drop it once it reads `data.xdr`.
 */
function sendBuildTxSuccess(res: Response, payload: BuildTxPayload): void {
  res.status(200).json({ success: true, data: payload, xdr: payload.xdr });
}

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/jobs/build-tx – build an unsigned transaction for the frontend
// ---------------------------------------------------------------------------
router.post(
  "/build-tx",
  buildTxSecurityHeaders,
  // buildTxRateLimit supersedes the generic strictLimiter for this route.
  buildTxRateLimit,
  // Schema validation for POST /api/jobs/build-tx payload
  validateWithFields(buildTxBodySchema, "body", (req, error) =>
    logger.warn("Invalid build-tx request body", rejectedRequestLogMeta(req, error)),
  ),
  async (req: Request, res: Response) => {
    const { contractId, method, args, sourceAddress } = req.body;
    // Reuse the request id (#773); a fresh one when mounted without it.
    const traceId = req.id ?? randomUUID();
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
        const typedArgs = (args as ContractArg[]) || [];
        const adminArg = typedArgs.find((a) => a.type === "address" && a.value);
        const tokenArg = typedArgs.find((a) => a.type === "address" && a.value && a !== adminArg);

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
      const sourceRef = { current: "rpc" as "cache" | "in-flight" | "rpc" };
      const payload = await cachedSingleFlight({
        cache: buildTxCache,
        inFlight: inFlightBuildTxRequests,
        key: cacheKey,
        isFresh: isFreshBuildTx,
        log: (s) => {
          sourceRef.current = s;
          if (s === "cache") {
            const cached = buildTxCache.get<BuildTxPayload>(cacheKey);
            logger.info("Build-tx XDR served from cache", {
              traceId,
              ...pathVars,
              source: "cache",
              xdrLength: cached?.xdr.length ?? 0,
            });
            logger.debug("Build-tx response body prepared", {
              traceId,
              ...pathVars,
              success: true,
              xdrLength: cached?.xdr.length ?? 0,
            });
            logger.info("Build-tx response sent", {
              traceId,
              ...pathVars,
              status: 200,
              success: true,
              cached: true,
              xdrLength: cached?.xdr.length ?? 0,
            });
          }
        },
        produce: async () => {
          logger.info("Fetching build-tx XDR from Stellar RPC", {
            traceId,
            ...pathVars,
          });

          const inclusionFee = await getInclusionFee(server);
          logger.debug("Building Stellar transaction for build-tx", {
            traceId,
            ...pathVars,
            method,
            fee: inclusionFee,
            timeout: UNSIGNED_TX_TIMEOUT_S,
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

          const toScVal = (a: ContractArg): ReturnType<typeof nativeToScVal> => {
            if (a.type === "address") return Address.fromString(String(a.value)).toScVal();
            if (a.type === "i128") return nativeToScVal(BigInt(String(a.value)), { type: "i128" });
            if (a.type === "u32") return nativeToScVal(a.value, { type: "u32" });
            if (a.type === "u64") return nativeToScVal(BigInt(String(a.value)), { type: "u64" });
            // A JS boolean always becomes scvBool; SDK v16 no longer types `type: "bool"`.
            if (a.type === "bool") return nativeToScVal(a.value);
            // Hex-encoded bytes, e.g. the BytesN<32> milestone spec hashes
            // and the salt `create_escrow` takes.
            if (a.type === "bytes") return nativeToScVal(Buffer.from(String(a.value), "hex"));
            if (a.type === "vec") {
              return nativeToScVal((a.value as ContractArg[]).map((item) => toScVal(item)));
            }
            // A unit enum variant is a one-symbol vec.
            if (a.type === "enum") return nativeToScVal([a.value], { type: "symbol" });
            if (a.type === "struct") {
              // #[contracttype] structs are maps keyed by field symbol, sorted.
              const fields = Object.keys(a.value as Record<string, ContractArg>).sort();
              return nativeToScVal(
                Object.fromEntries(fields.map((f) => [f, toScVal((a.value as Record<string, ContractArg>)[f])])),
                { type: Object.fromEntries(fields.map((f) => [f, ["symbol", null]])) },
              );
            }
            return nativeToScVal(a.value);
          };
          const scArgs = ((args as ContractArg[]) || []).map((a) => toScVal(a));

          const tx = new TransactionBuilder(account, {
            fee: inclusionFee,
            networkPassphrase: NETWORK_PASSPHRASE,
          })
            .addOperation(contract.call(method, ...scArgs))
            .setTimeout(UNSIGNED_TX_TIMEOUT_S)
            .build();

          logger.debug("Calling prepareTransaction on Stellar RPC for build-tx", {
            traceId,
            ...pathVars,
          });
          const prepared = await server.prepareTransaction(tx);
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
          logger.debug("Storing build-tx payload in cache", {
            traceId,
            ...pathVars,
            cacheKey,
            xdrLength: xdr.length,
            ttlSeconds: BUILD_TX_CACHE_TTL,
          });
          setCachedBuildTx(buildTxCache, cacheKey, payload, BUILD_TX_CACHE_TTL);
          return payload;
        },
      });

      if (sourceRef.current === "cache") {
        sendBuildTxSuccess(res, payload);
        return;
      }

      if (sourceRef.current === "in-flight") {
        logger.info("Build-tx XDR served from in-flight cache", {
          traceId,
          ...pathVars,
          source: "in-flight",
          xdrLength: payload.xdr.length,
        });
      }

      logger.info("Build-tx XDR built successfully", {
        traceId,
        ...pathVars,
        xdrLength: payload.xdr.length,
      });
      logger.debug("Build-tx response body prepared", {
        traceId,
        ...pathVars,
        success: true,
        xdrLength: payload.xdr.length,
      });
      logger.info("Build-tx response sent", {
        traceId,
        ...pathVars,
        status: 200,
        success: true,
        cached: false,
        xdrLength: payload.xdr.length,
      });

      sendBuildTxSuccess(res, payload);
    } catch (err: unknown) {
      const message = formatError(err);
      const stack = err instanceof Error ? err.stack : undefined;
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
