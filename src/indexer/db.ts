import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import NodeCache from "node-cache";
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

/**
 * Close the active connection and drop the cached instance.
 *
 * Importing this module used to open a connection as a side effect, so every
 * test file that touched it leaked a SQLite file handle and Jest had to force
 * workers to exit. The connection is now opened lazily by `getDb()`, and this
 * lets test teardown release it.
 */
export function closeDb(): void {
  if (!dbInstance) return;
  try {
    dbInstance.close();
  } catch (err) {
    logger.warn("Failed to close database connection", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    dbInstance = null;
  }
}

const JOBS_BY_WALLET_CACHE_TTL_S = parseInt(
  process.env.JOBS_BY_WALLET_CACHE_TTL_S || "60",
  10,
);
const jobsByWalletCache = new NodeCache({
  stdTTL: JOBS_BY_WALLET_CACHE_TTL_S,
  useClones: false,
});
const inFlightJobsByWalletRequests = new Map<string, Promise<PaginatedJobs>>();

export function resetJobsByWalletCache(): void {
  jobsByWalletCache.flushAll();
  inFlightJobsByWalletRequests.clear();
}

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
  {
    version: 3,
    description: "add indexes for query optimization",
    up: `
      CREATE INDEX IF NOT EXISTS idx_events_contract_id
        ON events (contract_id);

      CREATE INDEX IF NOT EXISTS idx_events_ledger_sequence
        ON events (ledger_sequence);

      CREATE INDEX IF NOT EXISTS idx_events_contract_ledger
        ON events (contract_id, ledger_sequence);

      CREATE INDEX IF NOT EXISTS idx_events_contract_type
        ON events (contract_id, event_type);

      CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_contract
        ON webhook_subscriptions (contract_id);
    `,
  },
  {
    version: 4,
    description: "add ledger_range_tracker GROUP BY index (#295)",
    up: `
      CREATE INDEX IF NOT EXISTS idx_events_ledger_event_type
        ON events (ledger_sequence, event_type);
    `,
  },
];

// ---------------------------------------------------------------------------
// Exponential backoff retry for schema manager (#258)
// Retries transient SQLite / connection / timeout failures during migrations.
// ---------------------------------------------------------------------------

export interface SchemaRetryConfig {
  /** Maximum number of retry attempts (default: 5) */
  maxRetries: number;
  /** Initial delay in ms after first failure (default: 50) */
  initialBackoffMs: number;
  /** Multiplier applied to backoff on each consecutive failure (default: 2) */
  backoffMultiplier: number;
  /** Ceiling delay in ms (default: 2000) */
  maxBackoffMs: number;
}

const DEFAULT_SCHEMA_RETRY_CONFIG: SchemaRetryConfig = {
  maxRetries: 5,
  initialBackoffMs: 50,
  backoffMultiplier: 2,
  maxBackoffMs: 2000,
};

/** Retryable patterns for SQLite locks and connection/RPC-style timeouts. */
const SCHEMA_RETRYABLE_PATTERNS = [
  "timeout",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "database is locked",
  "database is busy",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "socket hang up",
  "connect timeout",
  "connection reset",
  "connection refused",
  "connection dropped",
  "RPC connection",
];

export function isSchemaRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return SCHEMA_RETRYABLE_PATTERNS.some((p) =>
    msg.toLowerCase().includes(p.toLowerCase()),
  );
}

/**
 * Compute the backoff delay for a given attempt number.
 * attempt 0 → initialBackoffMs
 * attempt 1 → initialBackoffMs * multiplier
 * etc., capped at maxBackoffMs.
 */
