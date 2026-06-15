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

const router = Router();
const CONTRACT_ID = process.env.CONTRACT_ID || "";
const RPC_URL = "https://soroban-testnet.stellar.org";
const server = new Server(RPC_URL);

// GET /api/jobs/:contractId - get job state
router.get("/:contractId", async (req: Request, res: Response) => {
  try {
    const { contractId } = req.params;
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
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/jobs/build-tx - build an unsigned transaction for the frontend to sign
router.post("/build-tx", async (req: Request, res: Response) => {
  try {
    const { contractId, method, args, sourceAddress } = req.body;
    const contract = new Contract(contractId as string);
    const account = await server.getAccount(sourceAddress as string);

    const scArgs = (args || []).map((a: any) => {
      if (a.type === "address") return Address.fromString(a.value).toScVal();
      if (a.type === "i128") return nativeToScVal(BigInt(a.value), { type: "i128" });
      if (a.type === "u32") return nativeToScVal(a.value, { type: "u32" });
      if (a.type === "bool") return nativeToScVal(a.value, { type: "bool" });
      if (a.type === "vec") {
        const vecElements = a.value.map((item: any) => {
          if (item.type === "i128") return nativeToScVal(BigInt(item.value), { type: "i128" });
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

// POST /api/jobs/submit - submit a signed transaction
router.post("/submit", async (req: Request, res: Response) => {
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
