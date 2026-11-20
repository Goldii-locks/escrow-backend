import type { NextFunction, Request, Response } from "express";
import {
  configuredApiKeys,
  getProvidedApiKey,
  matchingApiKeyIndex,
} from "../utils/api-keys.js";

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const expectedKeys = configuredApiKeys("API_KEYS", "API_KEY");
  if (matchingApiKeyIndex(getProvidedApiKey(req), expectedKeys) === undefined) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  next();
}
