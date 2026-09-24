import { Server } from "@stellar/stellar-sdk/rpc";
import { scValToNative } from "@stellar/stellar-sdk";
import { insertEvent, type EventRow } from "./db.js";
import {
  LedgerRangeValidationError,
  chunkLedgerRange,
  eventIdentityKey,
  resolveHistoricalLedgerRange,
  type LedgerRange,
} from "./ledger-range-tracker.js";
import logger from "../utils/logger.js";

/**
 * RpcPollerClient wraps the Stellar RPC Server with exponential backoff retry
 * logic for transient failures (timeouts, connection errors, rate limits).
 *
 * The backoff strategy doubles the delay on each retry up to a configurable
 * ceiling, then resets on success.
 */

export interface RpcRetryConfig {
  /** Maximum number of retry attempts per call (default: 5) */
  maxRetries: number;
  /** Initial delay in ms after first failure (default: 1000) */
  initialBackoffMs: number;
  /** Multiplier applied to backoff on each consecutive failure (default: 2) */
  backoffMultiplier: number;
  /** Ceiling delay in ms (default: 30000) */
  maxBackoffMs: number;
}

const DEFAULT_CONFIG: RpcRetryConfig = {
  maxRetries: 5,
  initialBackoffMs: 1000,
  backoffMultiplier: 2,
  maxBackoffMs: 30_000,
};

