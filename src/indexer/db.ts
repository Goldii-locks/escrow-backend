import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import NodeCache from "node-cache";
import logger from "../utils/logger.js";
import {
  getSqliteSchemaManagerFailureMonitor,
} from "./sqlite_schema_manager.js";

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

/**
 * Index names used by the indexer_runner execution loop – validated via
 * EXPLAIN QUERY PLAN (#250).
 */
export const INDEXER_RUNNER_INDEXES = {
  monitoredContractsActive: "idx_monitored_contracts_active",
  eventsCreatedAt: "idx_events_created_at",
} as const;

/** Index names created by the schema-manager migration (#259). */
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
  {
    version: 5,
    description: "add sqlite_schema_manager lookup indexes (#259)",
    up: `
      CREATE INDEX IF NOT EXISTS idx_monitored_contracts_active
        ON monitored_contracts (active);

      CREATE INDEX IF NOT EXISTS idx_events_created_at
        ON events (created_at);

      CREATE INDEX IF NOT EXISTS idx_events_contract_type_ledger
        ON events (contract_id, event_type, ledger_sequence);
    `,
  },
  {
    version: 6,
    description: "add sqlite_vacuum_cleaner lookup indexes (#344)",
    up: `
      CREATE INDEX IF NOT EXISTS idx_events_created_at
        ON events (created_at);

      CREATE INDEX IF NOT EXISTS idx_events_ledger_sequence
        ON events (ledger_sequence);

      CREATE INDEX IF NOT EXISTS idx_events_created_at_ledger
        ON events (created_at, ledger_sequence);

      CREATE INDEX IF NOT EXISTS idx_events_ledger_created_at
        ON events (ledger_sequence, created_at);
    `,
  },
  {
    version: 7,
    description: "add database_writer_pool write-path lookup indexes (#326)",
    up: `
      CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_webhook_url
        ON webhook_subscriptions (webhook_url);
    `,
  },
  {
    version: 8,
    description: "add event_type_filter lookup indexes (#276)",
    // The topic filter groups and filters by event_type. Migration 3 indexed
    // (contract_id, event_type), which cannot serve a bare event_type
    // predicate because event_type is not the leading column.
    up: `
      CREATE INDEX IF NOT EXISTS idx_events_event_type
        ON events (event_type);

      CREATE INDEX IF NOT EXISTS idx_events_contract_event_type
        ON events (contract_id, event_type);
    `,
  },
];

/** Index names created by the SQLite schema manager lookup-index migration (#259). */
/**
 * Migration versions this build ships, ascending. Callers compare these
 * against `schema_migrations` to detect a database that is behind the code.
 */
export function getShippedMigrationVersions(): number[] {
  return MIGRATIONS.map((migration) => migration.version).sort((a, b) => a - b);
}

/** Index names created by the version-5 migration (#259), for test assertions. */
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
 */
