/**
 * Maintenance prunes webhook_deliveries bookkeeping (#940): delivered rows
 * after WEBHOOK_DELIVERY_RETENTION_DAYS (default 7), dead rows after 90 days,
 * and never failed (still retryable) rows.
 */

import Database from "better-sqlite3";
import { setDb, closeDb, runMigrations } from "../src/indexer/db.js";
import { runMaintenanceCycle } from "../src/indexer/poller.js";

describe("webhook_deliveries pruning in maintenance", () => {
  let db: Database.Database;

  const insert = (eventId: number, status: string, ageDays: number) =>
    db
      .prepare(
        `INSERT INTO webhook_deliveries (subscription_id, event_id, status, updated_at)
         VALUES (1, ?, ?, datetime('now', ?))`
      )
      .run(eventId, status, `-${ageDays} days`);

  const remaining = () =>
    (
      db
        .prepare("SELECT event_id FROM webhook_deliveries ORDER BY event_id")
        .all() as { event_id: number }[]
    ).map((r) => r.event_id);

  beforeEach(() => {
    db = new Database(":memory:");
    setDb(db);
    runMigrations();
    delete process.env.EVENT_RETENTION_DAYS;
    delete process.env.WEBHOOK_DELIVERY_RETENTION_DAYS;
  });

  afterEach(() => {
    delete process.env.WEBHOOK_DELIVERY_RETENTION_DAYS;
    closeDb();
  });

  it("removes only old delivered and old dead rows after one cycle", () => {
    insert(1, "delivered", 30); // pruned
    insert(2, "delivered", 1); // kept
    insert(3, "failed", 365); // kept: still retryable
    insert(4, "failed", 1); // kept
    insert(5, "dead", 120); // pruned
    insert(6, "dead", 30); // kept

    runMaintenanceCycle();

    expect(remaining()).toEqual([2, 3, 4, 6]);
  });

  it("honours WEBHOOK_DELIVERY_RETENTION_DAYS", () => {
    process.env.WEBHOOK_DELIVERY_RETENTION_DAYS = "30";
    insert(1, "delivered", 10); // kept
    insert(2, "delivered", 31); // pruned

    runMaintenanceCycle();

    expect(remaining()).toEqual([1]);
  });
});
