import { Router } from "express";
import type { Request, Response } from "express";
import {
  Contract,
  TransactionBuilder,
  Address,
  jobWhitelistRateLimit,
  whitelistUpdateRateLimit,
  jobContractSecurityHeaders,
  sendError,
  sendSuccess,
  validate,
  contractIdParamsSchema,
  whitelistParamsSchema,
  whitelistUpdateRequestSchema,
  logger,
  NETWORK_PASSPHRASE,
  server,
  simulationSource,
  scValToNative,
} from "./shared.js";
import { classifySimError } from "./errors.js";
import { rejectedRequestLogMeta } from "../../utils/log-redaction.js";
import { getInclusionFee } from "../../utils/fee-helper.js";
import type {
  NextFunction, UpdateWhitelistBody, WhitelistUpdateBody, WhitelistUpdateRequestBody,
} from "./shared.js";
import { whitelistCache ,
  inFlightWhitelistRequests,
  UNSIGNED_TX_TIMEOUT_S,
} from "./caches.js";
import { formatError } from "../../utils/format-error.js";

/** True when `contractId` is the configured escrow factory. */
function isFactory(contractId: string): boolean {
  return contractId === process.env.FACTORY_CONTRACT_ID;
}

/**
 * Returns the correct read method for fetching the token list from a contract.
 * The factory exposes `get_allowed_tokens`; escrow contracts use `get_whitelisted_tokens`.
 */
function tokenReadMethod(contractId: string): string {
  return isFactory(contractId) ? "get_allowed_tokens" : "get_whitelisted_tokens";
}

/**
 * Returns the correct write methods for adding/removing a token from a contract's
 * allowlist. The factory uses `allow_token`/`deny_token`; escrow contracts use
 * `add_whitelisted_token`/`remove_whitelisted_token`.
 */
