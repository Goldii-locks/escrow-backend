import type { NextFunction, Request, Response } from "express";

const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:3000"];

export function getAllowedOrigins(): string[] {
  const configured = process.env.ALLOWED_ORIGINS?.trim();
  if (!configured) {
    return DEFAULT_ALLOWED_ORIGINS;
  }
  return configured
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/** Security headers applied to GET /api/jobs/:contractId responses. */
export function jobContractSecurityHeaders(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );
  next();
}

/** Security headers applied to POST /api/jobs/create-job-draft responses. */
export const createJobDraftSecurityHeaders = jobContractSecurityHeaders;

/** Security headers applied to POST /api/jobs/submit responses. */
export const submitSecurityHeaders = jobContractSecurityHeaders;

/** Security headers applied to GET /api/jobs/:contractId/milestones/:index/time-remaining responses. */
export function timeRemainingSecurityHeaders(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );
  next();
}

export const byWalletSecurityHeaders = jobContractSecurityHeaders;

/** Security headers applied to partial-release responses. */
export const partialReleaseSecurityHeaders = jobContractSecurityHeaders;

/** Security headers applied to claim-auto-release responses. */
export const claimAutoReleaseSecurityHeaders = jobContractSecurityHeaders;

/** Security headers applied to whitelist update responses. */
export const updateWhitelistSecurityHeaders = jobContractSecurityHeaders;

/** Security headers applied to POST /api/jobs/build-tx responses. */
export const buildTxSecurityHeaders = jobContractSecurityHeaders;