export function computeSchemaBackoffMs(
  attempt: number,
  config: Pick<
    SchemaRetryConfig,
    "initialBackoffMs" | "backoffMultiplier" | "maxBackoffMs"
  >,
): number {
  return Math.min(
    config.initialBackoffMs * Math.pow(config.backoffMultiplier, attempt),
    config.maxBackoffMs,
  );
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a synchronous schema operation with exponential backoff retry.
 * Used by runMigrations so existing sync callers stay unchanged.
 */
export function withSchemaRetrySync<T>(
  fn: () => T,
  config: Partial<SchemaRetryConfig> = {},
  context: string = "sqlite_schema_manager",
): T {
  const cfg = { ...DEFAULT_SCHEMA_RETRY_CONFIG, ...config };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (!isSchemaRetryableError(lastError) || attempt >= cfg.maxRetries) {
        throw lastError;
      }

      const delay = computeSchemaBackoffMs(attempt, cfg);
      logger.warn(`${context} failed, retrying`, {
        attempt: attempt + 1,
        maxRetries: cfg.maxRetries,
        backoffMs: delay,
        error: lastError.message,
      });
      sleepSync(delay);
    }
  }

  throw lastError ?? new Error(`${context} failed after retries`);
}

/**
 * Async variant of schema retry for callers that prefer Promise-based backoff
 * (e.g. unit tests asserting increasing delays without blocking the event loop).
 */
export async function withSchemaRetry<T>(
  fn: () => Promise<T> | T,
  config: Partial<SchemaRetryConfig> = {},
  context: string = "sqlite_schema_manager",
): Promise<T> {
  const cfg = { ...DEFAULT_SCHEMA_RETRY_CONFIG, ...config };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (!isSchemaRetryableError(lastError) || attempt >= cfg.maxRetries) {
        throw lastError;
      }

      const delay = computeSchemaBackoffMs(attempt, cfg);
      logger.warn(`${context} failed, retrying`, {
        attempt: attempt + 1,
        maxRetries: cfg.maxRetries,
        backoffMs: delay,
        error: lastError.message,
      });
      await sleep(delay);
    }
  }

  throw lastError ?? new Error(`${context} failed after retries`);
}

/**
 * Ensures the schema_migrations tracking table exists, then applies any
 * pending migrations in version order, each wrapped in its own transaction.
 *
 * The entire operation (bootstrap + migration loop) runs inside an outer
 * transaction so that *any* failure mid-operation triggers a full ROLLBACK
 * and no partial schema / migration state ever persists on disk (#186).
 */
export function runMigrations(
  retryConfig: Partial<SchemaRetryConfig> = {},
): void {
  withSchemaRetrySync(
    () => {
      applyPendingMigrations();
    },
    retryConfig,
    "sqlite_schema_manager.runMigrations",
  );
}

