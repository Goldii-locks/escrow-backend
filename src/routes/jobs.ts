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
import { getJobsByWallet } from "../indexer/db.js";
import { jobContractRateLimit } from "../middleware/job-contract-rate-limit.js";
import {
  jobContractCors,
  jobContractSecurityHeaders,
} from "../middleware/job-contract-security.js";
import { sendError, sendSuccess } from "../utils/api-response.js";
import { isValidStellarContractId } from "../utils/stellar.js";
import { strictLimiter } from "../middleware/rateLimiter.js";

const router = Router();
const CONTRACT_ID = process.env.CONTRACT_ID || "";
const RPC_URL = "https://soroban-testnet.stellar.org";
const server = new Server(RPC_URL);

// Helper function to parse job from RPC result
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

// GET /api/jobs/by-wallet/:address
// Returns all jobs (from local SQLite event index) where the address is
// the client, freelancer, or arbiter.
// Query params: ?page=1&limit=10
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

// GET /api/jobs/:contractId/whitelist - get whitelisted tokens
router.get("/:contractId/whitelist", jobContractCors, jobContractSecurityHeaders, async (req: Request, res: Response) => {
  try {
    const { contractId } = req.params;
    if (!isValidStellarContractId(contractId as string)) {
      sendError(
        res,
        400,
        "contractId must be a valid Stellar contract address (C...)"
      );
      return;
    }
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

    // Check if simulation resulted in an error
    if ("error" in result) {
      // Check if it's the NotInitialized error (Error::NotInitialized = 2)
      // The error from simulation will have a message indicating contract error #2
      const errorMsg = result.error as string;
      if (errorMsg.includes("contract error #2") || errorMsg.includes("NotInitialized")) {
        // Return empty tokens array for uninitialized contracts
        res.json({ success: true, tokens: [] });
      } else {
        res.status(500).json({ success: false, error: errorMsg });
      }
    } else if ("result" in result && result.result?.retval) {
      // Handle Vec<Address> correctly by iterating (using type assertions)
      const tokens: string[] = [];
      const vec = result.result.retval as any;

      // Since it's a Vec from the contract, it should have a map/forEach method
      // like val.milestones() in parseJobFromResult
      if (typeof vec.forEach === "function") {
        vec.forEach((token: any) => tokens.push(token.toString()));
      }
      res.json({ success: true, tokens });
    } else {
      res.status(500).json({ success: false, error: "Failed to get whitelisted tokens" });
    }
  } catch (err: any) {
    console.error("Error in whitelist endpoint:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/jobs/build-tx - build an unsigned transaction for the frontend to sign
router.post("/build-tx", strictLimiter, async (req: Request, res: Response) => {
  try {
    const { contractId, method, args, sourceAddress } = req.body;
    const contract = new Contract(contractId as string);
    const account = await server.getAccount(sourceAddress as string);

    // Validate for whitelist management methods
    if (method === "add_whitelisted_token" || method === "remove_whitelisted_token") {
      // Check that args has admin and token
      const adminArg = args.find((a: any) => a.type === "address" && a.value);
      const tokenArg = args.find((a: any) => a.type === "address" && a.value && a !== adminArg);

      if (!adminArg || !tokenArg) {
        return res.status(400).json({
          success: false,
          error: "Both admin (address) and token (address) arguments are required for whitelist management methods"
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

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(contract.call(method, ...scArgs))
      .setTimeout(30)
      .build();

    const prepared = await server.prepareTransaction(tx);
    res.json({ success: true, xdr: prepared.toXDR() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/jobs/:contractId/milestones/:index/partial-release
router.post("/:contractId/milestones/:index/partial-release", async (req: Request, res: Response) => {
  try {
    const { contractId, index } = req.params;
    const { amount, sourceAddress } = req.body;
    const contract = new Contract(contractId as string);
    const account = await server.getAccount(sourceAddress as string);

    // Validate amount is a positive integer
    const amountNum = BigInt(amount);
    if (amountNum <= 0) {
      return res.status(400).json({ success: false, error: "Amount must be a positive integer" });
    }

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
});

// GET /api/jobs/:contractId/milestones/:index/time-remaining
router.get("/:contractId/milestones/:index/time-remaining", async (req: Request, res: Response) => {
  try {
    const { contractId, index } = req.params;
    const contract = new Contract(contractId as string);
    const account = await server.getAccount(process.env.DEPLOYER_ADDRESS || "");
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(contract.call(
        "time_until_auto_release",
        nativeToScVal(parseInt(index as string), { type: "u32" })
      ))
      .setTimeout(30)
      .build();

    const result = await server.simulateTransaction(tx);
    if ("error" in result) {
      res.status(500).json({ success: false, error: result.error as string });
    } else if ("result" in result && result.result?.retval) {
      const secondsRemaining = Number(result.result.retval);
      res.json({ success: true, secondsRemaining });
    } else {
      res.status(500).json({ success: false, error: "Failed to get time remaining" });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/jobs/:contractId/milestones/:index/claim-auto-release
router.post("/:contractId/milestones/:index/claim-auto-release", async (req: Request, res: Response) => {
  try {
    const { contractId, index } = req.params;
    const { sourceAddress } = req.body;
    const contract = new Contract(contractId as string);
    const account = await server.getAccount(sourceAddress as string);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(contract.call(
        "claim_auto_release",
        Address.fromString(sourceAddress).toScVal(),
        nativeToScVal(parseInt(index as string), { type: "u32" })
      ))
      .setTimeout(30)
      .build();

    const prepared = await server.prepareTransaction(tx);
    res.json({ success: true, xdr: prepared.toXDR() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/jobs/submit - submit a signed transaction
router.post("/submit", strictLimiter, async (req: Request, res: Response) => {
  try {
    const { signedXdr } = req.body;
    const { TransactionBuilder: TB } = await import("@stellar/stellar-sdk");
    const tx = TB.fromXDR(signedXdr as string, Networks.TESTNET);
    const result = await server.sendTransaction(tx);
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
