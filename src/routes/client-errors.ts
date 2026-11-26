import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import express from "express";
import { clientErrorBodySchema } from "../schemas/client-errors.js";
import { makeRouteLimiter } from "../middleware/job-contract-rate-limit.js";
import { sendError } from "../utils/api-response.js";
import logger from "../utils/logger.js";

const router = Router();

export const clientErrorRateLimit = makeRouteLimiter({
  envPrefix: "CLIENT_ERROR_RATE",
  defaultMax: 30,
  defaultWindowMs: 60000,
});

export const resetClientErrorRateLimitBuckets = (): void => {
  clientErrorRateLimit.reset();
};

const jsonParser = express.json({ limit: "4kb" });

function parseClientErrorBody(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // If already parsed (e.g. in test setup), check byte length
  if (req.body && Object.keys(req.body).length > 0) {
    const rawLength = req.headers["content-length"]
      ? parseInt(req.headers["content-length"], 10)
      : Buffer.byteLength(JSON.stringify(req.body));
    if (rawLength > 4096) {
      sendError(res, 400, "Payload too large");
      return;
    }
    next();
    return;
  }

  jsonParser(req, res, (err) => {
    if (err) {
      sendError(res, 400, "Invalid request body");
      return;
    }
    next();
  });
}

router.post(
  "/",
  clientErrorRateLimit,
  parseClientErrorBody,
  (req: Request, res: Response) => {
    const parseResult = clientErrorBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      sendError(res, 400, parseResult.error.issues[0]?.message ?? "Invalid request body");
      return;
    }

    const { source, message, route, status, requestId } = parseResult.data;

    logger.warn("Client error reported", {
      clientError: true,
      source,
      message,
      route,
      status,
      requestId,
      ip: req.ip ?? req.socket?.remoteAddress,
    });

    res.status(204).end();
  },
);

export default router;

