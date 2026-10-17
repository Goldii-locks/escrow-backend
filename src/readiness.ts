import type { Request, Response } from "express";
import { getDb, getLastIndexedLedger } from "./indexer/db.js";
import { getLastSuccessfulPollAt } from "./indexer/poller.js";
import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Readiness probe (#622)
// ---------------------------------------------------------------------------
// GET /health is liveness only: it returns ok even when SQLite is locked or
// the poller has died. /ready reflects both dependencies instead:
//
//   200 { status: "ready", lastIndexedLedger, lastSuccessfulPollAgeMs }
//     when SELECT 1 succeeds and the last successful poll is within
//     READY_MAX_POLL_AGE_MS (default 3x the max poll interval),
//   503 { status: "not_ready", failingCheck, ... } naming the failing check.
//
// The body carries ledger pointers and ages only — no secrets or wallet data.

export type ReadinessFailingCheck = "database" | "poller";

export interface ReadinessStatus {
  status: "ready" | "not_ready";
  lastIndexedLedger: number | null;
  lastSuccessfulPollAgeMs: number | null;
  failingCheck?: ReadinessFailingCheck;
}

export interface ReadinessDeps {
  checkDatabase: () => void;
  getLastSuccessfulPollAt: () => number | null;
  getLastIndexedLedger: () => number;
  maxPollAgeMs: number;
  nowMs?: number;
}

export function checkReadiness(deps: ReadinessDeps): ReadinessStatus {
  const now = deps.nowMs ?? Date.now();

  try {
    deps.checkDatabase();
  } catch {
    return {
      status: "not_ready",
      lastIndexedLedger: null,
      lastSuccessfulPollAgeMs: null,
      failingCheck: "database",
    };
  }

  const lastSuccessfulPollAt = deps.getLastSuccessfulPollAt();
  const ageMs = lastSuccessfulPollAt === null ? null : now - lastSuccessfulPollAt;

  let ledger: number | null = null;
  try {
    ledger = deps.getLastIndexedLedger();
  } catch {
    return {
      status: "not_ready",
      lastIndexedLedger: null,
      lastSuccessfulPollAgeMs: ageMs,
      failingCheck: "database",
    };
  }

  if (ageMs === null || ageMs > deps.maxPollAgeMs) {
    return {
      status: "not_ready",
      lastIndexedLedger: ledger,
      lastSuccessfulPollAgeMs: ageMs,
      failingCheck: "poller",
    };
  }

  return { status: "ready", lastIndexedLedger: ledger, lastSuccessfulPollAgeMs: ageMs };
}

const defaultDeps: ReadinessDeps = {
  checkDatabase: () => {
    getDb().prepare("SELECT 1").get();
  },
  getLastSuccessfulPollAt,
  getLastIndexedLedger,
  get maxPollAgeMs() {
    return config.readyMaxPollAgeMs;
  },
};

export function readinessHandler(_req: Request, res: Response): void {
  const result = checkReadiness(defaultDeps);
  res.status(result.status === "ready" ? 200 : 503).json(result);
}
