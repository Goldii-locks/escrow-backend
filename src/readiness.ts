import type { Request, Response } from "express";
import { getDb, getLastIndexedLedger } from "./indexer/db.js";
import { getLastObservedLedgerLag, getLastSuccessfulPollAt } from "./indexer/poller.js";
import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Readiness probe (#622)
// ---------------------------------------------------------------------------
// GET /health is liveness only: it returns ok even when SQLite is locked or
// the poller has died. /ready reflects both dependencies instead:
//
//   200 { status: "ready", lastIndexedLedger, lastSuccessfulPollAgeMs, ledgerLag }
//     when SELECT 1 succeeds, the last successful poll is within
//     READY_MAX_POLL_AGE_MS (default 3x the max poll interval), and the lag
//     observed by that poll is within READY_MAX_LEDGER_LAG (#893),
//   503 { status: "not_ready", failingCheck, ... } naming the failing check.
//
// The body carries ledger pointers and ages only — no secrets or wallet data.

export type ReadinessFailingCheck = "database" | "poller" | "ledgerLag";

export interface ReadinessStatus {
  status: "ready" | "not_ready";
  lastIndexedLedger: number | null;
  lastSuccessfulPollAgeMs: number | null;
  ledgerLag: number | null;
  failingCheck?: ReadinessFailingCheck;
}

export interface ReadinessDeps {
  checkDatabase: () => void;
  getLastSuccessfulPollAt: () => number | null;
  getLastIndexedLedger: () => number;
  getLastObservedLedgerLag?: () => number | null;
  maxPollAgeMs: number;
  maxLedgerLag?: number;
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
      ledgerLag: null,
      failingCheck: "database",
    };
  }

  const lastSuccessfulPollAt = deps.getLastSuccessfulPollAt();
  const ageMs = lastSuccessfulPollAt === null ? null : now - lastSuccessfulPollAt;

  let ledger: number | null = null;
  let ledgerLag: number | null = null;
  try {
    ledger = deps.getLastIndexedLedger();
    ledgerLag = deps.getLastObservedLedgerLag?.() ?? null;
  } catch {
    return {
      status: "not_ready",
      lastIndexedLedger: null,
      lastSuccessfulPollAgeMs: ageMs,
      ledgerLag: null,
      failingCheck: "database",
    };
  }

  if (ageMs === null || ageMs > deps.maxPollAgeMs) {
    return {
      status: "not_ready",
      lastIndexedLedger: ledger,
      lastSuccessfulPollAgeMs: ageMs,
      ledgerLag,
      failingCheck: "poller",
    };
  }

  if (ledgerLag !== null && ledgerLag > (deps.maxLedgerLag ?? config.readyMaxLedgerLag)) {
    return {
      status: "not_ready",
      lastIndexedLedger: ledger,
      lastSuccessfulPollAgeMs: ageMs,
      ledgerLag,
      failingCheck: "ledgerLag",
    };
  }

  return {
    status: "ready",
    lastIndexedLedger: ledger,
    lastSuccessfulPollAgeMs: ageMs,
    ledgerLag,
  };
}

const defaultDeps: ReadinessDeps = {
  checkDatabase: () => {
    getDb().prepare("SELECT 1").get();
  },
  getLastSuccessfulPollAt,
  getLastIndexedLedger,
  getLastObservedLedgerLag,
  get maxPollAgeMs() {
    return config.readyMaxPollAgeMs;
  },
  get maxLedgerLag() {
    return config.readyMaxLedgerLag;
  },
};

export function readinessHandler(_req: Request, res: Response): void {
  const result = checkReadiness(defaultDeps);
  res.status(result.status === "ready" ? 200 : 503).json(result);
}
