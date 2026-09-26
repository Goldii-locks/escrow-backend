/**
 * Email Sender Service — activity history rows
 *
 * Every send attempt is written to the `email_activity_log` table so an
 * operator can answer "what happened to this alert?" without replaying logs.
 * Writes are attempted for both direct sends and retries, so the rows for a
 * transaction accumulate as that transaction is worked through.
 *
 * The store talks to an injected SQL executor (the shape `better-sqlite3`
 * exposes) rather than importing a driver, which keeps it usable from the
 * schedule worker and straightforward to test.
 */

export const EMAIL_ACTIVITY_ERRORS = {
  INVALID_ENTRY: "EAL_INVALID_ENTRY",
  WRITE_FAILED: "EAL_WRITE_FAILED",
  MISSING_EXECUTOR: "EAL_MISSING_EXECUTOR",
} as const;

export type EmailActivityErrorCode =
  (typeof EMAIL_ACTIVITY_ERRORS)[keyof typeof EMAIL_ACTIVITY_ERRORS];

export const EMAIL_ACTIVITY_TABLE = "email_activity_log";

export const CREATE_EMAIL_ACTIVITY_SQL = `
CREATE TABLE IF NOT EXISTS ${EMAIL_ACTIVITY_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  template TEXT NOT NULL,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','sent','failed','exhausted')),
  attempt INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  recorded_at TEXT NOT NULL
)`.trim();

export const CREATE_EMAIL_ACTIVITY_INDEX_SQL =
  `CREATE INDEX IF NOT EXISTS idx_email_activity_transaction
   ON ${EMAIL_ACTIVITY_TABLE} (transaction_id, recorded_at)`.replace(/\s+/g, " ").trim();

export type EmailActivityStatus = "queued" | "sent" | "failed" | "exhausted";

export const EMAIL_ACTIVITY_COLUMNS = [
  "email_id",
  "transaction_id",
  "template",
  "recipient",
  "status",
  "attempt",
  "error",
  "recorded_at",
] as const;

export type EmailActivityColumn = (typeof EMAIL_ACTIVITY_COLUMNS)[number];

/** An attempt to record. `recorded_at` is filled in when omitted. */
export type EmailActivityEntry = {
  emailId: string;
  transactionId: string;
  template: string;
  recipient: string;
  status: EmailActivityStatus;
  attempt?: number;
  error?: string | null;
  recordedAt?: string;
};

export type NormalizedActivityEntry = {
  emailId: string;
  transactionId: string;
  template: string;
  recipient: string;
  status: EmailActivityStatus;
  attempt: number;
  error: string | null;
  recordedAt: string;
};

/** The subset of a SQL driver this store relies on. */
export type SqlExecutor = {
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid?: number | bigint };
  all?(sql: string, params?: unknown[]): unknown[];
  transaction?<T>(fn: () => T): T;
};

export type WriteResult =
  | { ok: true; id: number | bigint | null; changes: number }
  | { ok: false; error: string; code: EmailActivityErrorCode };

const STATUSES: readonly EmailActivityStatus[] = ["queued", "sent", "failed", "exhausted"];

/** The statement written to the activity table, in column order. */
export const INSERT_EMAIL_ACTIVITY_SQL =
  `INSERT INTO ${EMAIL_ACTIVITY_TABLE} (${EMAIL_ACTIVITY_COLUMNS.join(", ")})
   VALUES (${EMAIL_ACTIVITY_COLUMNS.map(() => "?").join(", ")})`.replace(/\s+/g, " ").trim();

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export type EntryValidation =
  | { ok: true; entry: NormalizedActivityEntry }
  | { ok: false; error: string; code: EmailActivityErrorCode };

/** Validate one attempt and fill in its recorded timestamp. */
export function normaliseActivityEntry(
  input: EmailActivityEntry,
  now: () => Date = () => new Date()
): EntryValidation {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "activity entry must be an object", code: EMAIL_ACTIVITY_ERRORS.INVALID_ENTRY };
  }

  const invalid = (message: string): EntryValidation => ({
    ok: false,
    error: message,
    code: EMAIL_ACTIVITY_ERRORS.INVALID_ENTRY,
  });

  if (!isNonEmptyString(input.emailId)) return invalid("emailId is required");
  if (!isNonEmptyString(input.transactionId)) return invalid("transactionId is required");
  if (!isNonEmptyString(input.template)) return invalid("template is required");
  if (!isNonEmptyString(input.recipient)) return invalid("recipient is required");
  if (!STATUSES.includes(input.status)) {
    return invalid(`status must be one of ${STATUSES.join(", ")}`);
  }

  const attempt = input.attempt ?? 0;
  if (!Number.isInteger(attempt) || attempt < 0) {
    return invalid("attempt must be a non-negative integer");
  }

  const recordedAt = input.recordedAt ?? now().toISOString();
  if (Number.isNaN(Date.parse(recordedAt))) {
    return invalid(`recordedAt "${recordedAt}" is not a parseable date`);
  }

  return {
    ok: true,
    entry: {
      emailId: input.emailId,
      transactionId: input.transactionId,
      template: input.template,
      recipient: input.recipient,
      status: input.status,
      attempt,
      error: input.error ?? null,
      recordedAt,
    },
  };
}

