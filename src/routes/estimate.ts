import { Router } from "express";
import type { Request, Response } from "express";
import { interestYieldRateLimit } from "../middleware/interest-yield-rate-limit.js";
import { estimateInterestYield } from "../utils/interest_yield_estimator.js";
import { sendSuccess, sendError } from "../utils/api-response.js";
import logger from "../utils/logger.js";

const router = Router();

/**
 * POST /api/estimate/interest-yield
 *
 * Estimates interest yield as principal * rate, where rate is an integer
 * scaled factor (e.g. fixed-point APR). Both operands are validated for
 * overflow / digit limits by `estimateInterestYield` before the product is
 * computed, so a value that would risk unsafe numeric overflow is rejected
 * with a 400 rather than silently miscalculated.
 *
 * The route is guarded by a dedicated path rate limiter (see
 * `middleware/interest-yield-rate-limit.ts`) so callers that exceed the
 * configured threshold receive a 429 instead of consuming CPU on a loop.
 */
router.post(
  "/interest-yield",
  interestYieldRateLimit,
  (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { principal, rate } = body;

    if (principal === undefined || principal === null || rate === undefined || rate === null) {
      sendError(res, 400, "principal and rate are required");
      return;
    }

    if (
      !(typeof principal === "string" || typeof principal === "number") ||
      !(typeof rate === "string" || typeof rate === "number")
    ) {
      sendError(res, 400, "principal and rate must be numeric values");
      return;
    }

    const result = estimateInterestYield(principal, rate);

    if (!result.ok) {
      logger.warn("Interest yield estimate rejected", {
        code: result.code,
        error: result.error,
      });
      sendError(res, 400, result.error);
      return;
    }

    sendSuccess(res, { yield: result.value.toString() });
  },
);

export default router;
