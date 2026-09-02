import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import {
  Contract,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  Address,
} from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";
import NodeCache from "node-cache";
import { getJobsByWallet, getEventsByContract } from "../indexer/db.js";
import {
  jobContractRateLimit,
  jobWhitelistRateLimit,
  whitelistUpdateRateLimit,
  partialReleaseRateLimit,
  buildTxRateLimit,
  timeRemainingRateLimit,
  createJobDraftRateLimit,
  claimAutoReleaseRateLimit,
  submitRateLimit,
} from "../middleware/job-contract-rate-limit.js";
import {
  jobContractCors,
  jobContractSecurityHeaders,
  createJobDraftCors,
  createJobDraftSecurityHeaders,
  submitCors,
  submitSecurityHeaders,
  timeRemainingCors,
  timeRemainingSecurityHeaders,
  byWalletCors,
  byWalletSecurityHeaders,
  partialReleaseCors,
  partialReleaseSecurityHeaders,
  claimAutoReleaseCors,
  claimAutoReleaseSecurityHeaders,
  updateWhitelistCors,
  updateWhitelistSecurityHeaders,
  buildTxCors,
  buildTxSecurityHeaders,
} from "../middleware/job-contract-security.js";
import { sendError, sendSuccess } from "../utils/api-response.js";
import { validate, validateWithFields } from "../middleware/validate.js";
import type { RequestWithValidatedQuery } from "../middleware/validate.js";
import { createJobDraftValidation } from "../middleware/create-job-draft-validation.js";
import {
  contractIdParamsSchema,
  whitelistParamsSchema,
  contractMilestoneParamsSchema,
  // Schema for building transaction requests
  buildTxBodySchema,
  submitBodySchema,
  partialReleaseBodySchema,
  claimAutoReleaseBodySchema,
  byWalletParamsSchema,
  byWalletQuerySchema,
  createJobDraftBodySchema,
  createJobDraftLegacyBodySchema,
  whitelistUpdateBodySchema,
  whitelistUpdateRequestSchema,
  type ByWalletQuery,
  type CreateJobDraftBody,
  type CreateJobDraftLegacyBody,
  type UpdateWhitelistBody,
  type WhitelistUpdateBody,
  type WhitelistUpdateRequestBody,
} from "../schemas/jobs.js";
import { strictLimiter, walletLookupLimiter } from "../middleware/rateLimiter.js";
import logger from "../utils/logger.js";
import { randomUUID } from "crypto";

const router = Router();
const CONTRACT_ID = process.env.CONTRACT_ID || "";
const RPC_URL =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.SOROBAN_NETWORK_PASSPHRASE || Networks.TESTNET;
const server = new Server(RPC_URL);

const WHITELIST_TTL = parseInt(process.env.WHITELIST_CACHE_TTL_S || "60", 10);
export const whitelistCache = new NodeCache({ stdTTL: WHITELIST_TTL, useClones: false });
const inFlightWhitelistRequests = new Map<string, Promise<string[]>>();
export function resetWhitelistCache(): void {
  whitelistCache.flushAll();
  inFlightWhitelistRequests.clear();
}

const CLAIM_AUTO_RELEASE_TTL = parseInt(
  process.env.CLAIM_AUTO_RELEASE_CACHE_TTL_S || "60",
  10,
);
export const claimAutoReleaseCache = new NodeCache({
  stdTTL: CLAIM_AUTO_RELEASE_TTL,
  useClones: false,
});
const inFlightClaimAutoReleaseRequests = new Map<string, Promise<string>>();
export function resetClaimAutoReleaseCache(): void {
  claimAutoReleaseCache.flushAll();
  inFlightClaimAutoReleaseRequests.clear();
}

const SUBMIT_CACHE_TTL = parseInt(
  process.env.SUBMIT_CACHE_TTL_S || "30",
  10,
);
export const submitCache = new NodeCache({
  stdTTL: SUBMIT_CACHE_TTL,
  useClones: false,
});
const inFlightSubmitRequests = new Map<string, Promise<unknown>>();
export function resetSubmitCache(): void {
  submitCache.flushAll();
  inFlightSubmitRequests.clear();
}