export function runMigrations(
  retryConfig: Partial<SchemaRetryConfig> = {},
): void {
  const monitor = getSqliteSchemaManagerFailureMonitor();
  monitor.checkStall();
  const startedAt = performance.now();
  let failureRecorded = false;

  try {
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
      // Transient SQLite failures (locked/busy database) are retried with
      // backoff; the savepoint means a failed attempt leaves nothing behind.
      withSchemaRetrySync(
        applyMigration,
        retryConfig,
        `migration_${migration.version}`,
      );
      logger.info("Migration applied", { version: migration.version });
    } catch (err) {
      logger.error("Migration failed – rolled back", {
        version: migration.version,
        error: err instanceof Error ? err.message : String(err),
      });
      monitor.recordFailure("migration", {
        error: err instanceof Error ? err.message : String(err),
        version: migration.version,
        description: migration.description,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      failureRecorded = true;
      throw err;
    }
  }
  });

    runAll();
    monitor.recordSuccess();
  } catch (err) {
    // A bootstrap failure never reached the per-migration handler above.
    if (!failureRecorded) {
      monitor.recordFailure("bootstrap", {
        error: err instanceof Error ? err.message : String(err),
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    }
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

/**
 * Index names created by the schema manager migrations. Exported so modules
 * and tests can assert the exact lookup indexes the schema manager relies on
 * without hardcoding names (#259).
 */
export const SCHEMA_MANAGER_INDEXES = [
  "idx_events_contract_id",
  "idx_events_ledger_sequence",
  "idx_events_contract_ledger",
  "idx_events_contract_type",
  "idx_webhook_subscriptions_contract",
  "idx_events_ledger_event_type",
  "idx_monitored_contracts_active",
  "idx_events_created_at",
  "idx_events_contract_type_ledger",
] as const;

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
 * Wrapped in a transaction so concurrent writes never leave partial state.
 */
export function registerContract(contractId: string, label?: string): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO monitored_contracts (contract_id, label, active)
       VALUES (?, ?, 1)
       ON CONFLICT(contract_id) DO UPDATE SET
         active = 1,
         label = COALESCE(excluded.label, monitored_contracts.label)`
    ).run(contractId, label ?? null);
  });
  tx();
}

/**
 * Marks a contract inactive so it's excluded from getActiveContractIds()
 * without deleting its historical event data.
 * Wrapped in a transaction so concurrent writes never leave partial state.
 */
export function deregisterContract(contractId: string): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE monitored_contracts SET active = 0 WHERE contract_id = ?"
    ).run(contractId);
  });
  tx();
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
 * Checks whether an event with the given (contract_id, ledger_sequence,
 * event_type) already exists - the exact composite key the
 * UNIQUE(contract_id, ledger_sequence, event_type) constraint on `events`
 * enforces (see MIGRATIONS v1). insertEvent()/insertEventBatch() rely on
 * INSERT OR IGNORE for the actual write path (unchanged), so this constraint
 * check normally happens implicitly inside SQLite and isn't independently
 * observable. This lookup is exposed as its own query so the duplicate-check
 * path can be measured and EXPLAIN QUERY PLAN'd directly - it reuses the
 * existing sqlite_autoindex_events_1 index that comes from the UNIQUE
 * constraint; no new index is introduced.
 */
export function isDuplicateEvent(
  contractId: string,
  ledgerSequence: number,
  eventType: string
): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM events
       WHERE contract_id = ? AND ledger_sequence = ? AND event_type = ?
       LIMIT 1`
    )
    .get(contractId, ledgerSequence, eventType);
  return row !== undefined;
}

/**
 * Insert a single event row.  For atomic batch inserts use insertEventBatch().
 * Wrapped in a transaction so concurrent writes never leave partial state.
 */
export function insertEvent(
  contractId: string,
  eventType: string,
  ledgerSequence: number,
  timestamp: number,
  dataJson: string
): boolean {
  const db = getDb();
  const tx = db.transaction(() => {
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
  });
  return tx();
}

export interface EventRow {
  contractId: string;
  eventType: string;
  ledgerSequence: number;
  timestamp: number;
  dataJson: string;
}

/**
 * Emit a sqlite_schema_manager poll diagnostics debug log. Always includes
 * elapsedMs so log-based validation can assert timing fields are present (#261).
 */
export function logSchemaManagerPollDiagnostics(
  operation: string,
  startedAtMs: number,
  payloadSizeBytes: number,
): void {
  const elapsedMs = Date.now() - startedAtMs;
  logger.debug(
    `sqlite_schema_manager poll diagnostics operation=${operation} elapsedMs=${elapsedMs} payloadSizeBytes=${payloadSizeBytes}`,
    { operation, elapsedMs, payloadSizeBytes },
  );
}

/**
 * Atomically insert a batch of events AND advance the ledger pointer.
 * If any insertion fails the entire batch and the ledger update are rolled back,
 * so the indexer pointer never advances past un-committed data (#84).
 */
export function insertEventBatch(events: EventRow[], newLedger: number): void {
  const db = getDb();
  const startedAt = Date.now();

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

  logSchemaManagerPollDiagnostics(
    "insertEventBatch",
    startedAt,
    Buffer.byteLength(JSON.stringify(events), "utf8"),
  );
}

/**
 * Insert a batch of events WITHOUT touching the live indexer_state ledger
 * pointer. Used for custom historical event imports (event_type_filter's
 * dynamic start/end ledger support) so a backfill over an arbitrary past
 * range can never advance or rewind last_ledger_sequence - only the live
 * poller (insertEventBatch, driven strictly by lastLedger+1..currentLedger)
 * is allowed to move that pointer. Rows still go through INSERT OR IGNORE
 * against the same UNIQUE(contract_id, ledger_sequence, event_type)
 * constraint, so re-running a historical import is idempotent exactly like
 * the live poller.
 *
 * Returns the number of rows actually inserted (excludes rows ignored as
 * duplicates).
 *
 * Superseded by the range-validating overload defined later in this file,
 * which every caller uses.
 */

// ---------------------------------------------------------------------------
// In-memory event queue locks for concurrent inserts (#260)
// ---------------------------------------------------------------------------
// Concurrent RPC notifications routinely carry the same event more than once
// (retried pages, overlapping poll windows, several producers in one
// process). insertEvent / insertEventBatch already rely on INSERT OR IGNORE +
// the UNIQUE constraint to keep the events table itself duplicate-free, but
// two async callers racing on the same event identity still both perform the
// (redundant) insert work concurrently. These locked wrappers serialize per
// event identity – keyed on contract_id|ledger_sequence|event_type – so
// exactly one caller does the work for a given event; unrelated events still
// persist concurrently.

const eventInsertLockTails = new Map<string, Promise<void>>();

/** Optional hook used by tests to observe/gate lock acquisition (#260). */
let eventInsertLockHookForTests: ((key: string) => Promise<void>) | null = null;

function eventInsertLockKey(
  contractId: string,
  ledgerSequence: number,
  eventType: string
): string {
  return `${contractId}:${ledgerSequence}:${eventType}`;
}

/** Test helper – drop all in-memory insert locks between cases. */
export function resetEventInsertLocksForTests(): void {
  eventInsertLockTails.clear();
  eventInsertLockHookForTests = null;
}

/** Test helper – observe or gate lock acquisition in concurrency tests. */
export function setEventInsertLockHookForTests(
  hook: ((key: string) => Promise<void>) | null
): void {
  eventInsertLockHookForTests = hook;
}

/** Event identities currently locked/queued – exposed for concurrency assertions. */
export function getEventInsertLockCount(): number {
  return eventInsertLockTails.size;
}

async function withEventInsertLock<T>(
  key: string,
  fn: () => T | Promise<T>
): Promise<T> {
  const previous = eventInsertLockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate, () => gate);
  eventInsertLockTails.set(key, tail);

  try {
    await previous.catch(() => undefined);
    if (eventInsertLockHookForTests) {
      await eventInsertLockHookForTests(key);
    }
    return await fn();
  } finally {
    release();
    if (eventInsertLockTails.get(key) === tail) {
      eventInsertLockTails.delete(key);
    }
  }
}