/** Retryable error patterns for RPC connection issues. */
const RETRYABLE_PATTERNS = [
  "timeout",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "socket hang up",
  "network",
  "status 429",
  "status 503",
  "status 502",
  "request timeout",
  "connect timeout",
];

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return RETRYABLE_PATTERNS.some((p) => msg.includes(p.toLowerCase()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute the backoff delay for a given attempt number.
 * attempt 0 → initialBackoffMs
 * attempt 1 → initialBackoffMs * multiplier
 * etc., capped at maxBackoffMs.
 */
export function computeBackoffMs(
  attempt: number,
  config: Pick<RpcRetryConfig, "initialBackoffMs" | "backoffMultiplier" | "maxBackoffMs">
): number {
  return Math.min(
    config.initialBackoffMs * Math.pow(config.backoffMultiplier, attempt),
    config.maxBackoffMs
  );
}

/**
 * Execute an async operation with exponential backoff retry.
 * Returns the result on success, or throws after exhausting retries.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RpcRetryConfig> = {},
  context: string = "rpc_call"
): Promise<T> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (!isRetryableError(lastError) || attempt >= cfg.maxRetries) {
        throw lastError;
      }

      const delay = computeBackoffMs(attempt, cfg);
      logger.warn(`${context} failed, retrying`, {
        attempt: attempt + 1,
        maxRetries: cfg.maxRetries,
        backoffMs: delay,
        error: lastError.message,
      });
      await sleep(delay);
    }
  }

  throw lastError;
}


// ---------------------------------------------------------------------------
// Dynamic historical sync ranges (#272)
// ---------------------------------------------------------------------------

/** Default number of ledgers fetched per historical page. */
export const DEFAULT_RPC_HISTORICAL_PAGE_SIZE = 100;

/** Default `limit` sent to a single RPC getEvents call. */
export const DEFAULT_RPC_EVENTS_LIMIT = 100;

/** Safety valve so a misbehaving cursor can never spin forever on one page. */
export const MAX_RPC_REQUESTS_PER_PAGE = 1000;

/**
 * Minimal surface of the Stellar RPC Server used by this client. Declaring it
 * structurally lets tests inject a stub server without a live RPC endpoint.
 */
export interface RpcServerLike {
  getLatestLedger(): Promise<{ sequence: number }>;
  getEvents(params: any): Promise<any>;
}

export interface RpcGetEventsParams {
  /** Inclusive first ledger. Mutually exclusive with `cursor`. */
  startLedger?: number;
  /** Paging cursor returned by a previous getEvents call. */
  cursor?: string;
  filters?: any[];
  limit?: number;
}

/** Number of events indexed for a single ledger ("block"). */
export interface LedgerEventCount {
  ledgerSequence: number;
  eventCount: number;
}

export interface RpcHistoricalRangeOptions {
  /** Inclusive custom start ledger. Falls back to env / defaults. */
  startLedger?: number;
  /** Inclusive custom end ledger. Falls back to env / defaults. */
  endLedger?: number;
  /** Fallback start when neither an explicit nor an env start is set. */
  defaultStart?: number;
  /** Fallback end when neither an explicit nor an env end is set. */
  defaultEnd?: number;
  /** Contract/topic filters forwarded verbatim to getEvents. */
  filters?: any[];
  /** Ledgers per fetch page (default: client `historicalPageSize`). */
  pageSize?: number;
  /** Max events requested per RPC call (default: client `eventsLimit`). */
  limit?: number;
}

export interface RpcHistoricalFetchResult {
  range: LedgerRange;
  pages: LedgerRange[];
  /** Raw RPC events, de-duplicated and clamped to the resolved range. */
  events: any[];
  eventCount: number;
  /** Per-ledger event counts, ascending by ledger sequence. */
  ledgerEventCounts: LedgerEventCount[];
  /** Number of getEvents calls issued (pages + cursor continuations). */
  requestCount: number;
  latestLedger?: number;
  elapsedMs: number;
}

export interface RpcHistoricalSyncResult extends RpcHistoricalFetchResult {
  /** Rows accepted into the memory queue (post de-duplication). */
  queuedCount: number;
  /** Rows actually written by the persist function. */
  insertedCount: number;
  /** Rows skipped as already queued, already persisted, or already in the DB. */
  duplicateCount: number;
}

function validatePositiveInt(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new LedgerRangeValidationError(
      `${name} must be a positive integer, received ${String(value)}`
    );
  }
  return value;
}

/** Read a contract id off a raw RPC event, tolerating both SDK and plain shapes. */
function readContractId(raw: any): string {
  const contractId = raw?.contractId;
  if (typeof contractId === "string") return contractId;
  if (contractId && typeof contractId.contractId === "function") {
    try {
      return String(contractId.contractId());
    } catch {
      return "";
    }
  }
  return "";
}

/** Read the event type from `topic[0]`, tolerating both ScVal and plain shapes. */
function readEventType(raw: any): string {
  const topic = raw?.topic?.[0];
  if (typeof topic === "string") return topic;
  if (topic === undefined || topic === null) return "unknown";
  try {
    return String(scValToNative(topic));
  } catch {
    return "unknown";
  }
}

/** Stable identity for a raw RPC event, used to drop repeats across pages. */
function rpcEventKey(raw: any): string {
  if (typeof raw?.id === "string" && raw.id) return raw.id;
  if (typeof raw?.pagingToken === "string" && raw.pagingToken) {
    return raw.pagingToken;
  }
  return `${readContractId(raw)}|${String(raw?.ledger)}|${readEventType(raw)}`;
}

/**
 * Convert a raw RPC event into the `EventRow` shape used by the indexer.
 * Mirrors the mapping performed by the live poller so historical imports and
 * live polls produce identical rows.
 */
export function mapRpcEventToRow(
  raw: any,
  fallbackContractId: string = ""
): EventRow {
  return {
    contractId: readContractId(raw) || fallbackContractId,
    eventType: readEventType(raw),
    ledgerSequence: Number(raw?.ledger),
    timestamp: raw?.ledgerClosedAt
      ? Math.floor(new Date(raw.ledgerClosedAt).getTime() / 1000)
      : Math.floor(Date.now() / 1000),
    dataJson: JSON.stringify(raw?.value ?? null),
  };
}

/**
 * Aggregate per-ledger ("block") event counts, ascending by ledger sequence.
 * Callers assert against this to prove a custom range indexed every block.
 */
export function countEventsByLedger(
  events: Array<{ ledger?: unknown; ledgerSequence?: unknown }>
): LedgerEventCount[] {
  const counts = new Map<number, number>();
  for (const event of events) {
    const raw = event?.ledgerSequence ?? event?.ledger;
    const ledger = Number(raw);
    if (!Number.isFinite(ledger)) continue;
    counts.set(ledger, (counts.get(ledger) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ledgerSequence, eventCount]) => ({ ledgerSequence, eventCount }));
}

// ---------------------------------------------------------------------------
// In-memory event queue with per-event locks (#269)
// ---------------------------------------------------------------------------

/** Default ceiling on rows held in memory before an overflow is raised. */
export const DEFAULT_RPC_EVENT_QUEUE_MAX_SIZE = 10_000;

export class RpcEventQueueOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcEventQueueOverflowError";
  }
}

