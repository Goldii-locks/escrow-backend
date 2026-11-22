import type Database from "better-sqlite3";
import logger from "../utils/logger.js";

/**
 * Concurrency guard (#345): true while a cleanup cycle is running.
 */
let vacuumLockActive = false;
let activeVacuumPromise: Promise<void> | null = null;

export function isVacuumLocked(): boolean {
  return vacuumLockActive;
}

export function pruneOldEvents(db: Database.Database, retentionDays: number): number {
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new Error(`retentionDays must be a positive integer, got ${retentionDays}`);
  }

  const deleteStmt = db.prepare(
    `DELETE FROM events WHERE created_at < datetime('now', '-' || ? || ' days')`
  );
  const tx = db.transaction((d: number) => {
    const result = deleteStmt.run(d);
    return result.changes;
  });
  return tx(retentionDays);
}

export function runVacuum(db: Database.Database): void {
  db.exec("VACUUM");
}

export interface VacuumCleanupOptions {
  retentionDays?: number;
}

export interface VacuumCleanupResult {
  prunedEvents: number;
}

export function runVacuumCleanup(
  db: Database.Database,
  options: VacuumCleanupOptions = {}
): VacuumCleanupResult {
  const retentionDays = options.retentionDays ?? 90;
  logger.info("Starting sqlite vacuum cleanup", { retentionDays });
  const prunedEvents = pruneOldEvents(db, retentionDays);
  runVacuum(db);
  logger.info("Completed sqlite vacuum cleanup", { prunedEvents });
  return { prunedEvents };
}

export async function runVacuumCleanupConcurrent(
  db: Database.Database,
  options: VacuumCleanupOptions = {}
): Promise<VacuumCleanupResult> {
  const previousLock = activeVacuumPromise;

  let releaseLock!: () => void;
  activeVacuumPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  vacuumLockActive = true;

  try {
    if (previousLock) {
      await previousLock;
    }
    return runVacuumCleanup(db, options);
  } finally {
    vacuumLockActive = false;
    releaseLock();
    activeVacuumPromise = null;
  }
}
