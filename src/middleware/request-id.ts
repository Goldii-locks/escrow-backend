import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import logger from "../utils/logger.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incomingId = req.get("X-Request-Id");
  req.id =
    incomingId && REQUEST_ID_PATTERN.test(incomingId)
      ? incomingId
      : randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
}

export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = Date.now();
  const legacyReq = req as Request & { isLegacyApi?: boolean; legacyRequestCount?: number };
  let logged = false;
  const logRequest = (aborted: boolean): void => {
    if (logged) return;
    logged = true;
    const fields = {
      requestId: req.id,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - start,
      ip: req.ip ?? req.socket?.remoteAddress,
      ...(legacyReq.isLegacyApi
        ? { isLegacyApi: true, legacyRequestCount: legacyReq.legacyRequestCount }
        : {}),
    };
    if (aborted) {
      logger.warn("HTTP request", { ...fields, aborted: true });
    } else {
      logger.info("HTTP request", fields);
    }
  };
  res.on("finish", () => logRequest(false));
  res.on("close", () => {
    if (!res.writableFinished) logRequest(true);
  });
  next();
}