/**
 * Persist a single event row. Returns true when a new row was written and
 * false when the store already held it. Defaults to `insertEvent` (an
 * `INSERT OR IGNORE` against the events table).
 */
export type EventPersistFn = (event: EventRow) => boolean | Promise<boolean>;

export interface RpcEventQueueOptions {
  persist?: EventPersistFn;
  maxQueueSize?: number;
  /** Instance name used in queue diagnostics. */
  name?: string;
}

export interface RpcEventEnqueueResult {
  queuedCount: number;
  duplicateCount: number;
}

export interface RpcEventFlushResult {
  processedCount: number;
  insertedCount: number;
  duplicateCount: number;
}

export interface RpcEventSubmitResult {
  queuedCount: number;
  insertedCount: number;
  duplicateCount: number;
}

/**
 * Bounded in-memory queue that serializes event inserts per event identity.
 *
 * Concurrent RPC notifications routinely carry the same event (overlapping
 * poll windows, retried pages, several pollers in one process). Without a
 * lock, two callers can both observe "not indexed yet" and both insert. The
 * queue closes that window: every row is drained under a lock keyed on
 * `contractId|ledgerSequence|eventType`, and the persisted-key set is checked
 * inside that lock, so exactly one caller writes each event. Unrelated events
 * still persist concurrently.
 */
export class RpcEventQueue {
  readonly name: string;
  readonly maxQueueSize: number;

  private readonly persist: EventPersistFn;
  private readonly pending: EventRow[] = [];
  private readonly pendingKeys = new Set<string>();
  private readonly persistedKeys = new Set<string>();
  private readonly lockTails = new Map<string, Promise<void>>();
  private readonly heldLocks = new Set<string>();
  private queueMutex: Promise<void> = Promise.resolve();

  constructor(options: RpcEventQueueOptions = {}) {
    this.name = options.name ?? "rpc_poller_client";
    this.persist = options.persist ?? defaultPersistEvent;
    this.maxQueueSize = validatePositiveInt(
      "maxQueueSize",
      options.maxQueueSize ?? DEFAULT_RPC_EVENT_QUEUE_MAX_SIZE
    );
  }

  /** Rows currently waiting to be flushed. */
  get size(): number {
    return this.pending.length;
  }

  /** Event locks held right now – exposed for concurrency assertions. */
  get heldLockCount(): number {
    return this.heldLocks.size;
  }

  /** Distinct event identities this queue has already persisted. */
  get persistedKeyCount(): number {
    return this.persistedKeys.size;
  }

  hasPersisted(
    event: Pick<EventRow, "contractId" | "eventType" | "ledgerSequence">
  ): boolean {
    return this.persistedKeys.has(eventIdentityKey(event));
  }

  /** Drop all queue state. Intended for tests and process restarts. */
  reset(): void {
    this.pending.length = 0;
    this.pendingKeys.clear();
    this.persistedKeys.clear();
    this.lockTails.clear();
    this.heldLocks.clear();
    this.queueMutex = Promise.resolve();
  }

