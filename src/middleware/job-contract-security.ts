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
