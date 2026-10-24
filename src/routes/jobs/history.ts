import { Router } from "express";
import type { Request, Response } from "express";
import {
  getEventsByContract,
  sendError,
  logger,
} from "./shared.js";

const router = Router();

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
    // Log the detail server-side only; never forward raw DB errors (#672).
    logger.error("Failed to fetch job history", {
      contractId: req.params.contractId,
      error: err?.message,
    });
    sendError(res, 500, "Internal server error");
  }
});
export default router;
