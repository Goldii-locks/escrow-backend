import { Router } from "express";
import type { Request, Response } from "express";
import {
  Contract,
  TransactionBuilder,
  nativeToScVal,
  timeRemainingRateLimit,
  timeRemainingCors,
  timeRemainingSecurityHeaders,
  sendError,
  sendSuccess,
  validate,
  contractMilestoneParamsSchema,
  logger,
  NETWORK_PASSPHRASE,
  server,
  simulationSource,
} from "./shared.js";
import { getInclusionFee } from "../../utils/fee-helper.js";

import {
  timeRemainingCache,
  inFlightTimeRemainingRequests,
} from "./caches.js";
import {
  SimError,
  classifySimError,
} from "./errors.js";

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
  timeRemainingCors,
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
        requestId: (req as any).requestId,
      });

      const cached = timeRemainingCache.get<number>(cacheKey);
      if (cached !== undefined) {
        logger.info("Time remaining served from cache", { contractId, index });
        sendSuccess(res, { secondsRemaining: cached });
        return;
      }

      let requestPromise = inFlightTimeRemainingRequests.get(cacheKey);
      const servedFromInFlight = Boolean(requestPromise);

      if (!requestPromise) {
        requestPromise = (async (): Promise<number> => {
          const contract = new Contract(contractId);
          const account = simulationSource();
          const tx = new TransactionBuilder(account, {
            fee: await getInclusionFee(server),
            networkPassphrase: NETWORK_PASSPHRASE,
          })
            .addOperation(
              contract.call(
                "time_until_auto_release",
                nativeToScVal(Number(index), { type: "u32" }),
              ),
            )
            .setTimeout(30)
            .build();

          const result = await server.simulateTransaction(tx);

          if ("error" in result) {
            const { status, message } = classifySimError(String(result.error));
            throw new SimError(status, message);
          }
          if ("result" in result && result.result?.retval) {
            const secondsRemaining = Number(result.result.retval);
            timeRemainingCache.set(cacheKey, secondsRemaining);
            return secondsRemaining;
          }
          throw new SimError(500, "Internal server error");
        })();

        inFlightTimeRemainingRequests.set(cacheKey, requestPromise);
      }

      let secondsRemaining: number;
      try {
        secondsRemaining = await requestPromise;
      } finally {
        inFlightTimeRemainingRequests.delete(cacheKey);
      }

      if (servedFromInFlight) {
        logger.info("Time remaining served from in-flight cache", { contractId, index });
      }
      sendSuccess(res, { secondsRemaining });
    } catch (err: any) {
      if (err instanceof SimError) {
        logger.warn("Simulation error for time-remaining", {
          contractId,
          index,
          status: err.status,
          requestId: (req as any).requestId,
        });
        if (err.status === 404) {
          sendError(res, 404, "Job not found");
        } else {
          sendError(res, err.status, err.message);
        }
        return;
      }
      logger.error("Failed to get time remaining", {
        error: err?.message,
        contractId: req.params.contractId,
        index: req.params.index,
        stack: err?.stack,
        requestId: (req as any).requestId,
      });
      sendError(res, 500, "Internal server error");
    }
  },
);
export default router;