function tokenWriteMethods(contractId: string): { add: string; remove: string } {
  return isFactory(contractId)
    ? { add: "allow_token", remove: "deny_token" }
    : { add: "add_whitelisted_token", remove: "remove_whitelisted_token" };
}

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/jobs/:contractId/whitelist – get whitelisted tokens
// ---------------------------------------------------------------------------
router.get(
  "/:contractId/whitelist",
  jobContractSecurityHeaders,
  jobWhitelistRateLimit,
  (req: Request, _res: Response, next: NextFunction) => {
    logger.info("Fetching whitelisted tokens", { contractId: req.params.contractId });
    next();
  },
  validate(whitelistParamsSchema, "params", (req) =>
    logger.warn("Invalid contractId provided", { contractId: req.params.contractId }),
  ),
  async (req: Request, res: Response) => {
    const contractId = req.params.contractId as string;

    try {
      // Deliberately unauthenticated, for the same reason as GET /by-wallet
      // and GET /:contractId: reads on-chain state that anyone can simulate
      // against the public RPC themselves. The whitelist is a public list of
      // accepted token addresses; the browser cannot hold a secret. Rate
      // limited via the route limiter rather than a key. (#693)

      // Check cache
      const cached = whitelistCache.get<string[]>(contractId);
      if (cached !== undefined) {
        logger.info("Whitelisted tokens served from cache", { contractId, tokenCount: cached.length });
        sendSuccess(res, { tokens: cached });
        return;
      }

      // Check in-flight requests
      const inFlight = inFlightWhitelistRequests.get(contractId);
      if (inFlight) {
        const tokens = await inFlight;
        logger.info("Whitelisted tokens served from in-flight cache", { contractId, tokenCount: tokens.length });
        sendSuccess(res, { tokens });
        return;
      }

      // Fetch whitelisted tokens from contract. The escrow factory keeps its
      // list under get_allowed_tokens: those are the tokens new escrows may use.
      const requestPromise = (async (): Promise<string[]> => {
        const contract = new Contract(contractId as string);
        const account = simulationSource();
        const tx = new TransactionBuilder(account, {
          fee: await getInclusionFee(server),
          networkPassphrase: NETWORK_PASSPHRASE,
        })
          .addOperation(contract.call(tokenReadMethod(contractId)))
          .setTimeout(30)
          .build();

        const result = await server.simulateTransaction(tx);

        // Handle simulation error
        if ("error" in result) {
          const errorMsg = String(result.error);
          // Contract not initialized: return empty token list
          if (errorMsg.includes("contract error #2") || errorMsg.includes("NotInitialized")) {
            whitelistCache.set(contractId, []);
            logger.info("Whitelisted tokens fetched successfully", { contractId, tokenCount: 0 });
            return [];
          }
          // Classify and propagate all other errors via classifySimError (#908)
          logger.error("Failed to fetch whitelisted tokens: simulation error", { contractId, error: errorMsg });
          const { status } = classifySimError(errorMsg);
          throw Object.assign(new Error(errorMsg), { httpStatus: status });
        }

        // Parse successful result
        if ("result" in result && result.result?.retval) {
          // retval is an xdr.ScVal (scvVec of Address); decode it (#598).
          const decoded = scValToNative(result.result.retval);
          if (!Array.isArray(decoded) || !decoded.every((t) => typeof t === "string")) {
            logger.error("Failed to fetch whitelisted tokens: unexpected retval structure", { contractId });
            throw new Error("unexpected retval shape");
          }
          const tokens: string[] = decoded;
          whitelistCache.set(contractId, tokens);
          logger.info("Whitelisted tokens fetched successfully", { contractId, tokenCount: tokens.length });
          return tokens;
        }

        // Unexpected result structure
        logger.error("Failed to fetch whitelisted tokens: unexpected retval structure", { contractId });
        throw new Error("unexpected empty retval");
      })();

      inFlightWhitelistRequests.set(contractId, requestPromise);
      let tokens: string[];
      try {
        tokens = await requestPromise;
      } finally {
        inFlightWhitelistRequests.delete(contractId);
      }

      sendSuccess(res, { tokens });
    } catch (err: unknown) {
      // Robust error handling with no stack trace leakage. Use classifySimError
      // so the mapping stays consistent with every other route (#908).
      const message = formatError(err);

      // Errors that already carry an HTTP status (set inside the promise above)
      const httpStatus = (err as { httpStatus?: number }).httpStatus;
      if (httpStatus !== undefined) {
        if (httpStatus === 404) {
          logger.warn("Job not found", { contractId });
          sendError(res, 404, "Job not found");
          return;
        }
        logger.error("Failed to fetch whitelisted tokens", { contractId, error: message });
        sendError(res, httpStatus, "Internal server error");
        return;
      }

      // 401: classifySimError does not cover auth errors; handle them first.
      if (/unauthorized|invalid authentication/i.test(message)) {
        logger.warn("Unauthorized request", { contractId });
        sendError(res, 401, "Unauthorized");
        return;
      }

      const { status } = classifySimError(message);
      if (status === 404) {
        logger.warn("Job not found", { contractId });
        sendError(res, 404, "Job not found");
        return;
      }

      // Log the original error message for server-side visibility, but send
      // only the generic classified message to the client.
      logger.error("Failed to fetch whitelisted tokens", {
        contractId,
        error: message,
      });
      sendError(res, status, "Internal server error");
    }
  },
);
// ---------------------------------------------------------------------------
// POST /api/jobs/:contractId/whitelist/update – update whitelisted tokens
// ---------------------------------------------------------------------------
router.post(
  "/:contractId/whitelist/update",
  jobContractSecurityHeaders,
  whitelistUpdateRateLimit,
  validate(contractIdParamsSchema, "params", (req) =>
    logger.warn("Invalid contractId provided for whitelist update", { contractId: req.params.contractId }),
  ),
  validate(whitelistUpdateRequestSchema, "body", (req, error) =>
    logger.warn("Invalid body provided for whitelist update", rejectedRequestLogMeta(req, error)),
  ),
  async (req: Request, res: Response) => {
    const contractId = req.params.contractId as string;
    const body = req.body as WhitelistUpdateRequestBody;
    const { addresses, tokens } = body as UpdateWhitelistBody;
    const { token, action, adminAddress } = body as WhitelistUpdateBody;
    // Bulk form supplies addresses/tokens; the single-token form supplies one.
    const isSingleTokenForm = token !== undefined;
    const targetAddresses = addresses ?? tokens ?? (token ? [token] : []);

    logger.info("Updating whitelist", { contractId, count: targetAddresses.length });

    // Deliberately unauthenticated: this route only builds an unsigned XDR
    // that the caller's own wallet must sign. The key protected nothing the
    // signature doesn't already protect. Rate limited via the route limiter
    // rather than a key. (#693)

    // The single-token form (`{ token, action, adminAddress }`) builds and
    // returns an unsigned transaction for the caller to sign, rather than
    // verifying the contract and echoing the address list back like the bulk
    // form below does.
    if (isSingleTokenForm) {
      logger.info("Processing whitelist update", { contractId, token, action });

      try {
        const contract = new Contract(contractId);
        const account = await server.getAccount(
          adminAddress || process.env.DEPLOYER_ADDRESS || "",
        );
        const methods = tokenWriteMethods(contractId);
        const method =
          action === "remove"
            ? methods.remove
            : methods.add;

        const tx = new TransactionBuilder(account, {
          fee: await getInclusionFee(server),
          networkPassphrase: NETWORK_PASSPHRASE,
        })
          .addOperation(
            contract.call(
              method,
              new Address(adminAddress).toScVal(),
              new Address(token).toScVal(),
            ),
          )
          .setTimeout(UNSIGNED_TX_TIMEOUT_S)
          .build();

        const prepared = await server.prepareTransaction(tx);
        const xdr = prepared.toXDR();

        logger.info("Whitelist update transaction built", { contractId, token, action });
        sendSuccess(res, { xdr });
        return;
      } catch (err: unknown) {
        const message = formatError(err);
        const { status, message: classified } = classifySimError(message);
        if (status === 401) {
          logger.warn("Unauthorized request for whitelist update", { contractId });
          sendError(res, 401, "Unauthorized");
          return;
        }
        if (status === 404) {
          logger.warn("Job not found for whitelist update", { contractId });
          sendError(res, 404, "Job not found");
          return;
        }
        logger.error("Failed to update whitelist", { contractId, error: message });
        sendError(res, status, classified);
        return;
      }
    }

    // Bulk form ({ addresses | tokens }) is not executed on-chain: Soroban
    // allows only one host function call per transaction, so there is no
    // single signed transaction that applies a whole list. Reject it and
    // point the caller at the single-token form instead of replying
    // `updated: true` for work that was never done (#613).
    try {
      const contract = new Contract(contractId);
      const account = simulationSource();
      const tx = new TransactionBuilder(account, {
        fee: await getInclusionFee(server),
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        // Use the per-contract read method so the factory (allow_token / deny_token)
        // is probed correctly and doesn't get a 500 from a missing method (#907).
        .addOperation(contract.call(tokenReadMethod(contractId)))
        .setTimeout(30)
        .build();

      const result = await server.simulateTransaction(tx);

      if ("error" in result) {
        const errorMsg = String(result.error);
        // Uninitialized contract is not an error for the bulk-rejection path:
        // the contract exists; we just can't do a bulk update. Fall through.
        if (
          !errorMsg.includes("contract error #2") &&
          !errorMsg.includes("NotInitialized")
        ) {
          // Classify via classifySimError rather than ad-hoc regexes (#908).
          const { status, message: classified } = classifySimError(errorMsg);
          if (status === 404) {
            logger.warn("Job not found for whitelist update", { contractId });
            sendError(res, 404, "Job not found");
            return;
          }
          logger.error("Failed to verify contract for whitelist update", { contractId, error: errorMsg });
          sendError(res, status, classified);
          return;
        }
      }

      logger.warn("Bulk whitelist update rejected", { contractId, count: targetAddresses.length });
      sendError(
        res,
        400,
        "Bulk whitelist update is not supported: submit one { token, action, adminAddress } request per address to receive a signable transaction",
      );
    } catch (err: unknown) {
      const message = formatError(err);
      const { status, message: classified } = classifySimError(message);
      if (status === 401) {
        logger.warn("Unauthorized request for whitelist update", { contractId });
        sendError(res, 401, "Unauthorized");
        return;
      }
      if (status === 404) {
        logger.warn("Job not found for whitelist update", { contractId });
        sendError(res, 404, "Job not found");
        return;
      }
      logger.error("Failed to update whitelist", { contractId, error: message });
      sendError(res, status, classified);
    }
  },
);
export default router;
