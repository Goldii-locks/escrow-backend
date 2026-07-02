import { Router } from "express";
import type { Request, Response } from "express";
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
  partialReleaseRateLimit,
} from "../middleware/job-contract-rate-limit.js";
import {
  jobContractCors,
  jobContractSecurityHeaders,
} from "../middleware/job-contract-security.js";
import { sendError, sendSuccess } from "../utils/api-response.js";
import { validate } from "../middleware/validate.js";
import {
  contractIdParamsSchema,
  whitelistParamsSchema,
  partialReleaseParamsSchema,
  partialReleaseBodySchema,
} from "../schemas/jobs.js";
import { strictLimiter } from "../middleware/rateLimiter.js";
import logger from "../utils/logger.js";

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

// ---------------------------------------------------------------------------
// Simulation error helpers  (#83)
// ---------------------------------------------------------------------------

/**
 * Inspects a simulation error string and returns the appropriate HTTP status
 * code plus a client-safe message.
 *
 * Mappings:
 *  - Missing / unregistered contract → 404
 *  - Contract assertion / revert (error codes) → 422
 *  - Everything else → 500
 */
function classifySimError(rawError: string): { status: number; message: string } {
  // 404 – contract or account not found on the network
  if (
    /not found|NotFound|contract not found/i.test(rawError) ||
    /missing account|account not found/i.test(rawError) ||
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
router.get("/by-wallet/:address", (req: Request, res: Response) => {
  try {
    const address = req.params.address as string;
    const page = parseInt((req.query.page as string) || "1", 10);
    const limit = parseInt((req.query.limit as string) || "10", 10);

    if (!address || address.trim() === "") {
      res.status(400).json({ success: false, error: "address is required" });
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

    const result = getJobsByWallet(address, page, limit);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

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
    const { contractId } = req.params;

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
  validate(whitelistParamsSchema, "params", (req) =>
    logger.warn("Invalid contractId on whitelist request", { contractId: req.params.contractId }),
  ),
  async (req: Request, res: Response) => {
    const contractId = req.params.contractId;

    try {
      const requiredApiKey = process.env.API_KEY;
      if (requiredApiKey) {
        const providedKey = req.header("x-api-key");
        if (providedKey !== requiredApiKey) {
          sendError(res, 401, "Unauthorized");
          return;
        }
      }

      const cached = whitelistCache.get<string[]>(contractId);
      if (cached !== undefined) {
        logger.info("Whitelisted tokens served from cache", { contractId, tokenCount: cached.length });
        sendSuccess(res, { tokens: cached });
        return;
      }

      const inFlight = inFlightWhitelistRequests.get(contractId);
      if (inFlight) {
        const tokens = await inFlight;
        logger.info("Whitelisted tokens served from in-flight cache", { contractId, tokenCount: tokens.length });
        sendSuccess(res, { tokens });
        return;
      }

      const requestPromise = (async (): Promise<string[]> => {
        const contract = new Contract(contractId as string);
        const account = await server.getAccount(process.env.DEPLOYER_ADDRESS || "");
        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: Networks.TESTNET,
        })
          .addOperation(contract.call("get_whitelisted_tokens"))
          .setTimeout(30)
          .build();

        const result = await server.simulateTransaction(tx);

        if ("error" in result) {
          const errorMsg = String(result.error);
          if (errorMsg.includes("contract error #2") || errorMsg.includes("NotInitialized")) {
            whitelistCache.set(contractId, []);
            logger.info("Whitelisted tokens fetched successfully", { contractId, tokenCount: 0 });
            return [];
          }
          if (
            /not found|NotFound|contract not found/i.test(errorMsg) ||
            /contract error #1\b/i.test(errorMsg)
          ) {
            throw new Error("not found");
          }
          logger.error("Failed to fetch whitelisted tokens", { contractId, error: errorMsg });
          throw new Error("InternalServerError");
        }

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

        logger.error("Failed to fetch whitelisted tokens", { contractId, error: "unexpected empty retval" });
        throw new Error("InternalServerError");
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
      const message = err?.message ?? "Internal server error";
      if (/unauthorized|401/i.test(message)) {
        logger.error("Failed to fetch whitelisted tokens", { contractId, error: message });
        sendError(res, 401, "Unauthorized");
        return;
      }
      if (/not found|404/i.test(message)) {
        logger.error("Failed to fetch whitelisted tokens", { contractId, error: message });
        sendError(res, 404, "Job not found");
        return;
      }
      logger.error("Failed to fetch whitelisted tokens", { contractId, error: message });
      sendError(res, 500, "Internal server error");
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/jobs/build-tx – build an unsigned transaction for the frontend
// ---------------------------------------------------------------------------
router.post(
  "/build-tx",
  strictLimiter,
  validate(buildTxBodySchema, "body", (req) =>
    logger.warn("Invalid build-tx request body", { body: req.body }),
  ),
  async (req: Request, res: Response) => {
    try {
      const { contractId, method, args, sourceAddress } = req.body;
      const contract = new Contract(contractId as string);
      const account = await server.getAccount(sourceAddress as string);

      // Validate for whitelist management methods
      if (method === "add_whitelisted_token" || method === "remove_whitelisted_token") {
        const adminArg = args.find((a: any) => a.type === "address" && a.value);
        const tokenArg = args.find((a: any) => a.type === "address" && a.value && a !== adminArg);

        if (!adminArg || !tokenArg) {
          return res.status(400).json({
            success: false,
            error: "Both admin (address) and token (address) arguments are required for whitelist management methods",
          });
        }
      }

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

// POST /api/jobs/:contractId/milestones/:index/partial-release
router.post(
  "/:contractId/milestones/:index/partial-release",
  partialReleaseRateLimit,
  validate(partialReleaseParamsSchema, "params"),
  validate(partialReleaseBodySchema, "body"),
  async (req: Request, res: Response) => {
    try {
      const { contractId, index } = req.params;
      const { amount, sourceAddress } = req.body;
      const contract = new Contract(contractId as string);
      const account = await server.getAccount(sourceAddress as string);
      const amountNum = BigInt(amount);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(contract.call(
          "approve_partial",
          Address.fromString(sourceAddress).toScVal(),
          nativeToScVal(parseInt(index as string), { type: "u32" }),
          nativeToScVal(amountNum, { type: "i128" })
        ))
        .setTimeout(30)
        .build();

      const prepared = await server.prepareTransaction(tx);
      res.json({ success: true, xdr: prepared.toXDR() });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/jobs/:contractId/milestones/:index/time-remaining
// ---------------------------------------------------------------------------
router.get(
  "/:contractId/milestones/:index/time-remaining",
  validate(contractMilestoneParamsSchema, "params", (req) =>
    logger.warn("Invalid params for time-remaining", { params: req.params }),
  ),
  async (req: Request, res: Response) => {
    try {
      const { contractId, index } = req.params;
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
        logger.warn("Simulation error for time-remaining", { contractId, index, status });
        sendError(res, status, message);
      } else if ("result" in result && result.result?.retval) {
        const secondsRemaining = Number(result.result.retval);
        res.json({ success: true, secondsRemaining });
      } else {
        sendError(res, 500, "Internal server error");
      }
    } catch (err: any) {
      logger.error("Failed to get time remaining", { error: err?.message });
      sendError(res, 500, "Internal server error");
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/jobs/:contractId/milestones/:index/claim-auto-release
// ---------------------------------------------------------------------------
router.post(
  "/:contractId/milestones/:index/claim-auto-release",
  validate(contractMilestoneParamsSchema, "params", (req) =>
    logger.warn("Invalid params for claim-auto-release", { params: req.params }),
  ),
  validate(claimAutoReleaseBodySchema, "body", (req) =>
    logger.warn("Invalid body for claim-auto-release", { body: req.body }),
  ),
  async (req: Request, res: Response) => {
    try {
      const { contractId, index } = req.params;
      const { sourceAddress } = req.body;
      const contract = new Contract(contractId);
      const account = await server.getAccount(sourceAddress as string);

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

      const prepared = await server.prepareTransaction(tx);
      res.json({ success: true, xdr: prepared.toXDR() });
    } catch (err: any) {
      logger.error("Failed to build claim-auto-release tx", { error: err?.message });
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/jobs/submit – submit a signed transaction
// ---------------------------------------------------------------------------
router.post(
  "/submit",
  strictLimiter,
  validate(submitBodySchema, "body", (req) =>
    logger.warn("Invalid submit request body", { body: req.body }),
  ),
  async (req: Request, res: Response) => {
    try {
      const { signedXdr } = req.body;
      const { TransactionBuilder: TB } = await import("@stellar/stellar-sdk");
      const tx = TB.fromXDR(signedXdr as string, NETWORK_PASSPHRASE);
      const result = await server.sendTransaction(tx);
      res.json({ success: true, data: result });
    } catch (err: any) {
      logger.error("Failed to submit transaction", { error: err?.message });
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  },
);

export default router;
