import type { NextFunction, Request, Response } from "express";
import { configuredApiKeys, matchingApiKeyIndex } from "../utils/api-keys.js";

function getProvidedApiKey(req: Request): string | undefined {
  const headerKey = req.header("x-api-key");
  if (headerKey) return headerKey;

  const auth = req.header("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length);
  }

  return undefined;
}

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const expectedKeys = configuredApiKeys("API_KEYS", "API_KEY");
  if (matchingApiKeyIndex(getProvidedApiKey(req), expectedKeys) === undefined) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  next();
}