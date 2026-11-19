import { Router } from "express";
import type { Request, Response } from "express";
import {
  iterateEventsByContract,
  jobContractCors,
  jobContractSecurityHeaders,
  jobContractRateLimit,
  validate,
  contractIdParamsSchema,
  sendError,
  logger,
} from "./shared.js";
import { getDb } from "../../indexer/db.js";
import { escapeCsvField, formatRowToCsv } from "../../utils/csv-serializer.js";
import {
  getCachedTokenDecimals,
  resolveTokenMetadata,
  formatWithDecimals,
} from "../../utils/token-metadata.js";

const router = Router();

function resolveJobToken(contractId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT data_json FROM events
       WHERE contract_id = ? AND json_extract(data_json, '$.token') IS NOT NULL
       ORDER BY ledger_sequence ASC, id ASC
       LIMIT 1`,
    )
    .get(contractId) as { data_json: string } | undefined;
  if (!row) return null;
  try {
    const token = (JSON.parse(row.data_json) as { token?: unknown }).token;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function extractAmount(data: Record<string, unknown>): string {
  for (const key of ["amount", "total_amount", "amount_released", "value"]) {
    const v = data[key];
    if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return v.trim();
    if (typeof v === "number" && Number.isInteger(v)) return String(v);
    if (typeof v === "bigint") return v.toString();
  }
  return "";
}

function extractMilestoneIndex(data: Record<string, unknown>): string {
  for (const key of ["milestone_index", "milestoneIndex", "index"]) {
    const v = data[key];
    if (typeof v === "number" && Number.isInteger(v)) return String(v);
    if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return v.trim();
  }
  return "";
}

function extractParty(data: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = data[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

router.options("/:contractId/history.csv", jobContractCors);

router.get(
  "/:contractId/history.csv",
  jobContractCors,
  jobContractSecurityHeaders,
  jobContractRateLimit,
  validate(contractIdParamsSchema, "params", (req) =>
    logger.warn("Invalid contractId provided", { contractId: req.params.contractId }),
  ),
  async (req: Request, res: Response) => {
    const contractId = req.params.contractId as string;
    try {
      const token = resolveJobToken(contractId);
      let decimals = token ? getCachedTokenDecimals(token) : null;
      if (token && decimals == null) {
        try {
          decimals = (await resolveTokenMetadata(token)).decimals;
        } catch {
          decimals = null;
        }
      }

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${contractId}-history.csv"`,
      );

      const header = formatRowToCsv([
        "ledger",
        "timestamp_utc",
        "event_type",
        "milestone_index",
        "amount",
        "amount_display",
        "from",
        "to",
        "tx_hash",
      ]);
      res.write(`${header}\n`);

      for (const row of iterateEventsByContract(contractId)) {
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(row.data_json) as Record<string, unknown>;
        } catch {
          data = {};
        }
        const rawAmount = extractAmount(data);
        let amountDisplay = "";
        if (rawAmount !== "" && decimals != null) {
          try {
            amountDisplay = formatWithDecimals(BigInt(rawAmount), decimals, false);
          } catch {
            amountDisplay = "";
          }
        }
        const ts = row.timestamp
          ? new Date(Number(row.timestamp) * 1000).toISOString()
          : "";
        const txHash = (row as any).tx_hash ?? (row as any).txHash ?? "";
        const line = formatRowToCsv([
          row.ledger_sequence,
          ts,
          row.event_type,
          extractMilestoneIndex(data),
          rawAmount,
          amountDisplay,
          extractParty(data, ["from", "sender", "client", "caller"]),
          extractParty(data, ["to", "recipient", "freelancer", "arbiter"]),
          txHash,
        ]);
        res.write(`${line}\n`);
      }
      res.end();
    } catch (err) {
      logger.error("Failed to export job history CSV", {
        contractId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        sendError(res, 500, "Internal server error");
      } else {
        res.end();
      }
    }
  },
);

export default router;
