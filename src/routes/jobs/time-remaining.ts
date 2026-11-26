import { Router } from "express";
import type { Request, Response } from "express";
import {
  nativeToScVal,
  timeRemainingRateLimit,
  timeRemainingSecurityHeaders,
  sendError,
  sendSuccess,
  validate,
  contractMilestoneParamsSchema,
  logger,
  server,
  scValToNative,
  buildSimulationTx,
} from "./shared.js";

import {
  timeRemainingCache,
  inFlightTimeRemainingRequests,
} from "./caches.js";
import { cachedSingleFlight } from "./dedupe.js";
import {
  SimError,
  classifySimError,
} from "./errors.js";
import { formatError } from "../../utils/format-error.js";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/jobs/:contractId/milestones/:index/time-remaining
// Validates route parameters using contractMilestoneParamsSchema.
// ---------------------------------------------------------------------------
router.get(
  [
    "/:contractId/milestones/:index/time-remaining",
    "/:contractId/milestones/:index/auto-release",
  ],
  timeRemainingSecurityHeaders,
  timeRemainingRateLimit,
  validate(contractMilestoneParamsSchema, "params", (req) =>
    logger.warn("Invalid params for time-remaining", { params: req.params }),
  ),
  async (req: Request, res: Response) => {
    const contractId = req.params.contractId as string;
    const { index } = req.params;

    // Deliberately unauthenticated: reads on-chain state (time_until_auto_release)
    // that anyone can simulate against the public RPC themselves. Rate limited
    // via the route limiter rather than a key. (#693)

    const cacheKey = `${contractId}:${index}`;

    try {
      logger.debug("GET time-remaining request", {
        contractId,
        index,
        ip: req.ip ?? req.socket?.remoteAddress,
      });

      const secondsRemaining = await cachedSingleFlight<number>({
        cache: timeRemainingCache,
        inFlight: inFlightTimeRemainingRequests,
        key: cacheKey,
        log: (source) => {
          if (source === "cache") {
            logger.info("Time remaining served from cache", { contractId, index });
          } else if (source === "in-flight") {
            logger.info("Time remaining served from in-flight cache", { contractId, index });
          }
        },
        produce: async () => {
          const tx = buildSimulationTx(
            contractId,
            "time_until_auto_release",
            nativeToScVal(Number(index), { type: "u32" }),
          );

          const result = await server.simulateTransaction(tx);

          if ("error" in result) {
            const { status, message } = classifySimError(String(result.error));
            throw new SimError(status, message);
          }
          if ("result" in result && result.result?.retval) {
            // retval is an xdr.ScVal (u64 -> bigint); decode it (#599).
            const decoded = scValToNative(result.result.retval);
            const sec =
              typeof decoded === "bigint" || typeof decoded === "number" ? Number(decoded) : NaN;
            if (!Number.isFinite(sec)) {
              throw new SimError(500, "Internal server error");
            }
            timeRemainingCache.set(cacheKey, sec);
            return sec;
          }
          throw new SimError(500, "Internal server error");
        },
      });

      sendSuccess(res, { secondsRemaining });
    } catch (err: unknown) {
      if (err instanceof SimError) {
        logger.warn("Simulation error for time-remaining", {
          contractId,
          index,
          status: err.status,
        });
        if (err.status === 404) {
          sendError(res, 404, "Job not found");
        } else {
          sendError(res, err.status, err.message);
        }
        return;
      }
      logger.error("Failed to get time remaining", {
        error: formatError(err),
        contractId: req.params.contractId,
        index: req.params.index,
        stack: err instanceof Error ? err.stack : undefined,
      });
      sendError(res, 500, "Internal server error");
    }
  },
);
export default router;
