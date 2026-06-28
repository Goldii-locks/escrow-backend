import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

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

export function initSchema() {
  const db = getDb();
  db.exec(`
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
  `);

  const initState = db.prepare(
    "INSERT OR IGNORE INTO indexer_state (key, value) VALUES (?, ?)"
  );
  initState.run("last_ledger_sequence", "0");
}

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

export function insertEvent(
  contractId: string,
  eventType: string,
  ledgerSequence: number,
  timestamp: number,
  dataJson: string
) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO events 
    (contract_id, event_type, ledger_sequence, timestamp, data_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(contractId, eventType, ledgerSequence, timestamp, dataJson);
}

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
 * Query the SQLite events table for all jobs where `address` appears as
 * client, freelancer, or arbiter inside data_json.  Events are grouped by
 * contract_id so each distinct job appears once.  The result is then
 * paginated using `page` (1-based) and `limit`.
 */
export function getJobsByWallet(
  address: string,
  page: number = 1,
  limit: number = 10
): PaginatedJobs {
  const db = getDb();

  // Fetch all events that mention this address anywhere in data_json
  const rows = db
    .prepare(
      `SELECT contract_id, event_type, ledger_sequence, timestamp, data_json
       FROM events
       WHERE data_json LIKE ?
       ORDER BY ledger_sequence DESC`
    )
    .all(`%${address}%`) as Array<{
    contract_id: string;
    event_type: string;
    ledger_sequence: number;
    timestamp: number;
    data_json: string;
  }>;

  // Group by contract_id, determining role and building a summary
  const jobMap = new Map<string, JobSummary>();

  for (const row of rows) {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(row.data_json) as Record<string, unknown>;
    } catch {
      // skip unparseable rows
      continue;
    }

    // Only include this row if the address genuinely appears in a role field
    // (protects against false-positive LIKE matches in other string fields)
    const roleInRow =
      parsed["client"] === address
        ? "client"
        : parsed["freelancer"] === address
        ? "freelancer"
        : parsed["arbiter"] === address
        ? "arbiter"
        : null;

    if (!roleInRow) continue;

    if (!jobMap.has(row.contract_id)) {
      // First (most-recent) event for this contract determines the summary
      jobMap.set(row.contract_id, {
        contract_id: row.contract_id,
        role: roleInRow,
        milestone_count: Array.isArray(parsed["milestones"])
          ? (parsed["milestones"] as unknown[]).length
          : 0,
        latest_event_type: row.event_type,
        latest_ledger: row.ledger_sequence,
        latest_timestamp: row.timestamp,
      });
    }
  }

  const allJobs = Array.from(jobMap.values());
  const total = allJobs.length;
  const safePage = Math.max(1, page);
  const safeLimit = Math.max(1, limit);
  const start = (safePage - 1) * safeLimit;
  const jobs = allJobs.slice(start, start + safeLimit);

  return { jobs, total, page: safePage, limit: safeLimit };
}

export interface EventRow {
  id: number;
  contract_id: string;
  event_type: string;
  ledger_sequence: number;
  timestamp: number;
  data_json: string;
  created_at: string;
}

export interface PaginatedEvents {
  events: EventRow[];
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
    .all(contractId, safeLimit, offset) as EventRow[];

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
