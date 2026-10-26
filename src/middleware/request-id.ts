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
  res.on("finish", () => {
    logger.info("HTTP request", {
      requestId: req.id,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - start,
      ip: req.ip ?? req.socket?.remoteAddress,
    });
  });
  next();
}