async function acquireEventLocksInOrder(
  keys: string[],
  fn: () => void
): Promise<void> {
  if (keys.length === 0) {
    fn();
    return;
  }
  const [head, ...tail] = keys;
  await withEventInsertLock(head, () => acquireEventLocksInOrder(tail, fn));
}

/**
 * Lock-protected variant of insertEvent for concurrent async notification
 * producers (#260). Serializes calls that share the same (contract_id,
 * ledger_sequence, event_type) identity, so overlapping notifications for the
 * same event cannot race each other into duplicate work.
 */
export async function insertEventLocked(
  contractId: string,
  eventType: string,
  ledgerSequence: number,
  timestamp: number,
  dataJson: string
): Promise<boolean> {
  const key = eventInsertLockKey(contractId, ledgerSequence, eventType);
  return withEventInsertLock(key, () =>
    insertEvent(contractId, eventType, ledgerSequence, timestamp, dataJson)
  );
}

/**
 * Lock-protected variant of insertEventBatch (#260). Acquires the lock for
 * every distinct event identity in the batch, in sorted order, before running
 * the batch transaction – so a concurrent insertEventLocked /
 * insertEventBatchLocked call sharing an identity waits its turn.
 */
export async function insertEventBatchLocked(
  events: EventRow[],
  newLedger: number
): Promise<void> {
  const keys = [
    ...new Set(
      events.map((ev) =>
        eventInsertLockKey(ev.contractId, ev.ledgerSequence, ev.eventType)
      )
    ),
  ].sort();

  await acquireEventLocksInOrder(keys, () => {
    insertEventBatch(events, newLedger);
  });
}

