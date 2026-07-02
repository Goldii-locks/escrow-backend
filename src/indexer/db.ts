import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import logger from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  const dbPath = process.env.DB_PATH || path.join(__dirname, "../../data/escrow.db");
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  dbInstance = new Database(dbPath);
  dbInstance.pragma("journal_mode = WAL");
  return dbInstance;
}

export function setDb(newDb: Database.Database) {
  dbInstance = newDb;
}

export const db = getDb();

db.pragma("journal_mode = WAL");

// ---------------------------------------------------------------------------
// Migration manager (#84)
// ---------------------------------------------------------------------------
// Each migration has a unique integer version and a SQL string to execute.
// The schema_migrations table tracks which versions have been applied.
// Migrations run inside a transaction so a failed migration is fully rolled back.

interface Migration {
  version: number;
  description: string;
  up: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "create events and indexer_state tables",
    up: `
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contract_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        ledger_sequence INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(contract_id, ledger_sequence, event_type)
      );

      CREATE TABLE IF NOT EXISTS indexer_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT OR IGNORE INTO indexer_state (key, value) VALUES ('last_ledger_sequence', '0');
    `,
  },
  {
    version: 2,
    description: "create monitored_contracts table",
    up: `
      CREATE TABLE IF NOT EXISTS monitored_contracts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contract_id TEXT NOT NULL UNIQUE,
        label TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `,
  },
];

/**
 * Ensures the schema_migrations tracking table exists, then applies any
 * pending migrations in version order, each wrapped in its own transaction.
 */
