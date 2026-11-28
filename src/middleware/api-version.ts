import type { NextFunction, Request, Response } from "express";
import logger from "../utils/logger.js";
import { maskAddress } from "../utils/log-redaction.js";

/** Mask full Stellar addresses in a URL before logging (they would link IP to wallet). */
const maskAddressesInPath = (url: string): string =>
  url.replace(/[GC][A-Z2-7]{55}/g, (addr) => maskAddress(addr));

/** Matches the versioned prefix: /api/v1, /api/v1/..., /api/v1?... */
const VERSIONED_PATH = /^\/api\/v1(?:[/?]|$)/;

let legacyRequestCount = 0;

/** Current count of requests received on unversioned legacy /api/* endpoints (#929). */
export function getLegacyRequestCount(): number {
  return legacyRequestCount;
}

/** Resets the legacy request counter (for testing). */
export function resetLegacyRequestCount(): void {
  legacyRequestCount = 0;
}

function getSunsetHttpDate(): string | undefined {
  const raw = process.env.LEGACY_API_SUNSET;
  if (!raw || raw.trim() === "") return undefined;
  const date = new Date(raw.trim());
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toUTCString();
}

export type LegacyApiRequest = Request & {
  isLegacyApi?: boolean;
  legacyRequestCount?: number;
};

/**
 * Marks requests to the legacy unversioned /api/* paths as deprecated (#697, #929).
 *
 * Every router is mounted at both /api/v1/* and /api/*; the legacy mount keeps
 * existing clients working while the `Deprecation`, `Link` (successor-version),
 * and `Sunset` headers tell them to migrate.
 */
export function legacyApiDeprecation(req: Request, res: Response, next: NextFunction): void {
  if (!VERSIONED_PATH.test(req.originalUrl)) {
    legacyRequestCount++;
    const legacyReq = req as LegacyApiRequest;
    legacyReq.isLegacyApi = true;
    legacyReq.legacyRequestCount = legacyRequestCount;

    res.setHeader("Deprecation", "true");

    const successorPath = req.originalUrl.replace(/^\/api(?=\/|\?|$)/, "/api/v1");
    res.setHeader("Link", `<${successorPath}>; rel="successor-version"`);

    const sunset = getSunsetHttpDate();
    if (sunset) {
      res.setHeader("Sunset", sunset);
    }

    logger.info("Legacy unversioned API request", {
      isLegacyApi: true,
      legacyRequestCount,
      path: maskAddressesInPath(req.originalUrl),
      successor: maskAddressesInPath(successorPath),
    });
  }
  next();
}
