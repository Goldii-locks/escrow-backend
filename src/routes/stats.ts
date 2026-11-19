import { Router } from "express";
import type { Request, Response } from "express";
import { generalLimiter } from "../middleware/rateLimiter.js";
import { getPlatformStats } from "../indexer/db.js";
import { sendSuccess, sendError } from "../utils/api-response.js";
import logger from "../utils/logger.js";

const router = Router();

router.get("/", generalLimiter, (_req: Request, res: Response) => {
  try {
    const stats = getPlatformStats();
    res.setHeader("Cache-Control", "public, max-age=60");
    sendSuccess(res, stats);
  } catch (err) {
    logger.error("Failed to compute platform stats", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendError(res, 500, "Internal server error");
  }
});

export default router;