const BUILD_TX_CACHE_TTL = parseInt(
  process.env.BUILD_TX_CACHE_TTL_S || "30",
  10,
);
export const buildTxCache = new NodeCache({
  stdTTL: BUILD_TX_CACHE_TTL,
  useClones: false,
});
const inFlightBuildTxRequests = new Map<string, Promise<string>>();
export function resetBuildTxCache(): void {
  buildTxCache.flushAll();
  inFlightBuildTxRequests.clear();
}
function buildTxCacheKey(
  contractId: string,
  method: string,
  sourceAddress: string,
  args: unknown[],
): string {
  return `${contractId}:${method}:${sourceAddress}:${JSON.stringify(args)}`;
}

const TIME_REMAINING_CACHE_TTL = parseInt(
  process.env.TIME_REMAINING_CACHE_TTL_S || "15",
  10,
);
export const timeRemainingCache = new NodeCache({
  stdTTL: TIME_REMAINING_CACHE_TTL,
  useClones: false,
});
const inFlightTimeRemainingRequests = new Map<string, Promise<number>>();
export function resetTimeRemainingCache(): void {
  timeRemainingCache.flushAll();
  inFlightTimeRemainingRequests.clear();
}

const PARTIAL_RELEASE_CACHE_TTL = parseInt(
  process.env.PARTIAL_RELEASE_CACHE_TTL_S || "30",
  10,
);
export const partialReleaseCache = new NodeCache({
  stdTTL: PARTIAL_RELEASE_CACHE_TTL,
  useClones: false,
});
const inFlightPartialReleaseRequests = new Map<string, Promise<string>>();
export function resetPartialReleaseCache(): void {
  partialReleaseCache.flushAll();
  inFlightPartialReleaseRequests.clear();
}

/**
 * Cache key for a partial-release build. The amount and source address are
 * part of the key because each combination produces a different unsigned
 * transaction — keying on the contract and milestone alone would serve one
 * caller another caller's XDR.
 */
function partialReleaseCacheKey(
  contractId: string,
  index: string | number,
  amount: unknown,
  sourceAddress: string,
): string {
  return `${contractId}:${index}:${String(amount)}:${sourceAddress}`;
}

// ---------------------------------------------------------------------------
// Simulation error helpers  (#83)
// ---------------------------------------------------------------------------

/**
 * Inspects a simulation error string and returns the appropriate HTTP status
 * code plus a client-safe message.
 *
 * Mappings:
 *  - Missing / unregistered contract → 404 (Contract not found)
 *  - Missing source account → 404 (Account not found)
 *  - Contract assertion / revert (error codes) → 422
 *  - Everything else → 500
 */
