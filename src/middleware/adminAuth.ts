import type { Request, Response, NextFunction } from "express";
import {
  configuredApiKeys,
  getProvidedAdminKey,
  matchingApiKeyIndex,
} from "../utils/api-keys.js";
import logger from "../utils/logger.js";

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const expectedKeys = configuredApiKeys("ADMIN_API_KEYS", "ADMIN_API_KEY");
  if (expectedKeys.length === 0) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  const provided = getProvidedAdminKey(req);
  const keyIndex = matchingApiKeyIndex(provided?.key, expectedKeys);
  if (keyIndex === undefined) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  if (provided?.source === "x-api-key") {
    // #970: deprecated. x-api-key is the public-key header; admin keys sent
    // there end up in logs and proxies that record it.
    logger.warn(
      "Admin API key sent via deprecated x-api-key header; use x-admin-key or Authorization: Bearer",
      { keyIndex, path: req.path },
    );
  }

  logger.info("Admin API key authenticated", {
    keyIndex,
    source: provided?.source,
    path: req.path,
  });
  next();
}
