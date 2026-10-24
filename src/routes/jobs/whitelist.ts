import { Router } from "express";
import type { Request, Response } from "express";
import {
  Contract, TransactionBuilder, BASE_FEE, Address, jobWhitelistRateLimit,
  whitelistUpdateRateLimit, jobContractCors, jobContractSecurityHeaders, sendError,
  sendSuccess, validate, contractIdParamsSchema, whitelistParamsSchema,
  whitelistUpdateRequestSchema, logger, NETWORK_PASSPHRASE, server,
  simulationSource
} from "./shared.js";
import type {
  NextFunction, UpdateWhitelistBody, WhitelistUpdateBody, WhitelistUpdateRequestBody,
} from "./shared.js";
import { whitelistCache ,
  inFlightWhitelistRequests,
} from "./caches.js";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/jobs/:contractId/whitelist – get whitelisted tokens
// ---------------------------------------------------------------------------
router.get(
  "/:contractId/whitelist",
  jobContractCors,
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

      // Fetch whitelisted tokens from contract
      const requestPromise = (async (): Promise<string[]> => {
        const contract = new Contract(contractId as string);
        const account = simulationSource();
        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: NETWORK_PASSPHRASE,
        })
          .addOperation(contract.call("get_whitelisted_tokens"))
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
          // Contract not found on network
          if (
            /not found|NotFound|contract not found/i.test(errorMsg) ||
            /contract error #1\b/i.test(errorMsg)
          ) {
            throw new Error("not found");
          }
          // Unexpected simulation error: log the detail server-side, then
          // propagate it so the outer handler can classify and log it too.
          logger.error("Failed to fetch whitelisted tokens: simulation error", { contractId, error: errorMsg });
          throw new Error(errorMsg);
        }

        // Parse successful result
        if ("result" in result && result.result?.retval) {
          const tokens: string[] = [];
          const vec = result.result.retval as any;
          if (typeof vec.forEach === "function") {
            vec.forEach((token: any) => tokens.push(token.toString()));
          }
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
    } catch (err: any) {
      // Robust error handling with no stack trace leakage. Errors keep their
      // original message so they can be classified here rather than collapsed
      // into a single generic failure.
      const message = err?.message ?? "Internal server error";

      // 401: authentication rejected by the RPC layer
      if (/unauthorized|invalid authentication/i.test(message)) {
        logger.warn("Unauthorized request", { contractId });
        sendError(res, 401, "Unauthorized");
        return;
      }

      // 404: the contract itself is missing. A missing *account* is a
      // server-side misconfiguration (the deployer account we simulate from),
      // so it falls through to the 500 branch instead.
      if (/not found/i.test(message) && !/account not found/i.test(message)) {
        logger.warn("Job not found", { contractId });
        sendError(res, 404, "Job not found");
        return;
      }

      // 500: everything else — full detail server-side, generic body to client
      logger.error("Failed to fetch whitelisted tokens", {
        contractId,
        error: message,
      });
      sendError(res, 500, "Internal server error");
    }
  },
);
// ---------------------------------------------------------------------------
// POST /api/jobs/:contractId/whitelist/update – update whitelisted tokens
// ---------------------------------------------------------------------------
router.post(
  "/:contractId/whitelist/update",
  jobContractCors,
  jobContractSecurityHeaders,
  whitelistUpdateRateLimit,
  validate(contractIdParamsSchema, "params", (req) =>
    logger.warn("Invalid contractId provided for whitelist update", { contractId: req.params.contractId }),
  ),
  validate(whitelistUpdateRequestSchema, "body", (req) =>
    logger.warn("Invalid body provided for whitelist update", { body: req.body }),
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
        const method =
          action === "remove"
            ? "remove_whitelisted_token"
            : "add_whitelisted_token";

        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: NETWORK_PASSPHRASE,
        })
          .addOperation(
            contract.call(
              method,
              new Address(adminAddress).toScVal(),
              new Address(token).toScVal(),
            ),
          )
          .setTimeout(30)
          .build();

        const prepared = await server.prepareTransaction(tx);
        const xdr = prepared.toXDR();

        whitelistCache.del(contractId);
        logger.info("Whitelist update transaction built", { contractId, token, action });
        sendSuccess(res, { xdr });
        return;
      } catch (err: any) {
        const message = err?.message ?? String(err);
        if (/unauthorized|invalid authentication/i.test(message)) {
          logger.warn("Unauthorized request for whitelist update", { contractId });
          sendError(res, 401, "Unauthorized");
          return;
        }
        if (/not found/i.test(message) && !/account not found/i.test(message)) {
          logger.warn("Job not found for whitelist update", { contractId });
          sendError(res, 404, "Job not found");
          return;
        }
        logger.error("Failed to update whitelist", { contractId, error: message });
        sendError(res, 500, "Internal server error");
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
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call("get_whitelisted_tokens"))
        .setTimeout(30)
        .build();

      const result = await server.simulateTransaction(tx);

      if ("error" in result) {
        const errorMsg = String(result.error);
        if (
          !errorMsg.includes("contract error #2") &&
          !errorMsg.includes("NotInitialized")
        ) {
          if (
            /not found|NotFound|contract not found/i.test(errorMsg) ||
            /contract error #1\b/i.test(errorMsg)
          ) {
            logger.warn("Job not found for whitelist update", { contractId });
            sendError(res, 404, "Job not found");
            return;
          }
          logger.error("Failed to verify contract for whitelist update", { contractId, error: errorMsg });
          sendError(res, 500, "Internal server error");
          return;
        }
      }

      whitelistCache.del(contractId);
      logger.warn("Bulk whitelist update rejected", { contractId, count: targetAddresses.length });
      sendError(
        res,
        400,
        "Bulk whitelist update is not supported: submit one { token, action, adminAddress } request per address to receive a signable transaction",
      );
    } catch (err: any) {
      const message = err?.message ?? String(err);
      if (/unauthorized|invalid authentication/i.test(message)) {
        logger.warn("Unauthorized request for whitelist update", { contractId });
        sendError(res, 401, "Unauthorized");
        return;
      }
      if (/not found/i.test(message) && !/account not found/i.test(message)) {
        logger.warn("Job not found for whitelist update", { contractId });
        sendError(res, 404, "Job not found");
        return;
      }
      logger.error("Failed to update whitelist", { contractId, error: message });
      sendError(res, 500, "Internal server error");
    }
  },
);
export default router;