function classifySimError(rawError: string): { status: number; message: string } {
  // 404 – source account missing on the network
  if (/missing account|account not found/i.test(rawError)) {
    return { status: 404, message: "Source account not found on network" };
  }

  // 404 – contract missing / unregistered on the network
  if (
    /not found|NotFound|contract not found/i.test(rawError) ||
    /contract error #1\b/i.test(rawError)
  ) {
    return { status: 404, message: "Contract not found on network" };
  }

  // 422 – contract executed but reverted / assertion failed
  const contractErrMatch = rawError.match(/contract error #(\d+)/i);
  if (contractErrMatch) {
    return {
      status: 422,
      message: `Contract execution reverted (error code ${contractErrMatch[1]})`,
    };
  }
  if (/revert|assert|panic|trap/i.test(rawError)) {
    return { status: 422, message: "Contract execution reverted" };
  }

  // 500 – everything else (never forward the raw error to the client)
  return { status: 500, message: "Internal server error" };
}

/**
 * Carries an HTTP status + client-safe message out of an async cache/dedup
 * block so the outer catch can respond correctly without re-classifying.
 */
class SimError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Submit error helper  – maps sendTransaction / XDR errors to HTTP statuses
// ---------------------------------------------------------------------------

type Classified = { status: number; message: string };

function classifySubmitError(rawError: string): Classified {
  // 401 – authentication / signature / authorization failures
  if (
    /unauthorized|401/i.test(rawError) ||
    /BAD_AUTH|bad_auth|invalid.*signature|wrong.*network|wrong.*passphrase/i.test(rawError) ||
    /authentication.*(failed|required)|credentials/i.test(rawError)
  ) {
    return { status: 401, message: "Unauthorized: invalid signature or wrong network" };
  }

  // 404 – account / contract not found on the network at submission time
  if (
    /not found|NotFound|404/i.test(rawError) ||
    /missing account|account.*does not exist|contract not found/i.test(rawError) ||
    /no such (account|contract|data entry)/i.test(rawError) ||
    /tx_no_source_account|NO_ACCOUNT/i.test(rawError)
  ) {
    return { status: 404, message: "Account or contract not found on network" };
  }

  // 422 – well-formed transaction rejected at protocol / contract level
  const contractErrMatch = rawError.match(/contract error #(\d+)/i);
  if (contractErrMatch) {
    return {
      status: 422,
      message: `Contract execution reverted (error code ${contractErrMatch[1]})`,
    };
  }
  if (
    /revert|assert|panic|trap/i.test(rawError) ||
    /tx_failed|op_(bad_auth|underfunded|no_trust|line_full|invalid)/i.test(rawError) ||
    /INSUFFICIENT_BALANCE|BAD_SEQ|TOO_EARLY|TOO_LATE|MISSING_OPERATION/i.test(rawError) ||
    /transaction.*(failed|rejected|invalid)/i.test(rawError)
  ) {
    return { status: 422, message: "Transaction rejected by network" };
  }

  // 400 – structural / malformed XDR issues that are definitively client errors
  if (
    /malformed|bad_request|bad xdr|invalid xdr|unparseable/i.test(rawError) ||
    /tx_malformed|MALFORMED/i.test(rawError) ||
    /XDR.*pars/i.test(rawError)
  ) {
    return { status: 400, message: "Malformed transaction XDR" };
  }

  // 500 – everything else (network blips, timeouts, RPC 5xx, etc.)
  return { status: 500, message: "Internal server error" };
}

// ---------------------------------------------------------------------------
// Helper: parse job fields out of a successful simulation result
// ---------------------------------------------------------------------------
const parseJobFromResult = (result: any, contractId: string) => {
  if ("result" in result && result.result?.retval) {
    const val = result.result.retval;
    const client = val.client().toString();
    const freelancer = val.freelancer().toString();
    const arbiter = val.arbiter().toString();
    const token = val.token().toString();
    const funded = val.funded();
    const milestones = val.milestones().map((m: any, i: number) => ({
      index: i,
      amount: m.amount().toString(),
      status: Object.keys(m.status())[0],
    }));

    return { id: contractId, client, freelancer, arbiter, token, funded, milestones };
  }
  return null;
};

// ---------------------------------------------------------------------------
// GET /api/jobs/by-wallet/:address
// Returns all jobs (from local SQLite event index) where the address is
// the client, freelancer, or arbiter.
// Query params: ?page=1&limit=10
// ---------------------------------------------------------------------------
router.options("/by-wallet/:address", byWalletCors);

router.get(
  "/by-wallet/:address",
  byWalletCors,
  byWalletSecurityHeaders,
  validate(byWalletParamsSchema, "params", (req) =>
    logger.warn("Invalid by-wallet address", { address: req.params.address }),
  ),
  validate(byWalletQuerySchema, "query", (req) =>
    logger.warn("Invalid by-wallet query", { query: req.query }),
  ),
  async (req: Request, res: Response) => {
    const address = req.params.address as string;

    // Optional API-key gate (same pattern as GET /:contractId)
    const requiredApiKey = process.env.API_KEY;
    if (requiredApiKey) {
      const providedKey = req.header("x-api-key");
      if (providedKey !== requiredApiKey) {
        logger.warn("Unauthorized by-wallet request", { address });
        sendError(res, 401, "Unauthorized");
        return;
      }
    }

    try {
      const { page, limit } = (req as RequestWithValidatedQuery)
        .validatedQuery as ByWalletQuery;

      logger.info("Fetching jobs by wallet", { address, page, limit });
      const result = await getJobsByWallet(address, page, limit);
      logger.info("Jobs lookup completed", { address, page, limit, total: result.total });
      sendSuccess(res, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Jobs lookup failed", { address, error: message });
      sendError(res, 500, "Internal server error");
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/jobs/create-job-draft
// Validates and stores a job draft payload (off-chain) before on-chain create.
// ---------------------------------------------------------------------------
router.options("/create-job-draft", createJobDraftCors);

/**
 * Two PRs implemented POST /create-job-draft independently and both were
 * merged, leaving two `router.post("/create-job-draft", …)` registrations. Only
 * the first could ever run, so the second PR's rate limiter was dead code and
 * its tests failed. They are collapsed here into one route that honours both
 * contracts: the body is validated against whichever schema matches the field
 * naming used, and the response carries both shapes. The Zod request-shape
 * validation itself lives in the reusable `createJobDraftValidation`
 * middleware (see `middleware/create-job-draft-validation.ts`).
 */

router.post(
  "/create-job-draft",
  createJobDraftCors,
  createJobDraftSecurityHeaders,
  createJobDraftRateLimit,
  createJobDraftValidation,
  (req: Request, res: Response) => {
    const traceId = randomUUID();
    const pathVars = { route: "/api/jobs/create-job-draft" };

    logger.debug("Create-job-draft handler entered", {
      traceId,
      ...pathVars,
      bodyKeys: Object.keys((req.body as Record<string, unknown>) ?? {}),
      ip: req.ip ?? req.socket?.remoteAddress,
    });

    try {
      const body = req.body as Partial<CreateJobDraftBody> &
        Partial<CreateJobDraftLegacyBody>;

      const client = body.client ?? body.clientAddress;
      const freelancer = body.freelancer ?? body.freelancerAddress;
      const arbiter = body.arbiter ?? body.arbiterAddress;
      const token = body.token ?? body.tokenAddress;

      const draft = {
        id: randomUUID(),
        status: "draft" as const,
        client,
        freelancer,
        arbiter,
        token,
        autoReleaseDays: body.autoReleaseDays,
        milestones: body.milestones,
        acceptedAssets: body.acceptedAssets,
        requirements: body.requirements,
        createdAt: new Date().toISOString(),
        // `*Address` naming echoed back for the second PR's response contract.
        draft: {
          clientAddress: client,
          freelancerAddress: freelancer,
          arbiterAddress: arbiter,
          tokenAddress: token,
          milestones: body.milestones,
        },
      };

      logger.debug("Create-job-draft draft built", {
        traceId,
        ...pathVars,
        milestoneCount: body.milestones?.length ?? 0,
      });

      logger.info("Job draft created", {
        traceId,
        ...pathVars,
        client,
        freelancer,
        arbiter,
        token,
        milestoneCount: body.milestones?.length ?? 0,
      });

      sendSuccess(res, draft);

      logger.debug("Create-job-draft response sent", {
        traceId,
        ...pathVars,
        status: 200,
        success: true,
        draftId: draft.id,
        milestoneCount: body.milestones?.length ?? 0,
      });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      logger.error("Failed to create job draft", {
        traceId,
        ...pathVars,
        error: message,
        stack: err?.stack,
      });
      sendError(res, 500, "Internal server error");
    }
  },
);

// GET /api/jobs/:contractId/history - event timeline for a single job
router.get("/:contractId/history", (req: Request, res: Response) => {
  try {
    const contractId = req.params.contractId as string;
    const page = parseInt((req.query.page as string) || "1", 10);
    const limit = parseInt((req.query.limit as string) || "10", 10);

    if (!contractId || contractId.trim() === "") {
      res.status(400).json({ success: false, error: "contractId is required" });
      return;
    }
    if (isNaN(page) || page < 1) {
      res.status(400).json({ success: false, error: "page must be a positive integer" });
      return;
    }
    if (isNaN(limit) || limit < 1 || limit > 100) {
      res.status(400).json({ success: false, error: "limit must be between 1 and 100" });
      return;
    }

    const result = getEventsByContract(contractId, page, limit);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/jobs/:contractId - get job state
router.get(
  "/:contractId",
  jobContractCors,
  jobContractSecurityHeaders,
  jobContractRateLimit,
  validate(contractIdParamsSchema, "params", (req) =>
    logger.warn("Invalid contractId provided", { contractId: req.params.contractId }),
  ),
  async (req: Request, res: Response) => {
    const contractId = req.params.contractId as string;

    logger.info("Fetching job", { contractId });

    const requiredApiKey = process.env.API_KEY;
    if (requiredApiKey) {
      const providedKey = req.header("x-api-key");
      if (providedKey !== requiredApiKey) {
        logger.warn("Unauthorized request", { contractId });
        sendError(res, 401, "Unauthorized");
        return;
      }
    }

    try {
      const contract = new Contract(contractId);
      const account = await server.getAccount(process.env.DEPLOYER_ADDRESS || "");
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call("get_job"))
        .setTimeout(30)
        .build();

      const result = await server.simulateTransaction(tx);

      if ("error" in result) {
        const { status } = classifySimError(String(result.error));
        if (status === 404) {
          logger.warn("Job not found", { contractId });
          sendError(res, 404, "Job not found");
          return;
        }
        logger.error("Failed to fetch job", { contractId, error: String(result.error) });
        sendError(res, 500, "Internal server error");
        return;
      }

      const job = parseJobFromResult(result, contractId);
      if (!job) {
        logger.warn("Job not found", { contractId });
        sendError(res, 404, "Job not found");
        return;
      }

      logger.info("Job fetched successfully", {
        contractId,
        client: job.client,
        freelancer: job.freelancer,
        arbiter: job.arbiter,
        token: job.token,
        funded: job.funded,
        milestoneCount: job.milestones.length,
      });
      sendSuccess(res, job);
    } catch (err: any) {
      logger.error("Failed to fetch job", { contractId, error: err?.message });
      sendError(res, 500, "Internal server error");
    }
  },
);

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
      // Check API key authorization
      const requiredApiKey = process.env.API_KEY;
      if (requiredApiKey) {
        const providedKey = req.header("x-api-key");
        if (providedKey !== requiredApiKey) {
          logger.warn("Unauthorized request", { contractId });
          sendError(res, 401, "Unauthorized");
          return;
        }
      }

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
        const account = await server.getAccount(process.env.DEPLOYER_ADDRESS || "");
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

    const requiredApiKey = process.env.API_KEY;
    if (requiredApiKey) {
      const providedKey = req.header("x-api-key");
      if (providedKey !== requiredApiKey) {
        logger.warn("Unauthorized request for whitelist update", { contractId });
        sendError(res, 401, "Unauthorized");
        return;
      }
    }

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

    try {
      const contract = new Contract(contractId);
      const account = await server.getAccount(process.env.DEPLOYER_ADDRESS || "");
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
      logger.info("Whitelist updated successfully", { contractId, count: targetAddresses.length });
      sendSuccess(res, { contractId, addresses: targetAddresses, updated: true });
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
  validateWithFields(partialReleaseBodySchema, "body", (req) =>
    logger.warn("Invalid body for partial-release", { body: req.body }),
  ),
  async (req: Request, res: Response) => {
    const traceId = randomUUID();
    try {
      const { contractId, index } = req.params;

      const requiredApiKey = process.env.API_KEY;
      if (requiredApiKey) {
        const providedKey = req.header("x-api-key");
        if (providedKey !== requiredApiKey) {
          logger.warn("Unauthorized request", { traceId, contractId, index });
          sendError(res, 401, "Unauthorized");
          return;
        }
      }

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

      let account;
      try {
        account = await server.getAccount(sourceAddress as string);
      } catch (err: any) {
        const errMsg = String(err?.message || err);
        const { status, message } = classifySimError(errMsg);
        logger.error("Failed to get account for partial release", {
          traceId,
          contractId,
          index,
          sourceAddress,
          error: errMsg,
          stack: err?.stack,
        });
        sendError(res, status, message);
        return;
      }

      const cacheKey = partialReleaseCacheKey(
        contractId as string,
        index as string,
        amount,
        sourceAddress,
      );

      logger.debug("Checking partial-release cache", { traceId, contractId, index, cacheKey });
      const cachedXdr = partialReleaseCache.get<string>(cacheKey);
      if (cachedXdr !== undefined) {
        logger.info("Partial-release XDR served from cache", {
          traceId,
          contractId,
          index,
          source: "cache",
          xdrLength: cachedXdr.length,
        });
        res.json({ success: true, xdr: cachedXdr });
        return;
      }

      let requestPromise = inFlightPartialReleaseRequests.get(cacheKey);
      const servedFromInFlight = Boolean(requestPromise);

      if (!requestPromise) {
        requestPromise = (async (): Promise<string> => {
          const contract = new Contract(contractId as string);
          const amountNum = BigInt(amount);

          const tx = new TransactionBuilder(account, {
            fee: BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
          })
            .addOperation(contract.call(
              "approve_partial",
              Address.fromString(sourceAddress).toScVal(),
              nativeToScVal(Number(index), { type: "u32" }),
              nativeToScVal(amountNum, { type: "i128" })
            ))
            .setTimeout(30)
            .build();

          let prepared;
          try {
            prepared = await server.prepareTransaction(tx);
          } catch (err: any) {
            const errMsg = String(err?.message || err);
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
          partialReleaseCache.set(cacheKey, xdr);
          return xdr;
        })();

        inFlightPartialReleaseRequests.set(cacheKey, requestPromise);
      }

      let xdr: string;
      try {
        xdr = await requestPromise;
      } catch (err: any) {
        partialReleaseCache.del(cacheKey);
        if (err && err.status) {
          sendError(res, err.status, err.message);
          return;
        }
        throw err;
      } finally {
        inFlightPartialReleaseRequests.delete(cacheKey);
      }

      if (servedFromInFlight) {
        logger.info("Partial-release XDR served from in-flight cache", { contractId, index });
      }

      res.json({ success: true, xdr });
    } catch (err: any) {
      const errMsg = String(err?.message || err);
      // Structured, server-side-only error detail – the client receives a clean
      // 500 body with no internal stack trace leakage (#117).
      logger.error("Unexpected error in partial release", {
        traceId,
        contractId: req.params.contractId,
        index: req.params.index,
        error: errMsg,
        stack: err?.stack,
      });
      sendError(res, 500, "Internal server error");
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/jobs/:contractId/milestones/:index/time-remaining
// Validates route parameters using contractMilestoneParamsSchema.
// ---------------------------------------------------------------------------
router.get(
  "/:contractId/milestones/:index/time-remaining",
  timeRemainingCors,
  timeRemainingSecurityHeaders,
  timeRemainingRateLimit,
  validate(contractMilestoneParamsSchema, "params", (req) =>
    logger.warn("Invalid params for time-remaining", { params: req.params }),
  ),
  async (req: Request, res: Response) => {
    const contractId = req.params.contractId as string;
    const { index } = req.params;

    const requiredApiKey = process.env.API_KEY;
    if (requiredApiKey) {
      const providedKey = req.header("x-api-key");
      if (providedKey !== requiredApiKey) {
        logger.warn("Unauthorized request", { contractId, index });
        sendError(res, 401, "Unauthorized");
        return;
      }
    }

    const cacheKey = `${contractId}:${index}`;

    try {
      logger.debug("GET time-remaining request", {
        contractId,
        index,
        ip: req.ip ?? req.socket?.remoteAddress,
        requestId: (req as any).requestId,
      });

      const cached = timeRemainingCache.get<number>(cacheKey);
      if (cached !== undefined) {
        logger.info("Time remaining served from cache", { contractId, index });
        sendSuccess(res, { secondsRemaining: cached });
        return;
      }

      let requestPromise = inFlightTimeRemainingRequests.get(cacheKey);
      const servedFromInFlight = Boolean(requestPromise);

      if (!requestPromise) {
        requestPromise = (async (): Promise<number> => {
          const contract = new Contract(contractId);
          const account = await server.getAccount(process.env.DEPLOYER_ADDRESS || "");
          const tx = new TransactionBuilder(account, {
            fee: BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
          })
            .addOperation(
              contract.call(
                "time_until_auto_release",
                nativeToScVal(Number(index), { type: "u32" }),
              ),
            )
            .setTimeout(30)
            .build();

          const result = await server.simulateTransaction(tx);

          if ("error" in result) {
            const { status, message } = classifySimError(String(result.error));
            throw new SimError(status, message);
          }
          if ("result" in result && result.result?.retval) {
            const secondsRemaining = Number(result.result.retval);
            timeRemainingCache.set(cacheKey, secondsRemaining);
            return secondsRemaining;
          }
          throw new SimError(500, "Internal server error");
        })();

        inFlightTimeRemainingRequests.set(cacheKey, requestPromise);
      }

      let secondsRemaining: number;
      try {
        secondsRemaining = await requestPromise;
      } finally {
        inFlightTimeRemainingRequests.delete(cacheKey);
      }

      if (servedFromInFlight) {
        logger.info("Time remaining served from in-flight cache", { contractId, index });
      }
      sendSuccess(res, { secondsRemaining });
    } catch (err: any) {
      if (err instanceof SimError) {
        logger.warn("Simulation error for time-remaining", {
          contractId,
          index,
          status: err.status,
          requestId: (req as any).requestId,
        });
        if (err.status === 404) {
          sendError(res, 404, "Job not found");
        } else {
          sendError(res, err.status, err.message);
        }
        return;
      }
      logger.error("Failed to get time remaining", {
        error: err?.message,
        contractId: req.params.contractId,
        index: req.params.index,
        stack: err?.stack,
        requestId: (req as any).requestId,
      });
      sendError(res, 500, "Internal server error");
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/jobs/:contractId/milestones/:index/claim-auto-release
// ---------------------------------------------------------------------------
router.options("/:contractId/milestones/:index/claim-auto-release", claimAutoReleaseCors);

router.post(
  "/:contractId/milestones/:index/claim-auto-release",
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
      const cached = claimAutoReleaseCache.get<string>(cacheKey);
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
          timeout: 30,
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
          .setTimeout(30)
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
        claimAutoReleaseCache.set(cacheKey, xdr);
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
        submitCache.set(cacheKey, result);
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
