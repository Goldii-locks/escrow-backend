import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { getIndexerStatusData } from "../indexer/db.js";
import { getIndexerUptimeSeconds } from "../indexer/status.js";
import { getLatestReconciliationResults } from "../indexer/reconciliation.js";

import { z } from "zod";
import { contractIdSchema } from "../schemas/jobs.js";
import { validate } from "../middleware/validate.js";
import {
  getAllContracts,
  registerContract,
  deregisterContract,
} from "../indexer/db.js";

const router = Router();

router.use(requireAdmin);

const registerContractBodySchema = z.object({
  contractId: contractIdSchema,
  label: z.string().optional(),
  startLedger: z.number().int().nonnegative().optional(),
});

const contractParamSchema = z.object({
  contractId: contractIdSchema,
});

router.get("/contracts", (_req, res) => {
  const contracts = getAllContracts();
  res.json({
    success: true,
    contracts: contracts.map((c) => ({
      contractId: c.contract_id,
      label: c.label,
      active: Boolean(c.active),
      registered_at: c.registered_at,
      lastLedgerSequence: c.last_ledger_sequence,
      startLedger: c.start_ledger,
    })),
  });
});

router.post("/contracts", validate(registerContractBodySchema, "body"), (req, res) => {
  const { contractId, label, startLedger } = req.body as {
    contractId: string;
    label?: string;
    startLedger?: number;
  };
  registerContract(contractId, label, startLedger);
  res.status(201).json({
    success: true,
    message: "Contract registered successfully",
    contract: {
      contractId,
      label: label ?? null,
      active: true,
      startLedger: startLedger ?? 0,
    },
  });
});

router.delete("/contracts/:contractId", validate(contractParamSchema, "params"), (req, res) => {
  const { contractId } = req.params as { contractId: string };
  deregisterContract(contractId);
  res.json({
    success: true,
    message: "Contract deregistered successfully",
    contractId,
  });
});

router.get("/indexer-status", (_req, res) => {
  const status = getIndexerStatusData();
  res.json({
    success: true,
    lastIndexedLedger: status.lastIndexedLedger,
    totalEvents: status.totalEvents,
    uptimeSeconds: getIndexerUptimeSeconds(),
    lastEventAt: status.lastEventAt,
    eventsByType: status.eventsByType,
    reconciliation: getLatestReconciliationResults(),
  });
});

export default router;

