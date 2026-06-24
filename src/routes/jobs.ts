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
import { cacheService } from "../services/cacheService.js";
import { getJobsByWallet } from "../indexer/db.js";
import { jobContractRateLimit } from "../middleware/job-contract-rate-limit.js";
import {
  jobContractCors,
  jobContractSecurityHeaders,
} from "../middleware/job-contract-security.js";
import { sendError, sendSuccess } from "../utils/api-response.js";
import { isValidStellarContractId } from "../utils/stellar.js";

const router = Router();
const server = new Server(process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org");

// Helper function to handle Stellar contract result parsing
function parseJobFromResult(result: any, contractId: string) {
  return result;
}

// 1. GET /api/jobs/by-wallet/:address - Paginated & Cached Jobs
router.get('/api/jobs/by-wallet/:address', async (req: Request, res: Response) => {
  const startTime = Date.now();
  const { address } = req.params;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 10;

  if (!address) {
    return res.status(400).json({ success: false, error: 'Wallet address is required' });
  }

  const cacheKey = `jobs:${address}`;
  let cachedJobs = cacheService.get<any[]>(cacheKey);

  try {
    if (!cachedJobs) {
      const allFetchedJobs = [
        { contractId: "C123456789", client: address, freelancer: "G_FREE...", arbiter: "G_ARB...", funded: true, milestones: 3 },
        { contractId: "C987654321", client: "G_CLI...", freelancer: address, arbiter: "G_ARB...", funded: true, milestones: 2 },
        { contractId: "C112233445", client: "G_CLI...", freelancer: "G_FREE...", arbiter: address, funded: false, milestones: 1 }
      ];

      cachedJobs = allFetchedJobs.map(job => {
        let role = 'unknown';
        if (job.client === address) role = 'client';
        else if (job.freelancer === address) role = 'freelancer';
        else if (job.arbiter === address) role = 'arbiter';

        return {
          contractId: job.contractId,
          role,
          funded: job.funded,
          milestones: job.milestones
        };
      });

      cacheService.set(cacheKey, cachedJobs, 30000);
    }

    const result = getJobsByWallet(address, page, limit);
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
  async (req: Request, res: Response) => {
  const { contractId } = req.params;

  if (!isValidStellarContractId(contractId as string)) {
    sendError(
      res,
      400,
      "contractId must be a valid Stellar contract address (C...)"
    );
    return;
  }

  const requiredApiKey = process.env.API_KEY;
  if (requiredApiKey) {
    const providedKey = req.header("x-api-key");
    if (providedKey !== requiredApiKey) {
      sendError(res, 401, "Unauthorized");
      return;
    }
  }

  try {
    const contract = new Contract(contractId as string);
    const account = await server.getAccount(process.env.DEPLOYER_ADDRESS || "");
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(contract.call("get_job"))
      .setTimeout(30)
      .build();

    const result = await server.simulateTransaction(tx);

    if ("error" in result) {
      const errorMsg = String(result.error);
      if (
        /not found|NotFound|contract not found/i.test(errorMsg) ||
        /contract error #1\b/i.test(errorMsg)
      ) {
        sendError(res, 404, "Job not found");
        return;
      }
      sendError(res, 500, errorMsg);
      return;
    }

    const job = parseJobFromResult(result, contractId as string);
    if (!job) {
      sendError(res, 404, "Job not found");
      return;
    }

    sendSuccess(res, job);
  } catch (err: any) {
    const message = err?.message ?? "Internal server error";
    if (/unauthorized|authentication|401/i.test(message)) {
      sendError(res, 401, "Unauthorized");
      return;
    }
    if (/not found|404/i.test(message)) {
      sendError(res, 404, "Job not found");
      return;
    }
    sendError(res, 500, message);
  }
  }
);

// 2. GET /api/jobs/:contractId - Get job state from Stellar Smart Contract
router.get(
  "/:contractId",
  jobContractCors,
  jobContractSecurityHeaders,
  jobContractRateLimit,
  async (req: Request, res: Response) => {
    const { contractId } = req.params;

    if (!isValidStellarContractId(contractId as string)) {
      sendError(
        res,
        400,
        "contractId must be a valid Stellar contract address (C...)"
      );
      return;
    }

    const requiredApiKey = process.env.API_KEY;
    if (requiredApiKey) {
      const providedKey = req.header("x-api-key");
      if (providedKey !== requiredApiKey) {
        sendError(res, 401, "Unauthorized");
        return;
      }
    }

    try {
      const contract = new Contract(contractId as string);
      const account = await server.getAccount(process.env.DEPLOYER_ADDRESS || "");
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(contract.call("get_job"))
        .setTimeout(30)
        .build();

      const result = await server.simulateTransaction(tx);

      if ("error" in result) {
        const errorMsg = String(result.error);
        if (
          /not found|NotFound|contract not found/i.test(errorMsg) ||
          /contract error #1\b/i.test(errorMsg)
        ) {
          sendError(res, 404, "Job not found");
          return;
        }
        sendError(res, 500, errorMsg);
        return;
      }

      const job = parseJobFromResult(result, contractId as string);
      if (!job) {
        sendError(res, 404, "Job not found");
        return;
      }

      sendSuccess(res, job);
    } catch (err: any) {
      const message = err?.message ?? "Internal server error";
      if (/unauthorized|authentication|401/i.test(message)) {
        sendError(res, 401, "Unauthorized");
        return;
      }
      if (/not found|404/i.test(message)) {
        sendError(res, 404, "Job not found");
        return;
      }
      sendError(res, 500, message);
    }
  }
);

export default router;