export function runMigrations(): void {
  const database = getDb();

  // Bootstrap: create the migrations tracking table if it doesn't exist yet
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS webhook_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id TEXT NOT NULL,
      webhook_url TEXT NOT NULL,
      event_types TEXT NOT NULL DEFAULT '*',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(contract_id, webhook_url)
    );

    CREATE TABLE IF NOT EXISTS webhook_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  for (const migration of MIGRATIONS) {
    const applied = database
      .prepare("SELECT version FROM schema_migrations WHERE version = ?")
      .get(migration.version);

    if (applied) continue;

    logger.info("Applying DB migration", {
      version: migration.version,
      description: migration.description,
    });

    // Run migration inside a transaction – rolls back fully on any error
    const applyMigration = database.transaction(() => {
      database.exec(migration.up);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, description) VALUES (?, ?)"
        )
        .run(migration.version, migration.description);
    });

    try {
      applyMigration();
      logger.info("Migration applied", { version: migration.version });
    } catch (err) {
      logger.error("Migration failed – rolled back", {
        version: migration.version,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

/**
 * @deprecated Use runMigrations() instead.
 * Kept for backward-compatibility so existing test setup still works.
 */
export function initSchema() {
  runMigrations();
}

// ---------------------------------------------------------------------------
// Indexer state
// ---------------------------------------------------------------------------

export function getLastIndexedLedger(): number {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM indexer_state WHERE key = 'last_ledger_sequence'")
    .get();
  return row ? parseInt((row as any).value, 10) : 0;
}

export function setLastIndexedLedger(seq: number) {
  const db = getDb();
  const stmt = db.prepare(
    "UPDATE indexer_state SET value = ? WHERE key = 'last_ledger_sequence'"
  );
  stmt.run(seq.toString());
}

// ---------------------------------------------------------------------------
// Monitored contracts (#85)
// ---------------------------------------------------------------------------

/**
 * Registers a contract for polling, or re-activates it if it was previously
 * deregistered. Idempotent - calling this repeatedly for the same
 * contract_id never creates duplicate rows.
 */
export function registerContract(contractId: string, label?: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO monitored_contracts (contract_id, label, active)
     VALUES (?, ?, 1)
     ON CONFLICT(contract_id) DO UPDATE SET
       active = 1,
       label = COALESCE(excluded.label, monitored_contracts.label)`
  ).run(contractId, label ?? null);
}

/**
 * Marks a contract inactive so it's excluded from getActiveContractIds()
 * without deleting its historical event data.
 */
export function deregisterContract(contractId: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE monitored_contracts SET active = 0 WHERE contract_id = ?"
  ).run(contractId);
}

/**
 * Returns the contract_ids currently marked active for polling.
 */
export function getActiveContractIds(): string[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT contract_id FROM monitored_contracts WHERE active = 1")
    .all() as Array<{ contract_id: string }>;
  return rows.map((row) => row.contract_id);
}

// ---------------------------------------------------------------------------
// Event insertion with atomic transactions (#84)
// ---------------------------------------------------------------------------

/**
 * Insert a single event row.  For atomic batch inserts use insertEventBatch().
 */
export function insertEvent(
  contractId: string,
  eventType: string,
  ledgerSequence: number,
  timestamp: number,
  dataJson: string
): boolean {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO events 
    (contract_id, event_type, ledger_sequence, timestamp, data_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    contractId,
    eventType,
    ledgerSequence,
    timestamp,
    dataJson
  );
  return result.changes > 0;
}

export interface WebhookSubscription {
  id: number;
  url: string;
  created_at: string;
}

export function addWebhookSubscription(url: string): WebhookSubscription {
  const db = getDb();
  const result = db
    .prepare("INSERT INTO webhook_subscriptions (url) VALUES (?)")
    .run(url);
  const row = db
    .prepare(
      "SELECT id, url, created_at FROM webhook_subscriptions WHERE id = ?"
    )
    .get(result.lastInsertRowid);
  return row as WebhookSubscription;
}

export function removeWebhookSubscription(url: string): boolean {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM webhook_subscriptions WHERE url = ?")
    .run(url);
  return result.changes > 0;
}

export function getWebhookSubscriptions(): WebhookSubscription[] {
  const db = getDb();
  return db
    .prepare("SELECT id, url, created_at FROM webhook_subscriptions ORDER BY id")
    .all() as WebhookSubscription[];
}

export interface EventRow {
  contractId: string;
  eventType: string;
  ledgerSequence: number;
  timestamp: number;
  dataJson: string;
}

/**
 * Atomically insert a batch of events AND advance the ledger pointer.
 * If any insertion fails the entire batch and the ledger update are rolled back,
 * so the indexer pointer never advances past un-committed data (#84).
 */
export function insertEventBatch(events: EventRow[], newLedger: number): void {
  const db = getDb();

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO events 
    (contract_id, event_type, ledger_sequence, timestamp, data_json)
    VALUES (?, ?, ?, ?, ?)
  `);

  const updateLedger = db.prepare(
    "UPDATE indexer_state SET value = ? WHERE key = 'last_ledger_sequence'"
  );

  const batchTransaction = db.transaction(() => {
    for (const ev of events) {
      insertStmt.run(
        ev.contractId,
        ev.eventType,
        ev.ledgerSequence,
        ev.timestamp,
        ev.dataJson
      );
    }
    updateLedger.run(newLedger.toString());
  });

  batchTransaction();
}

// ---------------------------------------------------------------------------
// Event queries
// ---------------------------------------------------------------------------

export function getEventsByAddress(address: string) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM events 
    WHERE data_json LIKE ?
    ORDER BY ledger_sequence DESC
  `);
  return stmt.all(`%${address}%`);
}

export interface JobSummary {
  contract_id: string;
  role: "client" | "freelancer" | "arbiter" | "unknown";
  milestone_count: number;
  latest_event_type: string;
  latest_ledger: number;
  latest_timestamp: number;
}

export interface PaginatedJobs {
  jobs: JobSummary[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Optimized wallet query (#87).
 *
 * Instead of loading all matching rows into JS memory and grouping there,
 * we push the filtering, grouping, and pagination entirely into SQLite using
 * the built-in JSON1 extension (json_extract).  Only the page we need is
 * returned from the database engine.
 *
 * The query:
 *   1. Filters rows where json_extract finds the address in client / freelancer
 *      / arbiter fields (exact match – no false-positive LIKE hits).
 *   2. Keeps only the most-recent event per contract_id (via MAX ledger subquery).
 *   3. Determines role with a CASE expression in SQL.
 *   4. Applies LIMIT / OFFSET inside the engine, so memory footprint is O(page).
 */
export function getJobsByWallet(
  address: string,
  page: number = 1,
  limit: number = 10
): PaginatedJobs {
  const db = getDb();

  const safePage = Math.max(1, page);
  const safeLimit = Math.max(1, limit);
  const offset = (safePage - 1) * safeLimit;

  // Count distinct contract_ids that match the address in a role field
  const countRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM (
         SELECT contract_id
         FROM events
         WHERE json_extract(data_json, '$.client')     = ?
            OR json_extract(data_json, '$.freelancer') = ?
            OR json_extract(data_json, '$.arbiter')    = ?
         GROUP BY contract_id
       )`
    )
    .get(address, address, address) as { cnt: number };

  const total = countRow?.cnt ?? 0;

  // Fetch one row per contract_id – the most-recent event – with role & extras
  const rows = db
    .prepare(
      `SELECT
         e.contract_id,
         e.event_type                                     AS latest_event_type,
         e.ledger_sequence                                AS latest_ledger,
         e.timestamp                                      AS latest_timestamp,
         CASE
           WHEN json_extract(e.data_json, '$.client')     = ? THEN 'client'
           WHEN json_extract(e.data_json, '$.freelancer') = ? THEN 'freelancer'
           WHEN json_extract(e.data_json, '$.arbiter')    = ? THEN 'arbiter'
           ELSE 'unknown'
         END                                              AS role,
         e.data_json
       FROM events e
       INNER JOIN (
         SELECT contract_id, MAX(ledger_sequence) AS max_ledger
         FROM events
         WHERE json_extract(data_json, '$.client')     = ?
            OR json_extract(data_json, '$.freelancer') = ?
            OR json_extract(data_json, '$.arbiter')    = ?
         GROUP BY contract_id
       ) latest
         ON e.contract_id    = latest.contract_id
        AND e.ledger_sequence = latest.max_ledger
       ORDER BY e.ledger_sequence DESC
       LIMIT ? OFFSET ?`
    )
    .all(
      address, address, address,  // CASE args
      address, address, address,  // inner subquery args
      safeLimit, offset
    ) as Array<{
      contract_id: string;
      latest_event_type: string;
      latest_ledger: number;
      latest_timestamp: number;
      role: "client" | "freelancer" | "arbiter" | "unknown";
      data_json: string;
    }>;

  const jobs: JobSummary[] = rows.map((row) => {
    let milestoneCount = 0;
    try {
      const parsed = JSON.parse(row.data_json) as Record<string, unknown>;
      milestoneCount = Array.isArray(parsed["milestones"])
        ? (parsed["milestones"] as unknown[]).length
        : 0;
    } catch {
      // unparseable – leave milestone_count as 0
    }

    return {
      contract_id: row.contract_id,
      role: row.role,
      milestone_count: milestoneCount,
      latest_event_type: row.latest_event_type,
      latest_ledger: row.latest_ledger,
      latest_timestamp: row.latest_timestamp,
    };
  });

  return { jobs, total, page: safePage, limit: safeLimit };
}