/**
 * Insert a batch of events WITHOUT touching the live indexer_state ledger
 * pointer. Used for custom historical event imports (event_type_filter's
 * dynamic start/end ledger support) so a backfill over an arbitrary past
 * range can never advance or rewind last_ledger_sequence - only the live
 * poller (insertEventBatch, driven strictly by lastLedger+1..currentLedger)
 * is allowed to move that pointer. Rows still go through INSERT OR IGNORE
 * against the same UNIQUE(contract_id, ledger_sequence, event_type)
 * constraint, so re-running a historical import is idempotent exactly like
 * the live poller.
 *
 * Returns the number of rows actually inserted (excludes rows ignored as
 * duplicates).
 *
 * Superseded by the range-validating overload defined later in this file,
 * which every caller uses.
 */

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

/**
 * Add a per-contract webhook subscription. Runs INSERT + SELECT inside a
 * single transaction so the returned row always reflects what was just
 * committed, even under concurrent writes.
 */
export function addSubscription(
  contractId: string,
  webhookUrl: string,
  eventTypes: string[]
): WebhookSubscription {
  const db = getDb();

  const addTx = db.transaction(() => {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO webhook_subscriptions
      (contract_id, webhook_url, event_types)
      VALUES (?, ?, ?)
    `);
    stmt.run(contractId, webhookUrl, JSON.stringify(eventTypes));
    return db
      .prepare("SELECT * FROM webhook_subscriptions WHERE contract_id = ? AND webhook_url = ?")
      .get(contractId, webhookUrl) as WebhookSubscription;
  });

  try {
    return addTx();
  } catch (err) {
    logger.error("addSubscription failed – transaction rolled back", {
      contractId,
      webhookUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Remove a per-contract webhook subscription.
 * Wrapped in a transaction so concurrent writes never leave partial state.
 */
export function removeSubscription(contractId: string, webhookUrl: string): boolean {
  const db = getDb();

  const removeTx = db.transaction(() => {
    const result = db
      .prepare("DELETE FROM webhook_subscriptions WHERE contract_id = ? AND webhook_url = ?")
      .run(contractId, webhookUrl);
    return result.changes > 0;
  });

  try {
    return removeTx();
  } catch (err) {
    logger.error("removeSubscription failed – transaction rolled back", {
      contractId,
      webhookUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
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

// ---------------------------------------------------------------------------
// Dynamic historical sync ranges for custom event imports (#263)
// ---------------------------------------------------------------------------
// Lets callers (backfill scripts, admin tooling, tests) hand sqlite_schema_manager
// an arbitrary, explicit start/end ledger range for a one-off historical import,
// with the range validated up front and the live `last_ledger_sequence` pointer
// left untouched unless the caller explicitly opts in to advancing it.

export class HistoricalRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoricalRangeError";
  }
}

export interface HistoricalLedgerRange {
  startLedger: number;
  endLedger: number;
}

function isValidLedgerValue(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 1
  );
}

/**
 * Validate an inclusive [startLedger, endLedger] range for a custom
 * historical import. Throws HistoricalRangeError for non-integers, values
 * below 1, or start > end.
 */
export function validateHistoricalRange(
  startLedger: unknown,
  endLedger: unknown,
): HistoricalLedgerRange {
  if (!isValidLedgerValue(startLedger)) {
    throw new HistoricalRangeError(
      `start ledger must be a positive integer, received ${String(startLedger)}`,
    );
  }
  if (!isValidLedgerValue(endLedger)) {
    throw new HistoricalRangeError(
      `end ledger must be a positive integer, received ${String(endLedger)}`,
    );
  }
  if (startLedger > endLedger) {
    throw new HistoricalRangeError(
      `start ledger must not exceed end ledger (start=${startLedger}, end=${endLedger})`,
    );
  }
  return { startLedger, endLedger };
}

export interface InsertHistoricalEventBatchOptions {
  /** Advance indexer_state.last_ledger_sequence to endLedger once the import commits. */
  advanceLivePointer?: boolean;
}

export interface InsertHistoricalEventBatchResult {
  inserted: number;
  range: HistoricalLedgerRange;
}

/**
 * Atomically insert a batch of events for a custom historical range.
 *
 * Unlike insertEventBatch (used by the live poller), this never advances the
 * live ledger pointer unless advanceLivePointer is explicitly requested, and
 * it rejects any event whose ledger_sequence falls outside the declared
 * range so a mistyped range can't silently import the wrong window.
 */
export function insertHistoricalEventBatch(
  events: EventRow[],
  range: { startLedger: unknown; endLedger: unknown },
  options: InsertHistoricalEventBatchOptions = {},
): InsertHistoricalEventBatchResult {
  const validRange = validateHistoricalRange(range.startLedger, range.endLedger);

  for (const ev of events) {
    if (
      ev.ledgerSequence < validRange.startLedger ||
      ev.ledgerSequence > validRange.endLedger
    ) {
      throw new HistoricalRangeError(
        `event ledger_sequence ${ev.ledgerSequence} is outside the declared range ` +
          `[${validRange.startLedger}, ${validRange.endLedger}]`,
      );
    }
  }

  const db = getDb();
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO events
    (contract_id, event_type, ledger_sequence, timestamp, data_json)
    VALUES (?, ?, ?, ?, ?)
  `);

  const importTransaction = db.transaction(() => {
    let inserted = 0;
    for (const ev of events) {
      const result = insertStmt.run(
        ev.contractId,
        ev.eventType,
        ev.ledgerSequence,
        ev.timestamp,
        ev.dataJson,
      );
      if (result.changes > 0) inserted += 1;
    }

    if (options.advanceLivePointer) {
      const current = getLastIndexedLedger();
      if (validRange.endLedger > current) {
        db.prepare(
          "UPDATE indexer_state SET value = ? WHERE key = 'last_ledger_sequence'",
        ).run(validRange.endLedger.toString());
      }
    }

    return inserted;
  });

  const inserted = importTransaction();
  logger.info("sqlite_schema_manager historical range imported", {
    startLedger: validRange.startLedger,
    endLedger: validRange.endLedger,
    inserted,
    advanceLivePointer: options.advanceLivePointer ?? false,
  });

  return { inserted, range: validRange };
}

export interface HistoricalEventCounts {
  totalEvents: number;
  eventsByType: Record<string, number>;
}

/**
 * Assert-friendly summary of how many events are indexed for a given ledger
 * range, broken down by event type. Used to validate that a custom
 * historical import indexed the expected block event counts.
 */
export function getHistoricalEventCounts(
  startLedger: unknown,
  endLedger: unknown,
): HistoricalEventCounts {
  const validRange = validateHistoricalRange(startLedger, endLedger);
  const db = getDb();

  const totalRow = db
    .prepare(
      `SELECT COUNT(*) as count FROM events
       WHERE ledger_sequence >= ? AND ledger_sequence <= ?`,
    )
    .get(validRange.startLedger, validRange.endLedger) as { count: number };

  const typeRows = db
    .prepare(
      `SELECT event_type, COUNT(*) as count FROM events
       WHERE ledger_sequence >= ? AND ledger_sequence <= ?
       GROUP BY event_type`,
    )
    .all(validRange.startLedger, validRange.endLedger) as Array<{
    event_type: string;
    count: number;
  }>;

  const eventsByType: Record<string, number> = {};
  for (const row of typeRows) {
    eventsByType[row.event_type] = row.count;
  }

  return { totalEvents: totalRow.count, eventsByType };
}
