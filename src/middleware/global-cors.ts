import cors from "cors";
import type { RequestHandler } from "express";
import { getAllowedOrigins } from "./job-contract-security.js";

export const CORS_ALLOWED_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];
export const CORS_ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-API-Key",
];
/** Response headers browsers may read cross-origin (#936). */
export const CORS_EXPOSED_HEADERS = [
  "X-Request-Id",
  "RateLimit-Limit",
  "RateLimit-Remaining",
  "RateLimit-Reset",
  "Retry-After",
];

/**
 * The single CORS layer (#601, #935). Restricted to the ALLOWED_ORIGINS
 * allowlist. A disallowed origin gets no Access-Control-* headers on any
 * route, so the browser blocks the response; there is no per-route 403.
 */
export function globalCors(): RequestHandler {
  return cors({
    // Read per request so ALLOWED_ORIGINS changes apply without a rebuild.
    origin: (origin, callback) =>
      callback(null, !origin || getAllowedOrigins().includes(origin)),
    credentials: false,
    methods: CORS_ALLOWED_METHODS,
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: CORS_EXPOSED_HEADERS,
  });
}