  /**
   * Serialize mutations of the queue structure itself, so concurrent
   * enqueue/flush callers never interleave a read and a write of `pending`.
   */
  private async withQueueMutex<T>(fn: () => T): Promise<T> {
    const previous = this.queueMutex;
    let release!: () => void;
    this.queueMutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      return fn();
    } finally {
      release();
    }
  }

  /**
   * Serialize work for one event identity. Unrelated keys run concurrently and
   * the lock is always released, including when `fn` throws.
   */
  private async withEventLock<T>(
    key: string,
    fn: () => Promise<T> | T
  ): Promise<T> {
    const previous = this.lockTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => gate,
      () => gate
    );
    this.lockTails.set(key, tail);

    try {
      await previous.catch(() => undefined);
      this.heldLocks.add(key);
      return await fn();
    } finally {
      this.heldLocks.delete(key);
      release();
      if (this.lockTails.get(key) === tail) {
        this.lockTails.delete(key);
      }
    }
  }

  /**
   * Queue rows for insertion, dropping any already queued or already
   * persisted. Throws `RpcEventQueueOverflowError` past `maxQueueSize`.
   */
  async enqueue(events: EventRow[]): Promise<RpcEventEnqueueResult> {
    return this.withQueueMutex(() => {
      let queuedCount = 0;
      let duplicateCount = 0;

      for (const event of events) {
        const key = eventIdentityKey(event);
        if (this.pendingKeys.has(key) || this.persistedKeys.has(key)) {
          duplicateCount++;
          continue;
        }
        if (this.pending.length >= this.maxQueueSize) {
          throw new RpcEventQueueOverflowError(
            `${this.name} event queue is full (maxQueueSize=${this.maxQueueSize})`
          );
        }
        this.pendingKeys.add(key);
        this.pending.push(event);
        queuedCount++;
      }

      return { queuedCount, duplicateCount };
    });
  }

  /** Drain the queue, persisting each row under its own event lock. */
  async flush(): Promise<RpcEventFlushResult> {
    let processedCount = 0;
    let insertedCount = 0;
    let duplicateCount = 0;

    for (;;) {
      const next = await this.withQueueMutex(() => this.pending.shift());
      if (!next) break;

      const key = eventIdentityKey(next);
      processedCount++;

      await this.withEventLock(key, async () => {
        try {
          if (this.persistedKeys.has(key)) {
            duplicateCount++;
            return;
          }
          const inserted = await this.persist(next);
          this.persistedKeys.add(key);
          if (inserted) {
            insertedCount++;
          } else {
            duplicateCount++;
          }
        } finally {
          this.pendingKeys.delete(key);
        }
      });
    }

    return { processedCount, insertedCount, duplicateCount };
  }

  /** Enqueue and flush in one step – the entry point for RPC notifications. */
  async submit(events: EventRow[]): Promise<RpcEventSubmitResult> {
    const enqueued = await this.enqueue(events);
    const flushed = await this.flush();

    const result: RpcEventSubmitResult = {
      queuedCount: enqueued.queuedCount,
      insertedCount: flushed.insertedCount,
      duplicateCount: enqueued.duplicateCount + flushed.duplicateCount,
    };

    logger.debug("rpc_poller_client event queue submit", {
      queue: this.name,
      submitted: events.length,
      ...result,
    });

    return result;
  }
}

function defaultPersistEvent(event: EventRow): boolean {
  return insertEvent(
    event.contractId,
    event.eventType,
    event.ledgerSequence,
    event.timestamp,
    event.dataJson
  );
}

export interface RpcPollerClientOptions extends Partial<RpcRetryConfig> {
  /** Ledgers per historical fetch page (default 100). */
  historicalPageSize?: number;
  /** Events requested per RPC call (default 100). */
  eventsLimit?: number;
  /** Override how queued rows are persisted (default: `insertEvent`). */
  persistEvent?: EventPersistFn;
  /** Ceiling on rows held in the memory queue. */
  maxQueueSize?: number;
  /** Override the raw-event to `EventRow` mapping. */
  mapEvent?: (raw: any) => EventRow;
  /** Inject a server stub instead of connecting to `rpcUrl`. */
  server?: RpcServerLike;
}