export interface EventDbRow {
  id: number;
  contract_id: string;
  event_type: string;
  ledger_sequence: number;
  timestamp: number;
  data_json: string;
  created_at: string;
}

export interface PaginatedEvents {
  events: EventDbRow[];
  total: number;
  page: number;
  limit: number;
}

export function getEventsByContract(
  contractId: string,
  page: number = 1,
  limit: number = 10
): PaginatedEvents {
  const db = getDb();
  const safePage = Math.max(1, page);
  const safeLimit = Math.max(1, Math.min(100, limit));
  const offset = (safePage - 1) * safeLimit;

  const totalRow = db
    .prepare("SELECT COUNT(*) as count FROM events WHERE contract_id = ?")
    .get(contractId) as { count: number };

  const rows = db
    .prepare(
      `SELECT * FROM events
       WHERE contract_id = ?
       ORDER BY ledger_sequence ASC
       LIMIT ? OFFSET ?`
    )
    .all(contractId, safeLimit, offset) as EventDbRow[];

  return {
    events: rows,
    total: totalRow.count,
    page: safePage,
    limit: safeLimit,
  };
}

export interface IndexerStatusData {
  lastIndexedLedger: number;
  totalEvents: number;
  lastEventAt: string | null;
  eventsByType: Record<string, number>;
}

export interface WebhookSubscription {
  id: number;
  contract_id: string;
  webhook_url: string;
  event_types: string;
  created_at: string;
}

export function addSubscription(
  contractId: string,
  webhookUrl: string,
  eventTypes: string[]
): WebhookSubscription {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO webhook_subscriptions
    (contract_id, webhook_url, event_types)
    VALUES (?, ?, ?)
  `);
  stmt.run(contractId, webhookUrl, JSON.stringify(eventTypes));
  return db
    .prepare("SELECT * FROM webhook_subscriptions WHERE contract_id = ? AND webhook_url = ?")
    .get(contractId, webhookUrl) as WebhookSubscription;
}

export function removeSubscription(contractId: string, webhookUrl: string): boolean {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM webhook_subscriptions WHERE contract_id = ? AND webhook_url = ?")
    .run(contractId, webhookUrl);
  return result.changes > 0;
}

export function getSubscriptions(): WebhookSubscription[] {
  const db = getDb();
  return db.prepare("SELECT * FROM webhook_subscriptions").all() as WebhookSubscription[];
}

export function getSubscriptionsForContract(contractId: string): WebhookSubscription[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM webhook_subscriptions WHERE contract_id = ?")
    .all(contractId) as WebhookSubscription[];
}

export function getIndexerStatusData(): IndexerStatusData {
  const db = getDb();
  const lastIndexedLedger = getLastIndexedLedger();

  const totalRow = db
    .prepare("SELECT COUNT(*) as count FROM events")
    .get() as { count: number };

  const lastEventRow = db
    .prepare("SELECT MAX(created_at) as last_at FROM events")
    .get() as { last_at: string | null };

  const typeRows = db
    .prepare(
      "SELECT event_type, COUNT(*) as count FROM events GROUP BY event_type"
    )
    .all() as Array<{ event_type: string; count: number }>;

  const eventsByType: Record<string, number> = {};
  for (const row of typeRows) {
    eventsByType[row.event_type] = row.count;
  }

  return {
    lastIndexedLedger,
    totalEvents: totalRow.count,
    lastEventAt: lastEventRow.last_at,
    eventsByType,
  };
}
