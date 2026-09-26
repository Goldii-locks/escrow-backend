import {
  CREATE_EMAIL_ACTIVITY_INDEX_SQL,
  CREATE_EMAIL_ACTIVITY_SQL,
  EMAIL_ACTIVITY_COLUMNS,
  EMAIL_ACTIVITY_ERRORS,
  EMAIL_ACTIVITY_TABLE,
  EmailActivityLogStore,
  INSERT_EMAIL_ACTIVITY_SQL,
  activityParams,
  normaliseActivityEntry,
  type EmailActivityEntry,
  type SqlExecutor,
} from "../src/utils/email_sender_activity_log.js";

type StoredRow = Record<string, unknown> & { id: number };

/**
 * A tiny in-memory stand-in for better-sqlite3, implementing just the
 * statements this store issues so the row-counting behaviour can be asserted.
 */
function createMemoryExecutor(): SqlExecutor & { rows: StoredRow[]; failNextInsert?: boolean } {
  const executor = {
    rows: [] as StoredRow[],
    failNextInsert: false,

    run(sql: string, params: unknown[] = []) {
      if (sql.startsWith("CREATE")) return { changes: 0 };

      if (sql.startsWith("INSERT INTO")) {
        if (executor.failNextInsert) {
          executor.failNextInsert = false;
          throw new Error("disk I/O error");
        }
        const row: StoredRow = { id: executor.rows.length + 1 };
        EMAIL_ACTIVITY_COLUMNS.forEach((column, index) => {
          row[column] = params[index];
        });
        executor.rows.push(row);
        return { changes: 1, lastInsertRowid: row.id };
      }

      throw new Error(`unsupported statement: ${sql}`);
    },

    all(sql: string, params: unknown[] = []) {
      if (sql.includes("GROUP BY transaction_id")) {
        const counts = new Map<string, number>();
        for (const row of executor.rows) {
          const key = String(row.transaction_id);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return [...counts.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([transactionId, total]) => ({ transactionId, total }));
      }

      const transactionId = params[0];
      return executor.rows
        .filter((row) => row.transaction_id === transactionId)
        .sort((a, b) =>
          String(a.recorded_at).localeCompare(String(b.recorded_at)) || a.id - b.id
        );
    },

    transaction<T>(fn: () => T): T {
      const snapshot = [...executor.rows];
      try {
        return fn();
      } catch (error) {
        executor.rows.length = 0;
        executor.rows.push(...snapshot);
        throw error;
      }
    },
  };

  return executor;
}

const ENTRY: EmailActivityEntry = {
  emailId: "mail-1",
  transactionId: "tx-100",
  template: "milestone-released",
  recipient: "ops@goldii.example",
  status: "sent",
  attempt: 1,
};

describe("email_sender_activity_log", () => {
  let db: ReturnType<typeof createMemoryExecutor>;
  let store: EmailActivityLogStore;

  beforeEach(() => {
    db = createMemoryExecutor();
    store = new EmailActivityLogStore(db, () => new Date("2026-09-25T12:00:00.000Z"));
    store.migrate();
  });

  describe("schema", () => {
    it("targets the expected table and column order", () => {
      expect(EMAIL_ACTIVITY_TABLE).toBe("email_activity_log");
      expect(CREATE_EMAIL_ACTIVITY_SQL).toContain("CREATE TABLE IF NOT EXISTS email_activity_log");
      expect(CREATE_EMAIL_ACTIVITY_INDEX_SQL).toContain("idx_email_activity_transaction");
      expect(INSERT_EMAIL_ACTIVITY_SQL).toContain(
        "(email_id, transaction_id, template, recipient, status, attempt, error, recorded_at)"
      );
      expect(INSERT_EMAIL_ACTIVITY_SQL.match(/\?/g)).toHaveLength(EMAIL_ACTIVITY_COLUMNS.length);
    });
  });

  describe("normaliseActivityEntry", () => {
    it("fills in the recorded timestamp and defaults attempt to zero", () => {
      const result = normaliseActivityEntry(
        { ...ENTRY, attempt: undefined },
        () => new Date("2026-09-25T12:00:00.000Z")
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.entry.attempt).toBe(0);
        expect(result.entry.recordedAt).toBe("2026-09-25T12:00:00.000Z");
        expect(result.entry.error).toBeNull();
      }
    });

    it("binds parameters in column order", () => {
      const result = normaliseActivityEntry(ENTRY);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(activityParams(result.entry)).toEqual([
          "mail-1",
          "tx-100",
          "milestone-released",
          "ops@goldii.example",
          "sent",
          1,
          null,
          expect.any(String),
        ]);
      }
    });

    it("rejects missing identifiers, an unknown status and a bad timestamp", () => {
      expect(normaliseActivityEntry({ ...ENTRY, transactionId: "" }).ok).toBe(false);
      expect(normaliseActivityEntry({ ...ENTRY, status: "unknown" as never }).ok).toBe(false);
      expect(normaliseActivityEntry({ ...ENTRY, attempt: -1 }).ok).toBe(false);
      expect(normaliseActivityEntry({ ...ENTRY, recordedAt: "nope" }).ok).toBe(false);

      const result = normaliseActivityEntry({ ...ENTRY, recipient: "" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(EMAIL_ACTIVITY_ERRORS.INVALID_ENTRY);
    });
  });

  describe("record", () => {
    it("inserts a row and returns its id", () => {
      const result = store.record(ENTRY);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.id).toBe(1);
        expect(result.changes).toBe(1);
      }
      expect(db.rows).toHaveLength(1);
      expect(db.rows[0].transaction_id).toBe("tx-100");
      expect(db.rows[0].status).toBe("sent");
    });

    it("returns the validation error without writing", () => {
      const result = store.record({ ...ENTRY, status: "nope" as never });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(EMAIL_ACTIVITY_ERRORS.INVALID_ENTRY);
      expect(db.rows).toHaveLength(0);
    });

    it("reports a driver failure as WRITE_FAILED", () => {
      db.failNextInsert = true;
      const result = store.record(ENTRY);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(EMAIL_ACTIVITY_ERRORS.WRITE_FAILED);
        expect(result.error).toContain("disk I/O error");
      }
    });

    it("requires an executor with run()", () => {
      expect(() => new EmailActivityLogStore({} as unknown as SqlExecutor)).toThrow(
        EMAIL_ACTIVITY_ERRORS.MISSING_EXECUTOR
      );
    });
  });

  describe("recordMany", () => {
    it("inserts a batch of attempts", () => {
      const result = store.recordMany([
        { ...ENTRY, status: "queued", attempt: 0 },
        { ...ENTRY, status: "failed", attempt: 1, error: "smtp 421" },
        { ...ENTRY, status: "sent", attempt: 2 },
      ]);
      expect(result.ok).toBe(true);
      expect(result.inserted).toBe(3);
      expect(db.rows).toHaveLength(3);
    });

    it("treats an empty batch as a no-op", () => {
      const result = store.recordMany([]);
      expect(result).toEqual({ ok: true, inserted: 0, failures: [] });
      expect(db.rows).toHaveLength(0);
    });

    it("rolls the whole batch back when one entry is invalid", () => {
      const result = store.recordMany([
        { ...ENTRY, status: "sent" },
        { ...ENTRY, recipient: "" },
      ]);
      expect(result.ok).toBe(false);
      expect(result.inserted).toBe(0);
      expect(result.failures).toHaveLength(1);
      expect(db.rows).toHaveLength(0);
    });
  });

  describe("tracking rows under active transactions", () => {
    it("populates rows for each transaction as attempts are recorded", () => {
      // Two transactions in flight, each with a queue -> fail -> send history.
      for (const transactionId of ["tx-100", "tx-200"]) {
        store.record({ ...ENTRY, transactionId, status: "queued", attempt: 0 });
        store.record({ ...ENTRY, transactionId, status: "failed", attempt: 1, error: "timeout" });
        store.record({ ...ENTRY, transactionId, status: "sent", attempt: 2 });
      }

      const counts = store.countByTransaction();
      expect(counts.get("tx-100")).toBe(3);
      expect(counts.get("tx-200")).toBe(3);
      expect(counts.size).toBe(2);

      const rows = store.rowsForTransaction("tx-100") as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(3);
      expect(rows.map((row) => row.status)).toEqual(["queued", "failed", "sent"]);
      expect(rows.map((row) => row.attempt)).toEqual([0, 1, 2]);
      expect(rows[1].error).toBe("timeout");
      expect(rows[2].error).toBeNull();
    });

    it("returns no rows for a transaction that has not been worked", () => {
      store.record(ENTRY);
      expect(store.rowsForTransaction("tx-999")).toEqual([]);
      expect(store.countByTransaction().has("tx-999")).toBe(false);
    });

    it("reports no counts when the executor cannot query", () => {
      const runOnly: SqlExecutor = { run: () => ({ changes: 1 }) };
      const limited = new EmailActivityLogStore(runOnly);
      expect(limited.countByTransaction().size).toBe(0);
      expect(limited.rowsForTransaction("tx-100")).toEqual([]);
    });
  });
});