/**
 * RpcPollerClient wraps a Stellar RPC Server with retry logic for
 * getLatestLedger and getEvents calls, dynamic historical sync ranges (#272),
 * and a locked in-memory insert queue for concurrent notifications (#269).
 */
export class RpcPollerClient {
  private server: RpcServerLike;
  private config: RpcRetryConfig;
  private readonly historicalPageSize: number;
  private readonly eventsLimit: number;
  private readonly mapEvent: (raw: any) => EventRow;
  private readonly queue: RpcEventQueue;

  constructor(rpcUrl: string, options: RpcPollerClientOptions = {}) {
    this.server = options.server ?? new Server(rpcUrl);
    this.config = {
      maxRetries: options.maxRetries ?? DEFAULT_CONFIG.maxRetries,
      initialBackoffMs:
        options.initialBackoffMs ?? DEFAULT_CONFIG.initialBackoffMs,
      backoffMultiplier:
        options.backoffMultiplier ?? DEFAULT_CONFIG.backoffMultiplier,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULT_CONFIG.maxBackoffMs,
    };
    this.historicalPageSize = validatePositiveInt(
      "historicalPageSize",
      options.historicalPageSize ?? DEFAULT_RPC_HISTORICAL_PAGE_SIZE
    );
    this.eventsLimit = validatePositiveInt(
      "eventsLimit",
      options.eventsLimit ?? DEFAULT_RPC_EVENTS_LIMIT
    );
    this.mapEvent = options.mapEvent ?? ((raw: any) => mapRpcEventToRow(raw));
    this.queue = new RpcEventQueue({
      persist: options.persistEvent,
      maxQueueSize: options.maxQueueSize,
    });
  }

  /**
   * The underlying RPC server, for helpers that take a bare server and apply
   * their own retry policy (e.g. `fetchEventsWithRetry`). Going through
   * `getEvents()` instead would stack this client's retries on top of theirs.
   */
  get rpcServer(): RpcServerLike {
    return this.server;
  }

  async getLatestLedger(): Promise<{ sequence: number }> {
    return withRetry(
      () => this.server.getLatestLedger(),
      this.config,
      "getLatestLedger"
    );
  }

  async getEvents(params: RpcGetEventsParams): Promise<any> {
    return withRetry(
      () => this.server.getEvents(params),
      this.config,
      "getEvents"
    );
  }

  /** The memory queue backing concurrent event inserts (#269). */
  get eventQueue(): RpcEventQueue {
    return this.queue;
  }

  /**
   * Resolve an inclusive historical range from explicit values, then
   * `LEDGER_RANGE_START` / `LEDGER_RANGE_END`, then the supplied defaults.
   * Throws `LedgerRangeValidationError` on non-integers, values below 1, or
   * an inverted range.
   */
  resolveHistoricalRange(options: RpcHistoricalRangeOptions = {}): LedgerRange {
    return resolveHistoricalLedgerRange({
      startLedger: options.startLedger,
      endLedger: options.endLedger,
      defaultStart: options.defaultStart,
      defaultEnd: options.defaultEnd,
    });
  }

