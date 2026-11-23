import { Router } from "express";
import type { Request, Response } from "express";
import {
  jobContractRateLimit,
  jobContractSecurityHeaders,
  sendError,
  sendSuccess,
  logger,
  server,
} from "./shared.js";
import { classifySimError } from "./errors.js";
import { txStatusCache } from "./caches.js";

const router = Router();

const TX_HASH_RE = /^[0-9a-fA-F]{64}$/;

export interface TxStatusPayload {
  status: "NOT_FOUND" | "SUCCESS" | "FAILED";
  ledger: number | null;
  createdAt: number | null;
  resultCode: string | null;
  /** Client-safe failure reason; present only for FAILED. */
  error?: string;
}

/**
 * First contract error code (`{ type: "sceContract", contractCode }`) found
 * anywhere in a failed transaction's decoded diagnostic events.
 */
function contractErrorCode(value: unknown, depth = 0): number | undefined {
  if (!value || typeof value !== "object" || depth > 12) return undefined;
  const node = value as Record<string, unknown>;
  if (node.type === "sceContract" && typeof node.contractCode === "number") {
    return node.contractCode;
  }
  for (const child of Object.values(node)) {
    const code = contractErrorCode(child, depth + 1);
    if (code !== undefined) return code;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// GET /api/jobs/tx/:hash – status of a submitted transaction (#865)
// Terminal states (SUCCESS / FAILED) are cached briefly; NOT_FOUND never is,
// so clients polling a pending transaction always see fresh state.
// ---------------------------------------------------------------------------

router.get(
  "/tx/:hash",
  jobContractSecurityHeaders,
  jobContractRateLimit,
  async (req: Request, res: Response) => {
    const hash = String(req.params.hash);
    if (!TX_HASH_RE.test(hash)) {
      sendError(res, 400, "Invalid transaction hash: expected 64 hex characters");
      return;
    }
    const key = hash.toLowerCase();

    const cached = txStatusCache.get<TxStatusPayload>(key);
    if (cached !== undefined) {
      sendSuccess(res, cached);
      return;
    }

    try {
      const tx = await server.getTransaction(key);
      const status = String(tx.status) as TxStatusPayload["status"];

      if (status === "NOT_FOUND") {
        sendSuccess(res, { status, ledger: null, createdAt: null, resultCode: null });
        return;
      }

      const found = tx as unknown as {
        ledger?: number;
        createdAt?: number;
        resultXdr?: { result?: { type?: string } };
        diagnosticEventsXdr?: unknown[];
      };
      const resultCode = found.resultXdr?.result?.type ?? null;

      const payload: TxStatusPayload = {
        status,
        ledger: found.ledger ?? null,
        createdAt: found.createdAt ?? null,
        resultCode,
      };
      if (status === "FAILED") {
        const code = contractErrorCode(found.diagnosticEventsXdr);
        payload.error =
          code !== undefined
            ? classifySimError(`contract error #${code}`).message
            : "Transaction failed on-chain";
      }

      txStatusCache.set(key, payload);
      sendSuccess(res, payload);
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      logger.error("Transaction status lookup failed", { hash: key, error: raw });
      const { status, message } = classifySimError(raw);
      sendError(res, status === 404 ? 500 : status, status === 404 ? "Internal server error" : message);
    }
  },
);
export default router;
