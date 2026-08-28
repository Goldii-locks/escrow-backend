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

/** Strict CORS gate for GET /api/jobs/:contractId. */
export function jobContractCors(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const origin = req.header("Origin");
  const allowedOrigins = getAllowedOrigins();

  if (!origin) {
    next();
    return;
  }

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-API-Key"
    );
    next();
    return;
  }

  res.status(403).json({
    success: false,
    error: "Origin not allowed by CORS policy",
  });
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

/** Strict CORS gate for POST /api/jobs/create-job-draft. */
export function createJobDraftCors(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const origin = req.header("Origin");
  const allowedOrigins = getAllowedOrigins();

  if (!origin) {
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
    return;
  }

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-API-Key"
    );
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
    return;
  }

  res.status(403).json({
    success: false,
    error: "Origin not allowed by CORS policy",
  });
}

/** Security headers applied to POST /api/jobs/create-job-draft responses. */
export const createJobDraftSecurityHeaders = jobContractSecurityHeaders;

/** Strict CORS gate for POST /api/jobs/submit. */
export function submitCors(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const origin = req.header("Origin");
  const allowedOrigins = getAllowedOrigins();

  if (!origin) {
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
    return;
  }

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-API-Key"
    );
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
    return;
  }

  res.status(403).json({
    success: false,
    error: "Origin not allowed by CORS policy",
  });
}

/** Security headers applied to POST /api/jobs/submit responses. */
export const submitSecurityHeaders = jobContractSecurityHeaders;

/** Strict CORS gate for GET /api/jobs/:contractId/milestones/:index/time-remaining. */
export function timeRemainingCors(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const origin = req.header("Origin");
  const allowedOrigins = getAllowedOrigins();

  if (!origin) {
    next();
    return;
  }

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-API-Key"
    );
    next();
    return;
  }

  res.status(403).json({
    success: false,
    error: "Origin not allowed by CORS policy",
  });
}

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

/** CORS policy for GET /api/jobs/by-wallet/:address. */
export function byWalletCors(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const origin = req.header("Origin");
  const allowedOrigins = getAllowedOrigins();

  if (!origin) {
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
    return;
  }

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-API-Key"
    );
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
    return;
  }

  res.status(403).json({
    success: false,
    error: "Origin not allowed by CORS policy",
  });
}

export const byWalletSecurityHeaders = jobContractSecurityHeaders;

/** Strict CORS gate for POST /api/jobs/:contractId/milestones/:index/claim-auto-release. */
export function claimAutoReleaseCors(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const origin = req.header("Origin");
  const allowedOrigins = getAllowedOrigins();

  if (!origin) {
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
    return;
  }

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-API-Key"
    );
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
    return;
  }

  res.status(403).json({
    success: false,
    error: "Origin not allowed by CORS policy",
  });
}

/** Security headers applied to claim-auto-release responses. */
export const claimAutoReleaseSecurityHeaders = jobContractSecurityHeaders;