  /**
   * Fetch every event in a custom historical range.
   *
   * The range is validated, split into `pageSize` chunks, and each chunk is
   * walked with the RPC cursor until the page end is passed – so a range wider
   * than one RPC `limit` still yields every block's events exactly once.
   */
  async fetchEventRange(
    options: RpcHistoricalRangeOptions = {}
  ): Promise<RpcHistoricalFetchResult> {
    const started = performance.now();
    const range = this.resolveHistoricalRange(options);
    const pageSize = validatePositiveInt(
      "pageSize",
      options.pageSize ?? this.historicalPageSize
    );
    const limit = validatePositiveInt("limit", options.limit ?? this.eventsLimit);
    const pages = chunkLedgerRange(range, pageSize);
    const filters = options.filters ?? [];

    const events: any[] = [];
    const seen = new Set<string>();
    let requestCount = 0;
    let latestLedger: number | undefined;

    for (const page of pages) {
      let cursor: string | undefined;

      for (let request = 0; request < MAX_RPC_REQUESTS_PER_PAGE; request++) {
        const params: RpcGetEventsParams = { filters, limit };
        if (cursor) {
          params.cursor = cursor;
        } else {
          params.startLedger = page.startLedger;
        }

        const response = await this.getEvents(params);
        requestCount++;

        const batch: any[] = Array.isArray(response?.events)
          ? response.events
          : [];
        if (typeof response?.latestLedger === "number") {
          latestLedger = response.latestLedger;
        }

        // A short batch means the RPC has nothing left for this window; an
        // event past the page end means the rest are out of range too.
        let done = batch.length < limit;

        for (const raw of batch) {
          const ledger = Number(raw?.ledger);
          if (!Number.isFinite(ledger)) continue;
          if (ledger > page.endLedger) {
            done = true;
            continue;
          }
          if (ledger < page.startLedger) continue;

          const key = rpcEventKey(raw);
          if (seen.has(key)) continue;
          seen.add(key);
          events.push(raw);
        }

        const nextCursor = readNextCursor(response, batch);
        if (done || batch.length === 0 || !nextCursor || nextCursor === cursor) {
          break;
        }
        cursor = nextCursor;
      }
    }

    const elapsedMs = Math.max(0, performance.now() - started);
    const ledgerEventCounts = countEventsByLedger(events);

    logger.info("rpc_poller_client historical range fetched", {
      startLedger: range.startLedger,
      endLedger: range.endLedger,
      pageCount: pages.length,
      eventCount: events.length,
      requestCount,
      elapsedMs: Math.round(elapsedMs),
    });

    return {
      range,
      pages,
      events,
      eventCount: events.length,
      ledgerEventCounts,
      requestCount,
      latestLedger,
      elapsedMs,
    };
  }

  /**
   * Fetch a custom historical range and index it through the locked memory
   * queue, so a sync running alongside live polls cannot duplicate rows.
   */
  async syncHistoricalRange(
    options: RpcHistoricalRangeOptions = {}
  ): Promise<RpcHistoricalSyncResult> {
    const fetched = await this.fetchEventRange(options);
    const rows = fetched.events.map((raw) => this.mapEvent(raw));
    const submitted = await this.queue.submit(rows);

    logger.info("rpc_poller_client historical range indexed", {
      startLedger: fetched.range.startLedger,
      endLedger: fetched.range.endLedger,
      eventCount: fetched.eventCount,
      insertedCount: submitted.insertedCount,
      duplicateCount: submitted.duplicateCount,
    });

    return { ...fetched, ...submitted };
  }

  /**
   * Index event notifications received outside a range sync. Safe to call
   * concurrently: identical notifications collapse to a single insert (#269).
   */
  async submitEventNotifications(
    events: Array<EventRow | any>
  ): Promise<RpcEventSubmitResult> {
    const rows = events.map((event) =>
      isEventRow(event) ? event : this.mapEvent(event)
    );
    return this.queue.submit(rows);
  }

  /** Expose the underlying Server for callers that need raw access. */
  get underlyingServer(): RpcServerLike {
    return this.server;
  }
}

function isEventRow(value: any): value is EventRow {
  return (
    typeof value?.contractId === "string" &&
    typeof value?.eventType === "string" &&
    typeof value?.ledgerSequence === "number" &&
    typeof value?.dataJson === "string"
  );
}

/** Prefer the response cursor, falling back to the last event's paging token. */
function readNextCursor(response: any, batch: any[]): string | undefined {
  const last = batch[batch.length - 1];
  const candidate = response?.cursor ?? last?.pagingToken ?? last?.id;
  return typeof candidate === "string" && candidate ? candidate : undefined;
}