function applyPendingMigrations(): void {
  const database = getDb();

  const runAll = database.transaction(() => {
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

      database.exec(migration.up);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, description) VALUES (?, ?)"
        )
        .run(migration.version, migration.description);

      logger.info("Migration applied", { version: migration.version });
    }
  });

  try {
    runAll();
  } catch (err) {
    logger.error("Schema migration failed – full rollback executed", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * @deprecated Use runMigrations() instead.
 * Kept for backward-compatibility so existing test setup still works.
 */
export function initSchema() {
  runMigrations();
}

/**
 * Verifies every migration in MIGRATIONS is recorded as applied in
 * schema_migrations. Throws if the table is missing or a version hasn't
 * been applied yet, so callers can fail fast on a stale/out-of-sync
 * database instead of hitting confusing SQL errors later (#282).
 */
export function verifySchemaUpToDate(): void {
  const database = getDb();

  const migrationsTable = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    )
    .get();

  if (!migrationsTable) {
    throw new Error(
      "Database schema is out of sync: schema_migrations table not found. Run runMigrations() first."
    );
  }

  const appliedVersions = new Set(
    (
      database.prepare("SELECT version FROM schema_migrations").all() as Array<{
        version: number;
      }>
    ).map((row) => row.version)
  );

  const missing = MIGRATIONS.filter((m) => !appliedVersions.has(m.version));
  if (missing.length > 0) {
    throw new Error(
      `Database schema is out of sync: missing migrations ${missing
        .map((m) => `${m.version} (${m.description})`)
        .join(", ")}. Run runMigrations() first.`
    );
  }
}

// ---------------------------------------------------------------------------
// Schema verification hooks (#264)
// ---------------------------------------------------------------------------

export interface SchemaVerificationResult {
  valid: boolean;
  missingTables: string[];
  missingColumns: Record<string, string[]>;
  migrationVersionGap: boolean;
  errors: string[];
}

const EXPECTED_TABLES: Record<string, string[]> = {
  events: [
    "id",
    "contract_id",
    "event_type",
    "ledger_sequence",
    "timestamp",
    "data_json",
    "created_at",
  ],
  indexer_state: ["key", "value"],
  monitored_contracts: [
    "id",
    "contract_id",
    "label",
    "active",
    "registered_at",
  ],
  schema_migrations: ["version", "description", "applied_at"],
};

/**
 * Verify the database schema structure matches expected state.
 * Returns a detailed result indicating any discrepancies.
 */
export function verifySchemaIntegrity(): SchemaVerificationResult {
  const database = getDb();
  const missingTables: string[] = [];
  const missingColumns: Record<string, string[]> = {};
  const errors: string[] = [];
  let migrationVersionGap = false;

  // Check required tables exist
  for (const tableName of Object.keys(EXPECTED_TABLES)) {
    const table = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
      )
      .get(tableName);

    if (!table) {
      missingTables.push(tableName);
      continue;
    }

    // Check required columns
    const columns = database
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((c) => c.name));

    const missing = EXPECTED_TABLES[tableName].filter(
      (col) => !columnNames.has(col)
    );
    if (missing.length > 0) {
      missingColumns[tableName] = missing;
    }
  }

  // Check migration version continuity
  try {
    const applied = database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    const versions = applied.map((r) => r.version);
    for (let i = 1; i < versions.length; i++) {
      if (versions[i] - versions[i - 1] > 1) {
        migrationVersionGap = true;
        errors.push(
          `Migration version gap between ${versions[i - 1]} and ${versions[i]}`
        );
      }
    }
  } catch {
    errors.push("schema_migrations table is unreadable");
  }

  const valid =
    missingTables.length === 0 &&
    Object.keys(missingColumns).length === 0 &&
    !migrationVersionGap;

  return {
    valid,
    missingTables,
    missingColumns,
    migrationVersionGap,
    errors,
  };
}

/**
 * Verify schema integrity and throw if the database is out of sync.
 * Call this before starting the poller to prevent data corruption.
 */
export function assertSchemaValid(): void {
  const result = verifySchemaIntegrity();
  if (!result.valid) {
    const reasons = [
      ...result.missingTables.map((t) => `missing table: ${t}`),
      ...Object.entries(result.missingColumns).map(
        ([t, cols]) => `missing columns in ${t}: ${cols.join(", ")}`
      ),
      ...result.errors,
    ];
    throw new Error(
      `Schema verification failed – database out of sync: ${reasons.join("; ")}`
    );
  }
}

// ---------------------------------------------------------------------------
// Dynamic poller throttle parameters (#265)
// ---------------------------------------------------------------------------

export interface PollerThrottleState {
  currentIntervalMs: number;
  lastProcessedEventCount: number;
  idleCycles: number;
  lastLoadAdjustmentAt: number;
}

const BASE_POLL_INTERVAL_MS = parseInt(
  process.env.POLL_INTERVAL_MS || "15000",
  10,
);
const MIN_POLL_INTERVAL_MS = parseInt(
  process.env.POLLER_MIN_INTERVAL_MS || "5000",
  10,
);
const MAX_POLL_INTERVAL_MS = parseInt(
  process.env.POLLER_MAX_INTERVAL_MS || "60000",
  10,
);
const IDLE_MULTIPLIER = parseInt(
  process.env.POLLER_IDLE_MULTIPLIER || "2",
  10,
);
const IDLE_THRESHOLD_CYCLES = parseInt(
  process.env.POLLER_IDLE_THRESHOLD || "3",
  10,
);
const LOAD_DECREASE_FACTOR = parseFloat(
  process.env.POLLER_LOAD_DECREASE_FACTOR || "0.5",
);

