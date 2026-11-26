import type { Request, Response, NextFunction } from "express";
import { configuredApiKeys, matchingApiKeyIndex } from "../utils/api-keys.js";
import logger from "../utils/logger.js";

function getProvidedApiKey(req: Request): string | undefined {
  const headerKey = req.header("x-api-key");
  if (headerKey) return headerKey;

  const auth = req.header("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length);
  }

  return undefined;
}

export type AdminRequest = Request & {
  adminKeyIndex?: number;
};

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const expectedKeys = configuredApiKeys("ADMIN_API_KEYS", "ADMIN_API_KEY");
  if (expectedKeys.length === 0) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  const keyIndex = matchingApiKeyIndex(getProvidedApiKey(req), expectedKeys);
  if (keyIndex === undefined) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  (req as AdminRequest).adminKeyIndex = keyIndex;
  logger.info("Admin API key authenticated", { keyIndex, path: req.path });
  next();
}
