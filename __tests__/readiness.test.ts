import request from "supertest";
import express from "express";
import {
  checkReadiness,
  readinessHandler,
  type ReadinessDeps,
} from "../src/readiness.js";

function deps(overrides: Partial<ReadinessDeps> = {}): ReadinessDeps {
  return {
    checkDatabase: () => {},
    getLastSuccessfulPollAt: () => Date.now(),
    getLastIndexedLedger: () => 12345,
    getLastObservedLedgerLag: () => 0,
    maxPollAgeMs: 360000,
    maxLedgerLag: 120,
    ...overrides,
  };
}

function buildApp() {
  const app = express();
  app.get("/ready", readinessHandler);
  return app;
}

describe("readiness probe (#622)", () => {
  it("reports ready when the DB answers and the poller is fresh", () => {
    const result = checkReadiness(deps({ nowMs: 1_000_000, getLastSuccessfulPollAt: () => 999_000 }));
    expect(result).toEqual({
      status: "ready",
      lastIndexedLedger: 12345,
      lastSuccessfulPollAgeMs: 1000,
      ledgerLag: 0,
    });
  });

  it("reports ready when the observed ledger lag is below the threshold", () => {
    const result = checkReadiness(deps({ getLastObservedLedgerLag: () => 119 }));
    expect(result).toEqual({
      status: "ready",
      lastIndexedLedger: 12345,
      lastSuccessfulPollAgeMs: expect.any(Number),
      ledgerLag: 119,
    });
  });

  it("reports not_ready when the observed ledger lag exceeds the threshold", () => {
    const result = checkReadiness(deps({ getLastObservedLedgerLag: () => 121 }));
    expect(result.status).toBe("not_ready");
    expect(result.failingCheck).toBe("ledgerLag");
    expect(result.ledgerLag).toBe(121);
  });

  it("DB failure surfaces as not_ready naming the database check", () => {
    const result = checkReadiness(
      deps({
        checkDatabase: () => {
          throw new Error("SQLITE_CORRUPT");
        },
      }),
    );
    expect(result.status).toBe("not_ready");
    expect(result.failingCheck).toBe("database");
  });

  it("stale poller surfaces as not_ready naming the poller check", () => {
    const result = checkReadiness(
      deps({ nowMs: 1_000_000, getLastSuccessfulPollAt: () => 0 }),
    );
    expect(result.status).toBe("not_ready");
    expect(result.failingCheck).toBe("poller");
  });

  it("a poller that never succeeded is not ready", () => {
    const result = checkReadiness(
      deps({ getLastSuccessfulPollAt: () => null }),
    );
    expect(result.status).toBe("not_ready");
    expect(result.failingCheck).toBe("poller");
  });

  it("the body contains no secrets or wallet data", () => {
    const result = checkReadiness(deps());
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/api[_-]?key|secret|mnemonic|seed/i);
    expect(Object.keys(result).sort()).toEqual([
      "failingCheck",
      "lastIndexedLedger",
      "lastSuccessfulPollAgeMs",
      "ledgerLag",
      "status",
    ].filter((k) => k in result));
  });

  it("GET /ready is unauthenticated and returns JSON", async () => {
    const res = await request(buildApp()).get("/ready").expect(503);
    // No tables in this bare app's DB (or no successful poll yet) → 503,
    // but the route itself is reachable without credentials.
    expect(res.body.status).toBe("not_ready");
    expect(res.body.failingCheck).toBeDefined();
  });
});
