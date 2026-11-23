import type { NextFunction, Request, Response } from "express";
import logger from "../utils/logger.js";

const BODY_PARSER_MESSAGES: Record<string, string> = {
  "entity.parse.failed": "Malformed JSON body",
  "entity.too.large": "Payload too large",
};

/**
 * Global error handler (#603). Client errors raised by body-parser (malformed
 * JSON, oversized payloads) keep their 4xx status with a fixed message and are
 * logged at warn; anything else is a 500 with no detail, to avoid leaking
 * stack traces.
 */
export function globalErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const e = (err ?? {}) as { status?: unknown; statusCode?: unknown; type?: unknown };
  const status = typeof e.status === "number" ? e.status : e.statusCode;

  if (
    typeof status === "number" &&
    status >= 400 &&
    status <= 499 &&
    typeof e.type === "string" &&
    e.type.startsWith("entity.")
  ) {
    const error = BODY_PARSER_MESSAGES[e.type] ?? "Invalid request body";
    logger.warn("Rejected request body", { type: e.type, status, path: req.path });
    res.status(status).json({ success: false, error });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  logger.error("Unhandled error", { error: message, path: req.path });
  res.status(500).json({ success: false, error: "Internal server error" });
}