/** The bound parameter list for one entry, in `EMAIL_ACTIVITY_COLUMNS` order. */
export function activityParams(entry: NormalizedActivityEntry): unknown[] {
  return [
    entry.emailId,
    entry.transactionId,
    entry.template,
    entry.recipient,
    entry.status,
    entry.attempt,
    entry.error,
    entry.recordedAt,
  ];
}

/**
 * Row entry operations against the activity table. `migrate()` must be called
 * once (it is idempotent) before the first write.
 */
export class EmailActivityLogStore {
  constructor(
    private readonly db: SqlExecutor,
    private readonly now: () => Date = () => new Date()
  ) {
    if (!db || typeof db.run !== "function") {
      throw new Error(
        `${EMAIL_ACTIVITY_ERRORS.MISSING_EXECUTOR}: an executor exposing run() is required`
      );
    }
  }

  /** Create the table and its lookup index if they do not exist yet. */
  migrate(): void {
    this.db.run(CREATE_EMAIL_ACTIVITY_SQL);
    this.db.run(CREATE_EMAIL_ACTIVITY_INDEX_SQL);
  }

  /** Insert one attempt. */
  record(input: EmailActivityEntry): WriteResult {
    const validated = normaliseActivityEntry(input, this.now);
    if (!validated.ok) {
      return { ok: false, error: validated.error, code: validated.code };
    }

    try {
      const result = this.db.run(INSERT_EMAIL_ACTIVITY_SQL, activityParams(validated.entry));
      return {
        ok: true,
        id: result.lastInsertRowid ?? null,
        changes: result.changes,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: EMAIL_ACTIVITY_ERRORS.WRITE_FAILED,
      };
    }
  }

  /**
   * Insert several attempts atomically when the driver supports transactions,
   * so a partial failure cannot leave the history half-written.
   */
  recordMany(inputs: EmailActivityEntry[]): { ok: boolean; inserted: number; failures: WriteResult[] } {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      return { ok: true, inserted: 0, failures: [] };
    }

    let inserted = 0;
    const failures: WriteResult[] = [];

    const write = () => {
      inserted = 0;
      failures.length = 0;
      for (const input of inputs) {
        const result = this.record(input);
        if (result.ok) {
          inserted += 1;
        } else {
          failures.push(result);
        }
      }
      if (failures.length > 0) {
        // Force a rollback so a failed batch writes nothing.
        const [first] = failures;
        throw new Error(first.ok ? "batch write failed" : first.error);
      }
    };

    try {
      if (typeof this.db.transaction === "function") {
        this.db.transaction(write);
        return { ok: true, inserted, failures: [] };
      }

      write();
      return { ok: true, inserted, failures: [] };
    } catch {
      return { ok: false, inserted: 0, failures };
    }
  }

  /** Every recorded attempt for a transaction, oldest first. */
  rowsForTransaction(transactionId: string): unknown[] {
    if (typeof this.db.all !== "function") return [];
    return this.db.all(
      `SELECT * FROM ${EMAIL_ACTIVITY_TABLE} WHERE transaction_id = ? ORDER BY recorded_at ASC, id ASC`,
      [transactionId]
    );
  }

  /**
   * How many tracking rows exist per transaction — the check that the history
   * is actually being populated while transactions are active.
   */
  countByTransaction(): Map<string, number> {
    const counts = new Map<string, number>();
    if (typeof this.db.all !== "function") return counts;

    const rows = this.db.all(
      `SELECT transaction_id AS transactionId, COUNT(*) AS total FROM ${EMAIL_ACTIVITY_TABLE}
       GROUP BY transaction_id ORDER BY transaction_id ASC`
    );

    for (const row of rows as Array<{ transactionId: string; total: number }>) {
      counts.set(row.transactionId, Number(row.total));
    }

    return counts;
  }
}
