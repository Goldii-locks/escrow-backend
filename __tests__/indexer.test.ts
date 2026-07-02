import Database from "better-sqlite3";
import {
  runMigrations,
  initSchema,
  getLastIndexedLedger,
  setLastIndexedLedger,
  insertEvent,
  insertEventBatch,
  getEventsByAddress,
  registerContract,
  deregisterContract,
  getActiveContractIds,
  setDb,
  getDb,
  type EventRow,
} from "../src/indexer/db.js";

describe("Indexer Database", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
  });

  afterAll(() => {
    testDb.close();
  });

  beforeEach(() => {
    testDb.exec("DROP TABLE IF EXISTS events");
    testDb.exec("DROP TABLE IF EXISTS indexer_state");
    testDb.exec("DROP TABLE IF EXISTS monitored_contracts");
    testDb.exec("DROP TABLE IF EXISTS schema_migrations");
    runMigrations();
  });

  // -------------------------------------------------------------------------
  // Migration manager (#84)
  // -------------------------------------------------------------------------

  describe("Migration manager", () => {
    it("creates schema_migrations table", () => {
      const row = testDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
        )
        .get();
      expect(row).toBeTruthy();
    });

    it("records applied migrations in schema_migrations", () => {
      const rows = testDb
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number }>;
      // We ship 2 migrations (events/indexer_state + monitored_contracts)
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows[0].version).toBe(1);
      expect(rows[1].version).toBe(2);
    });

    it("does not re-apply already-applied migrations (idempotent)", () => {
      // Running again should not throw and should not duplicate rows
      runMigrations();
      const rows = testDb
        .prepare("SELECT version FROM schema_migrations")
        .all();
      // Still exactly 2 unique versions
      const versions = [...new Set((rows as any[]).map((r) => r.version))];
      expect(versions.length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Ledger state
  // -------------------------------------------------------------------------

  it("should track last indexed ledger correctly", () => {
    expect(getLastIndexedLedger()).toBe(0);
    setLastIndexedLedger(12345);
    expect(getLastIndexedLedger()).toBe(12345);
  });

  // -------------------------------------------------------------------------
  // Single-row insertEvent
  // -------------------------------------------------------------------------

  it("should avoid inserting duplicate events", () => {
    const contractId = "test-contract-id";
    const eventType = "test-event";
    const ledger1 = 100;
    const timestamp = 1234567890;
    const dataJson1 = JSON.stringify({ a: 1 });
    const dataJson2 = JSON.stringify({ a: 2 });

    insertEvent(contractId, eventType, ledger1, timestamp, dataJson1);
    insertEvent(contractId, eventType, ledger1, timestamp, dataJson2);

    const events = testDb.prepare("SELECT * FROM events").all();
    expect(events.length).toBe(1);
    expect((events[0] as any).data_json).toEqual(dataJson1);
  });

  it("should return events filtered by address", () => {
    const contractId = "test-contract-id";
    const addr1 = "GAAAAA1";
    const addr2 = "GAAAAA2";
    const data1 = JSON.stringify({ client: addr1, freelancer: addr2 });
    const data2 = JSON.stringify({ arbiter: addr1 });
    const data3 = JSON.stringify({ someone: "else" });

    insertEvent(contractId, "event1", 100, 123456, data1);
    insertEvent(contractId, "event2", 101, 123457, data2);
    insertEvent(contractId, "event3", 102, 123458, data3);

    const events1 = getEventsByAddress(addr1);
    expect(events1.length).toBe(2);

    const events2 = getEventsByAddress(addr2);
    expect(events2.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Atomic batch insert (#84)
  // -------------------------------------------------------------------------

  describe("insertEventBatch – atomicity (#84)", () => {
    it("writes all events and advances the ledger pointer in one transaction", () => {
      const batch: EventRow[] = [
        {
          contractId: "C1",
          eventType: "initialized",
          ledgerSequence: 10,
          timestamp: 1000,
          dataJson: JSON.stringify({ client: "GA" }),
        },
        {
          contractId: "C2",
          eventType: "funded",
          ledgerSequence: 11,
          timestamp: 1001,
          dataJson: JSON.stringify({ client: "GB" }),
        },
      ];

      insertEventBatch(batch, 11);

      const rows = testDb.prepare("SELECT * FROM events").all();
      expect(rows.length).toBe(2);
      expect(getLastIndexedLedger()).toBe(11);
    });

    it("rolls back entire batch and does NOT advance ledger on error", () => {
      // Prepare: set the ledger baseline
      setLastIndexedLedger(5);

      // Insert a row that the second batch item will collide with (UNIQUE
      // constraint on contract_id + ledger_sequence + event_type).
      // We use insertEvent (INSERT OR IGNORE) for the pre-seed so it succeeds,
      // then craft a batch whose second row re-uses the same unique key *without*
      // OR IGNORE – which we achieve by adding a BEFORE INSERT trigger that
      // raises an error when it sees a specific sentinel contract_id.
      testDb.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_fail_on_sentinel
        BEFORE INSERT ON events
        WHEN NEW.contract_id = '__SENTINEL_FAIL__'
        BEGIN
          SELECT RAISE(FAIL, 'intentional test failure');
        END;
      `);

      const badBatch: EventRow[] = [
        {
          contractId: "C-ROLLBACK-OK",
          eventType: "initialized",
          ledgerSequence: 20,
          timestamp: 2000,
          dataJson: JSON.stringify({ client: "GX" }),
        },
        {
          contractId: "__SENTINEL_FAIL__", // trigger raises FAIL here
          eventType: "funded",
          ledgerSequence: 21,
          timestamp: 2001,
          dataJson: JSON.stringify({ client: "GY" }),
        },
      ];

      expect(() => insertEventBatch(badBatch, 21)).toThrow();

      // Ledger must NOT have advanced
      expect(getLastIndexedLedger()).toBe(5);

      // Neither event from the batch should exist
      const rows = testDb
        .prepare("SELECT * FROM events WHERE contract_id IN ('C-ROLLBACK-OK', '__SENTINEL_FAIL__')")
        .all();
      expect(rows.length).toBe(0);

      // Clean up the trigger
      testDb.exec("DROP TRIGGER IF EXISTS trg_fail_on_sentinel");
    });
  });

  // -------------------------------------------------------------------------
  // Monitored contracts (#85)
  // -------------------------------------------------------------------------

  describe("Monitored contracts (#85)", () => {
    it("registers a new contract and returns it in getActiveContractIds", () => {
      registerContract("CONTRACT-ALPHA", "alpha escrow");
      const ids = getActiveContractIds();
      expect(ids).toContain("CONTRACT-ALPHA");
    });

    it("registers multiple contracts and returns all active ones", () => {
      registerContract("CONTRACT-BETA");
      registerContract("CONTRACT-GAMMA");
      const ids = getActiveContractIds();
      expect(ids).toContain("CONTRACT-BETA");
      expect(ids).toContain("CONTRACT-GAMMA");
    });

    it("deregisters a contract so it no longer appears in active list", () => {
      registerContract("CONTRACT-DELTA");
      deregisterContract("CONTRACT-DELTA");
      const ids = getActiveContractIds();
      expect(ids).not.toContain("CONTRACT-DELTA");
    });

    it("re-registering a deregistered contract marks it active again", () => {
      registerContract("CONTRACT-EPSILON");
      deregisterContract("CONTRACT-EPSILON");
      registerContract("CONTRACT-EPSILON"); // re-enable
      const ids = getActiveContractIds();
      expect(ids).toContain("CONTRACT-EPSILON");
    });

    it("registerContract is idempotent (no duplicate rows)", () => {
      registerContract("CONTRACT-ZETA");
      registerContract("CONTRACT-ZETA");
      const rows = testDb
        .prepare(
          "SELECT COUNT(*) as cnt FROM monitored_contracts WHERE contract_id = 'CONTRACT-ZETA'"
        )
        .get() as { cnt: number };
      expect(rows.cnt).toBe(1);
    });
  });
});
