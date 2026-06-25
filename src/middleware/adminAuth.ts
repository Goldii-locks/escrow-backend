import type { Request, Response, NextFunction } from "express";

function getProvidedApiKey(req: Request): string | undefined {
  const headerKey = req.header("x-api-key");
  if (headerKey) return headerKey;

  const auth = req.header("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length);
  }

  return undefined;
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const expectedKey = process.env.ADMIN_API_KEY;
  if (!expectedKey) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  const providedKey = getProvidedApiKey(req);
  if (!providedKey || providedKey !== expectedKey) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  next();
}