let pollerThrottleState: PollerThrottleState = {
  currentIntervalMs: BASE_POLL_INTERVAL_MS,
  lastProcessedEventCount: 0,
  idleCycles: 0,
  lastLoadAdjustmentAt: Date.now(),
};

/**
 * Get the current poller throttle state (read-only snapshot).
 */
export function getPollerThrottleState(): PollerThrottleState {
  return { ...pollerThrottleState };
}

/**
 * Reset poller throttle state to defaults (useful for tests).
 */
export function resetPollerThrottleState(): void {
  pollerThrottleState = {
    currentIntervalMs: BASE_POLL_INTERVAL_MS,
    lastProcessedEventCount: 0,
    idleCycles: 0,
    lastLoadAdjustmentAt: Date.now(),
  };
}

/**
 * Adjust poller interval based on processing load.
 * Called after each poll cycle with the number of events processed.
 * When idle (no events), the interval increases up to MAX_POLL_INTERVAL_MS.
 * When under load (events processed), the interval decreases toward MIN_POLL_INTERVAL_MS.
 */
export function adjustPollerInterval(
  processedEventCount: number,
): PollerThrottleState {
  const state = pollerThrottleState;
  state.lastProcessedEventCount = processedEventCount;

  if (processedEventCount === 0) {
    state.idleCycles += 1;
    if (state.idleCycles >= IDLE_THRESHOLD_CYCLES) {
      state.currentIntervalMs = Math.min(
        state.currentIntervalMs * IDLE_MULTIPLIER,
        MAX_POLL_INTERVAL_MS,
      );
    }
  } else {
    state.idleCycles = 0;
    state.currentIntervalMs = Math.max(
      MIN_POLL_INTERVAL_MS,
      Math.floor(state.currentIntervalMs * LOAD_DECREASE_FACTOR),
    );
  }

  state.lastLoadAdjustmentAt = Date.now();
  return { ...state };
}

/**
 * Get the current effective poll interval in milliseconds.
 */
export function getCurrentPollIntervalMs(): number {
  return pollerThrottleState.currentIntervalMs;
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

/**
 * Atomically update the last indexed ledger inside a transaction.
 * This ensures data consistency when multiple operations need to coordinate
 * on the ledger pointer update.
 */
export function setLastIndexedLedger(seq: number) {
  const db = getDb();
  const updateTransaction = db.transaction(() => {
    const stmt = db.prepare(
      "UPDATE indexer_state SET value = ? WHERE key = 'last_ledger_sequence'"
    );
    stmt.run(seq.toString());
  });
  updateTransaction();
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
export async function getJobsByWallet(
  address: string,
  page: number = 1,
  limit: number = 10,
): Promise<PaginatedJobs> {
  const safePage = Math.max(1, page);
  const safeLimit = Math.max(1, limit);
  const cacheKey = `${address.trim().toLowerCase()}::${safePage}::${safeLimit}`;

  const cachedResult = jobsByWalletCache.get<PaginatedJobs>(cacheKey);
  if (cachedResult !== undefined) {
    return cachedResult;
  }

  const inFlightResult = inFlightJobsByWalletRequests.get(cacheKey);
  if (inFlightResult) {
    return await inFlightResult;
  }

  const pendingResult = (async () => {
    const db = getDb();
    const offset = (safePage - 1) * safeLimit;

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
        address, address, address,
        address, address, address,
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

    const result = { jobs, total, page: safePage, limit: safeLimit };
    jobsByWalletCache.set(cacheKey, result);
    return result;
  })();

  inFlightJobsByWalletRequests.set(cacheKey, pendingResult);

  try {
    return await pendingResult;
  } finally {
    inFlightJobsByWalletRequests.delete(cacheKey);
  }
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
