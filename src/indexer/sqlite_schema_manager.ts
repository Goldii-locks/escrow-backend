import logger from "../utils/logger.js";

/**
 * sqlite_schema_manager failure / stall alerting (#262).
 *
 * Tracks consecutive schema init/migration failures and emits threshold
 * warnings when operations stall or fail repeatedly.
 */

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_STALL_THRESHOLD_MS = 120_000;

export type SqliteSchemaManagerFailureType =
  | "migration"
  | "bootstrap"
  | "stall";

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return n;
}

export class SqliteSchemaManagerFailureMonitor {
  readonly name: string;
  readonly failureThreshold: number;
  readonly stallThresholdMs: number;
  private consecutiveFailures = 0;
  private lastSuccessfulAt: number | null = null;
  private alertActive = false;

  constructor(
    options: {
      name?: string;
      failureThreshold?: number;
      stallThresholdMs?: number;
    } = {},
  ) {
    this.name = options.name ?? "sqlite_schema_manager";
    this.failureThreshold =
      options.failureThreshold ??
      readPositiveIntEnv(
        "SQLITE_SCHEMA_MANAGER_FAILURE_THRESHOLD",
        DEFAULT_FAILURE_THRESHOLD,
      );
    this.stallThresholdMs =
      options.stallThresholdMs ??
      readPositiveIntEnv(
        "SQLITE_SCHEMA_MANAGER_STALL_THRESHOLD_MS",
        DEFAULT_STALL_THRESHOLD_MS,
      );
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  getLastSuccessfulAt(): number | null {
    return this.lastSuccessfulAt;
  }

  isAlertActive(): boolean {
    return this.alertActive;
  }

  getFailureThreshold(): number {
    return this.failureThreshold;
  }

  /**
   * Record a failure. Logs an error every time and emits a warning alert only
   * when the consecutive-failure threshold is first reached (#262).
   */
  recordFailure(
    failureType: SqliteSchemaManagerFailureType,
    details: {
      error?: string;
      version?: number;
      description?: string;
      elapsedMs?: number;
    } = {},
  ): number {
    this.consecutiveFailures += 1;
    const payload = {
      manager: this.name,
      failureType,
      consecutiveFailures: this.consecutiveFailures,
      threshold: this.failureThreshold,
      error: details.error,
      version: details.version,
      description: details.description,
      elapsedMs: details.elapsedMs,
    };

    logger.error("sqlite_schema_manager operation failed", payload);

    if (this.consecutiveFailures === this.failureThreshold) {
      this.alertActive = true;
      logger.warn(
        "sqlite_schema_manager alert: consecutive failure threshold reached",
        {
          ...payload,
          action:
            "Inspect SQLite migration SQL and disk permissions; the manager resumes automatically after the next successful runMigrations().",
        },
      );
    }

    return this.consecutiveFailures;
  }

  recordSuccess(): void {
    const hadFailures = this.consecutiveFailures > 0 || this.alertActive;
    this.consecutiveFailures = 0;
    this.lastSuccessfulAt = Date.now();
    if (hadFailures) {
      logger.info(
        "sqlite_schema_manager recovered after consecutive failures",
        { manager: this.name },
      );
    }
    this.alertActive = false;
  }

  /**
   * Emit a stall warning when no successful schema operation has occurred
   * within the stall window. Reads stall threshold from env on each check.
   */
  checkStall(): boolean {
    if (this.lastSuccessfulAt === null) return false;
    const stallThresholdMs = readPositiveIntEnv(
      "SQLITE_SCHEMA_MANAGER_STALL_THRESHOLD_MS",
      this.stallThresholdMs,
    );
    const elapsedMs = Date.now() - this.lastSuccessfulAt;
    if (elapsedMs <= stallThresholdMs) return false;
    logger.warn("sqlite_schema_manager alert: stall threshold reached", {
      manager: this.name,
      failureType: "stall" as const,
      consecutiveFailures: this.consecutiveFailures,
      threshold: this.failureThreshold,
      stallThresholdMs,
      elapsedMs,
      action:
        "No successful sqlite_schema_manager operation within the stall window; inspect migration health.",
    });
    return true;
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.lastSuccessfulAt = null;
    this.alertActive = false;
  }
}

const defaultMonitor = new SqliteSchemaManagerFailureMonitor();

export function getSqliteSchemaManagerFailureMonitor(): SqliteSchemaManagerFailureMonitor {
  return defaultMonitor;
}

export function resetSqliteSchemaManagerFailureState(): void {
  defaultMonitor.reset();
}
