import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import express from "express";
import { makeRouteLimiter } from "../middleware/job-contract-rate-limit.js";
import { sendError } from "../utils/api-response.js";
import logger from "../utils/logger.js";

const router = Router();

export const cspReportRateLimit = makeRouteLimiter({
  envPrefix: "CSP_REPORT_RATE",
  defaultMax: 30,
  defaultWindowMs: 60000,
});

export const resetCspReportRateLimitBuckets = (): void => {
  cspReportRateLimit.reset();
};

const dedupMap = new Map<string, number>();

export const resetCspReportDedupCache = (): void => {
  dedupMap.clear();
};

const cspParser = express.json({
  type: [
    "application/csp-report",
    "application/reports+json",
    "application/json",
  ],
  limit: "8kb",
});

function parseCspReportBody(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  cspParser(req, res, (err) => {
    if (err) {
      sendError(res, 400, "Invalid request body");
      return;
    }
    next();
  });
}

function extractPath(uri: unknown): string | undefined {
  if (typeof uri !== "string" || !uri.trim()) return undefined;
  const cleaned = uri.trim();
  try {
    const url = new URL(cleaned, "http://localhost");
    return url.pathname;
  } catch {
    return cleaned.split("?")[0].split("#")[0];
  }
}

function extractOrigin(uri: unknown): string | undefined {
  if (typeof uri !== "string" || !uri.trim()) return undefined;
  const cleaned = uri.trim();
  try {
    const url = new URL(cleaned);
    if (url.origin && url.origin !== "null") {
      return url.origin;
    }
  } catch {
    // ignore
  }
  return cleaned.split("?")[0].split("#")[0];
}

function stripQueryString(uri: unknown): string | undefined {
  if (typeof uri !== "string" || !uri.trim()) return undefined;
  return uri.trim().split("?")[0].split("#")[0];
}

interface ExtractedReport {
  documentUri?: string;
  violatedDirective?: string;
  blockedUri?: string;
  sourceFile?: string;
}

function extractCspReport(body: unknown): ExtractedReport[] {
  if (!body || typeof body !== "object") return [];

  // Reporting API format: array of reports
  if (Array.isArray(body)) {
    return body
      .map((item): ExtractedReport | null => {
        if (!item || typeof item !== "object") return null;
        const reportBody = (item.body && typeof item.body === "object" ? item.body : item) as Record<string, unknown>;
        const docUri = reportBody["documentURL"] ?? reportBody["document-uri"] ?? item["url"];
        const directive = reportBody["effectiveDirective"] ?? reportBody["violated-directive"] ?? reportBody["violatedDirective"];
        const blocked = reportBody["blockedURL"] ?? reportBody["blocked-uri"] ?? reportBody["blockedUri"];
        const source = reportBody["sourceFile"] ?? reportBody["source-file"];

        return {
          documentUri: extractPath(docUri),
          violatedDirective: typeof directive === "string" ? directive : undefined,
          blockedUri: extractOrigin(blocked),
          sourceFile: stripQueryString(source),
        };
      })
      .filter((r): r is ExtractedReport => r !== null);
  }

  // Traditional application/csp-report format
  const record = body as Record<string, unknown>;
  const reportObj = (record["csp-report"] && typeof record["csp-report"] === "object"
    ? record["csp-report"]
    : record) as Record<string, unknown>;

  const docUri = reportObj["document-uri"] ?? reportObj["documentURL"];
  const directive = reportObj["violated-directive"] ?? reportObj["effectiveDirective"];
  const blocked = reportObj["blocked-uri"] ?? reportObj["blockedURL"];
  const source = reportObj["source-file"] ?? reportObj["sourceFile"];

  return [
    {
      documentUri: extractPath(docUri),
      violatedDirective: typeof directive === "string" ? directive : undefined,
      blockedUri: extractOrigin(blocked),
      sourceFile: stripQueryString(source),
    },
  ];
}

router.post(
  "/",
  cspReportRateLimit,
  parseCspReportBody,
  (req: Request, res: Response) => {
    const reports = extractCspReport(req.body);
    const now = Date.now();

    for (const report of reports) {
      const dedupKey = `${report.violatedDirective ?? ""}:${report.blockedUri ?? ""}`;
      const lastLogged = dedupMap.get(dedupKey);

      if (!lastLogged || now - lastLogged >= 60000) {
        dedupMap.set(dedupKey, now);
        logger.info("CSP violation report", {
          documentUri: report.documentUri,
          violatedDirective: report.violatedDirective,
          blockedUri: report.blockedUri,
          sourceFile: report.sourceFile,
          ip: req.ip ?? req.socket?.remoteAddress,
        });
      }
    }

    res.status(204).end();
  },
);

export default router;
