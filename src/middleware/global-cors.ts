import cors from "cors";
import type { RequestHandler } from "express";
import { getAllowedOrigins } from "./job-contract-security.js";

/**
 * App-wide CORS (#601). Restricted to the ALLOWED_ORIGINS allowlist so a
 * route that forgets its own gate is not open to every origin. Disallowed
 * origins simply get no Access-Control-Allow-Origin header; the per-route
 * gates in job-contract-security.ts still add an explicit 403 where used.
 */
export function globalCors(): RequestHandler {
  return cors({ origin: getAllowedOrigins(), credentials: false });
}
