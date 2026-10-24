import { Server } from "@stellar/stellar-sdk/rpc";
import type { Api } from "@stellar/stellar-sdk/rpc";
import { scValToNative } from "@stellar/stellar-sdk";
import {
  insertEventBatch,
  insertHistoricalEventBatch,
  getActiveContractIds,
  getActiveContractsWithPointers,
  updateContractPointer,
  registerContract,
  recordSkippedLedgerRange,
  adjustPollerInterval,
  getCurrentPollIntervalMs as getDbPollIntervalMs,
  resetPollerThrottleState,
  verifySchemaUpToDate,
  assertSchemaValid,
  type EventRow,
} from "./db.js";
import { RpcPollerClient } from "./rpc-poller-client.js";
import {
  IndexerRunnerFailureMonitor,
  adjustIndexerRunnerPollInterval,
} from "./indexer_runner.js";
import { deliverWebhooks } from "./webhook-delivery.js";
import { buildGetEventsRequest } from "./event_type_filter.js";
import { formatError } from "../utils/format-error.js";
import { config } from "../config.js";
import logger from "../utils/logger.js";

const RPC_URL =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";

// ---------------------------------------------------------------------------
// RPC exponential backoff retry (#249)
// ---------------------------------------------------------------------------
// All RPC calls in the indexer poll loop go through RpcPollerClient, which
// retries transient failures (timeouts, connection resets, rate limits, 5xx)
// with a doubling backoff up to maxRetries, then resets on success.
// Under test the backoff is collapsed to ~1ms: a rejected RPC mock would
// otherwise spend ~31s walking the production backoff curve before the poll
// reports failure, blowing past Jest's default timeout.
const IS_TEST_ENV = process.env.NODE_ENV === "test";

const rpcClient = new RpcPollerClient(RPC_URL, {
  maxRetries: config.indexerRpcMaxRetries,
  initialBackoffMs: config.indexerRpcInitialBackoffMs,
  backoffMultiplier: config.indexerRpcBackoffMultiplier,
  maxBackoffMs: config.indexerRpcMaxBackoffMs,
});

// ---------------------------------------------------------------------------
// Failure and stall tracking for the poll loop (#253, #271)
// ---------------------------------------------------------------------------
// Consecutive failures escalate to an alert once the threshold is reached, and
// a poll loop that stops succeeding for longer than the stall threshold is
// reported even while individual polls keep "working".

const failureMonitor = new IndexerRunnerFailureMonitor({
  name: "indexer_runner",
  failureThreshold: config.indexerRunnerFailureThreshold,
  stallThresholdMs: config.indexerRunnerStallThresholdMs,
});

export function getConsecutiveFailures(): number {
  return failureMonitor.getConsecutiveFailures();
}

export function getLastSuccessfulPollAt(): number | null {
  return failureMonitor.getLastSuccessfulAt();
}

export function resetFailureState(): void {
  failureMonitor.reset();
  resetPollDiagnosticsThrottle();
}

// ---------------------------------------------------------------------------
// Dynamic poll interval (#265)
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MIN_MS = config.pollIntervalMs;
const POLL_INTERVAL_MAX_MS = config.pollIntervalMaxMs;
const POLL_INTERVAL_BACKOFF = 2;

/**
 * Next poll delay given the current one and whether the last poll saw activity.
 *
 * Idle polls back off geometrically up to POLL_INTERVAL_MAX_MS; the first
 * active poll drops straight back to the minimum. Pure function so the backoff
 * curve can be reasoned about (and tested) without running the loop.
 */
export function nextPollIntervalMs(
  currentIntervalMs: number,
  sawActivity: boolean,
): number {
  if (sawActivity) return POLL_INTERVAL_MIN_MS;
  return Math.min(currentIntervalMs * POLL_INTERVAL_BACKOFF, POLL_INTERVAL_MAX_MS);
}

let currentPollIntervalMs = POLL_INTERVAL_MIN_MS;

/** The interval the poll loop is currently waiting between cycles. */
export function getCurrentPollIntervalMs(): number {
  return currentPollIntervalMs;
}

/**
 * Resolve an RPC event's close time to epoch seconds.
 *
 * Missing or unparseable `ledgerClosedAt` yields `null` (stored as NULL since
 * migration v9) — never the wall-clock time, so backfills can't stamp old
 * events with today's date, and invalid strings can't become NaN (#708).
 */
export function toEventTimestamp(ledgerClosedAt: unknown): number | null {
  if (typeof ledgerClosedAt !== "string" || ledgerClosedAt.trim() === "") {
    logger.warn("Indexer event missing ledgerClosedAt – storing NULL timestamp");
    return null;
  }
  const millis = new Date(ledgerClosedAt).getTime();
  if (!Number.isFinite(millis)) {
    logger.warn("Indexer event has invalid ledgerClosedAt – storing NULL timestamp", {
      ledgerClosedAt,
    });
    return null;
  }
  return Math.floor(millis / 1000);
}

/** Map an RPC event notification onto the row shape `events` stores. */
function toEventRow(event: any, fallbackContractId: string): EventRow {
  return {
    contractId: event.contractId?.contractId?.() ?? fallbackContractId,
    eventType: scValToNative(event.topic[0]) as string,
    ledgerSequence: event.ledger,
    timestamp: toEventTimestamp(event.ledgerClosedAt),
    dataJson: JSON.stringify(scValToNative(event.value)),
    eventId:
      typeof event.id === "string" && event.id
        ? event.id
        : typeof event.pagingToken === "string" && event.pagingToken
          ? event.pagingToken
          : undefined,
  };
}

// ---------------------------------------------------------------------------
// Poll diagnostics (#270)
// ---------------------------------------------------------------------------

const POLL_DIAGNOSTIC_LOG_MIN_INTERVAL_MS =
  config.pollDiagnosticLogMinIntervalMs;
let lastPollDiagnosticAt = 0;
let stallWindowReported = false;

interface StallWindow {
  elapsedMsSinceLastSuccess: number;
  stallThresholdMs: number;
}

/** Clear the diagnostics throttle so the next poll logs unconditionally. */
export function resetPollDiagnosticsThrottle(): void {
  lastPollDiagnosticAt = 0;
  stallWindowReported = false;
}

/**
 * One debug line per poll carrying duration and payload size.
 *
 * Only byte counts are logged, never the payload itself — event data carries
 * participant wallet addresses and amounts that have no business in a log.
 *
 * Throttled to at most one line per POLL_DIAGNOSTIC_LOG_MIN_INTERVAL_MS so a
 * fast poll loop cannot flood the log.
 */
function logPollDiagnostics(
  elapsedMs: number,
  batch: EventRow[],
  stall: StallWindow | null = null,
): void {
  const now = Date.now();

  // The first line carrying a stall window is new information, so it is never
  // throttled away; repeats of it are.
  const stallWindowIsNews = stall !== null && !stallWindowReported;

  if (
    !stallWindowIsNews &&
    POLL_DIAGNOSTIC_LOG_MIN_INTERVAL_MS > 0 &&
    lastPollDiagnosticAt > 0 &&
    now - lastPollDiagnosticAt < POLL_DIAGNOSTIC_LOG_MIN_INTERVAL_MS
  ) {
    return;
  }
  lastPollDiagnosticAt = now;
  if (stall !== null) stallWindowReported = true;

  const totalPayloadBytes = batch.reduce(
    (sum, row) => sum + Buffer.byteLength(row.dataJson, "utf8"),
    0,
  );
  const avgPayloadBytes =
    batch.length > 0 ? Math.round(totalPayloadBytes / batch.length) : 0;
  const rounded = Math.round(elapsedMs);

  const stallSegment = stall
    ? ` | Poller stall diagnostics elapsedMsSinceLastSuccess=${stall.elapsedMsSinceLastSuccess}` +
      ` stallThresholdMs=${stall.stallThresholdMs}`
    : "";

  logger.debug(
    `RPC getEvents diagnostics elapsedMs=${rounded} payloadSizeBytes=${totalPayloadBytes}` +
      stallSegment,
    {
      elapsedMs: rounded,
      payloadSizeBytes: totalPayloadBytes,
      totalPayloadBytes,
      avgPayloadBytes,
      eventCount: batch.length,
      ...(stall ?? {}),
    },
  );
}

// ---------------------------------------------------------------------------
// Historical range import (#254)
// ---------------------------------------------------------------------------

/** Upper bound on how many ledgers a single backfill may cover. */
export const MAX_LEDGERS_PER_IMPORT = config.maxLedgersPerImport;

const HISTORICAL_PAGE_SIZE = 100;

export interface HistoricalRangeValidation {
  valid: boolean;
  error?: string;
}

export interface HistoricalImportResult {
  eventsFound: number;
  eventsImported: number;
}

export async function getLatestLedgerSequence(): Promise<number> {
  return (await rpcClient.getLatestLedger()).sequence;
}

/**
 * Check a requested backfill window against the chain head and the per-import
 * ceiling. Pure, so callers can validate before opening any RPC connection.
 */
export function validateHistoricalRange(
  startLedger: number,
  endLedger: number,
  chainHeadLedger: number,
): HistoricalRangeValidation {
  if (!Number.isInteger(startLedger) || startLedger <= 0) {
    return { valid: false, error: "startLedger must be a positive integer" };
  }
  if (!Number.isInteger(endLedger) || endLedger <= 0) {
    return { valid: false, error: "endLedger must be a positive integer" };
  }
  if (startLedger > endLedger) {
    return { valid: false, error: "startLedger must be <= endLedger" };
  }
  if (endLedger > chainHeadLedger) {
    return {
      valid: false,
      error:
        `endLedger ${endLedger} does not exist yet – ` +
        `the chain head is ${chainHeadLedger}`,
    };
  }

  const span = endLedger - startLedger + 1;
  if (span > MAX_LEDGERS_PER_IMPORT) {
    return {
      valid: false,
      error:
        `range covers ${span} ledgers, exceeding the ` +
        `${MAX_LEDGERS_PER_IMPORT}-ledger maximum per import`,
    };
  }

  return { valid: true };
}

/**
 * Import a historical ledger window without disturbing the live poller.
 *
 * Rows go through `insertHistoricalEventBatch`, which keeps the live ledger
 * pointer where it is and relies on the same UNIQUE constraint as the poller —
 * so re-running an import is idempotent. Pages are followed by cursor until a
 * short page signals the range is fully collected.
 */
export async function fetchHistoricalEvents(
  startLedger: number,
  endLedger: number,
  contractId?: string,
  onProgress?: (result: HistoricalImportResult) => void,
): Promise<HistoricalImportResult> {
  const chainHead = (await rpcClient.getLatestLedger()).sequence;
  const validation = validateHistoricalRange(startLedger, endLedger, chainHead);
  if (!validation.valid) {
    throw new Error(`Invalid historical range: ${validation.error}`);
  }

  let contractIds: string[] = contractId ? [contractId] : getActiveContractIds();
  if (contractIds.length === 0 && process.env.CONTRACT_ID) {
    contractIds = [process.env.CONTRACT_ID];
  }

  let eventsFound = 0;
  let eventsImported = 0;
  let cursor: string | undefined;

  for (;;) {
    // Cursor mode supersedes the ledger window once paging has started; sending
    // both is rejected by the RPC.
    const params = cursor
      ? { cursor, limit: HISTORICAL_PAGE_SIZE }
      : { startLedger, endLedger, contractIds, limit: HISTORICAL_PAGE_SIZE };

    const page = await rpcClient.getEvents(params);
    const pageEvents: any[] = page?.events ?? [];
    if (pageEvents.length === 0) break;

    eventsFound += pageEvents.length;

    const batch: EventRow[] = pageEvents
      .map((event) => toEventRow(event, contractIds[0] ?? ""))
      .filter(
        (row) =>
          row.ledgerSequence >= startLedger && row.ledgerSequence <= endLedger,
      );

    if (batch.length > 0) {
      const result = await enqueueHistoricalEventInsert(batch, { startLedger, endLedger });
      eventsImported += result.inserted;
    }
    onProgress?.({ eventsFound, eventsImported });

    cursor = page?.cursor;
    if (pageEvents.length < HISTORICAL_PAGE_SIZE || !cursor) break;
  }

  logger.info("Historical import complete", {
    startLedger,
    endLedger,
    eventsFound,
    eventsImported,
  });

  return { eventsFound, eventsImported };
}

// ---------------------------------------------------------------------------
// Memory queue lock for concurrent event inserts (#251)
// ---------------------------------------------------------------------------
// A single promise chain acts as an in-memory queue so overlapping
// indexer_runner executions serialize their writes to the events table and the
// ledger pointer. Without this, concurrent notifications could interleave the
// atomic batch + pointer update and produce conflicting/duplicate entries.
let eventInsertTail: Promise<void> = Promise.resolve();

/**
 * Reset the in-memory event-insert queue lock (used by tests).
 */
export function resetEventInsertQueueForTests(): void {
  eventInsertTail = Promise.resolve();
}

/**
 * Enqueue an event batch write behind a memory queue lock.
 *
 * Concurrent callers are chained onto a single promise tail and executed one at
 * a time, preserving the atomicity of `insertEventBatch` and preventing
 * duplicate or conflicting inserts from overlapping iterations.
 */
export function enqueueEventInsert(
  events: EventRow[],
  newLedger: number,
): Promise<void> {
  return enqueueEventWrite(() => insertEventBatch(events, newLedger));
}

export function enqueueHistoricalEventInsert(
  events: EventRow[],
  range: { startLedger: number; endLedger: number },
): Promise<{ inserted: number }> {
  return enqueueEventWrite(() => insertHistoricalEventBatch(events, range));
}

function enqueueEventWrite<T>(write: () => T): Promise<T> {
  const run = eventInsertTail.then(write);
  // Keep the queue alive even if an insert rejects so later enqueues proceed.
  eventInsertTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Poll events for all active contract IDs stored in monitored_contracts (#85).
 * All events fetched in a single poll are written atomically together with the
 * ledger pointer update (#84) – so a mid-poll crash cannot advance the pointer
 * without committing the accompanying events.
 *
 * Returns whether the network showed activity (a new ledger closed since the
 * last poll). The caller uses this to drive the dynamic polling interval
 * (see nextPollIntervalMs()) – NOTE this only affects how *often* we poll,
 * never *what* gets written. Duplicate prevention itself is guaranteed by the
 * UNIQUE(contract_id, ledger_sequence, event_type) constraint + INSERT OR
 * IGNORE in db.ts, and every poll always resumes from the last committed
 * ledger pointer (lastLedger + 1) regardless of how much time has passed
 * since the previous poll. So a longer interval can only delay *when* an
 * event is detected – it cannot cause an event to be missed, double-counted,
 * or processed out of order.
 */
/**
 * Pull the oldest retained ledger out of a retention error or response.
 * Soroban RPC rejects a startLedger older than its window with an
 * invalid-params error naming the oldest ledger; the number may also ride
 * along as a property on the error/response object.
 */
export function extractOldestLedger(source: unknown): number | undefined {
  if (typeof source === "number" && Number.isInteger(source) && source > 0) {
    return source;
  }
  if (source && typeof source === "object") {
    const obj = source as Record<string, unknown>;
    for (const key of ["oldestLedger", "oldest_ledger", "oldest"]) {
      const v = obj[key];
      if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
      if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
    }
    const nested = (obj as any).data ?? (obj as any).response;
    if (nested && nested !== source) {
      const fromNested = extractOldestLedger(nested);
      if (fromNested !== undefined) return fromNested;
    }
  }
  if (source instanceof Error) {
    const m = source.message.match(/oldest[^0-9]{0,20}(\d+)/i);
    if (m) return parseInt(m[1], 10);
  }
  return undefined;
}

export async function pollEvents(): Promise<boolean> {
  const pollStartedAt = performance.now();
  const pollStart = performance.now();

  // --- Alerting: stall detection before polling (#253, #271) ---
  // Reads only in-memory monitor state, so it is safe outside the try.
  const lastSuccessAt = failureMonitor.getLastSuccessfulAt();
  let stallWindow: StallWindow | null = null;

  if (lastSuccessAt) {
    const elapsedMsSinceLastSuccess = Date.now() - lastSuccessAt;
    // Prefer an explicitly configured stall threshold; otherwise follow the
    // failure monitor's own (possibly test-injected) threshold.
    const stallThresholdMs =
      process.env.INDEXER_RUNNER_STALL_THRESHOLD_MS ||
      process.env.POLLER_STALL_THRESHOLD_MS
        ? config.indexerRunnerStallThresholdMs
        : failureMonitor.stallThresholdMs;
    stallWindow = { elapsedMsSinceLastSuccess, stallThresholdMs };

    if (elapsedMsSinceLastSuccess > stallThresholdMs) {
      logger.warn("Poller stall detected – no successful poll for threshold period", {
        elapsedMs: elapsedMsSinceLastSuccess,
        stallThresholdMs,
        consecutiveFailures: failureMonitor.getConsecutiveFailures(),
      });
    }
  }

  try {
    // --- Resolve active contract IDs from the DB (#85, #689) ---
    // These SQLite reads/writes must live inside the try: a SQLITE_BUSY,
    // locked, corrupt, or full-disk DB would otherwise reject outside any
    // catch, surface as an unhandled rejection, and crash the process.
    // The escrow factory (#660): index it so its `created` events register
    // each new escrow contract.
    const factoryContractId = process.env.FACTORY_CONTRACT_ID;
    if (factoryContractId && !getActiveContractIds().includes(factoryContractId)) {
      registerContract(factoryContractId, "factory");
    }

    let contractIds: string[] = getActiveContractIds();

    // Fall back to the legacy single CONTRACT_ID env var so existing deployments
    // keep working without any DB seed step.
    if (contractIds.length === 0 && process.env.CONTRACT_ID) {
      registerContract(process.env.CONTRACT_ID, "default");
      contractIds = [process.env.CONTRACT_ID];
    }

    if (contractIds.length === 0) {
      logger.debug("No CONTRACT_IDs configured – skipping indexer poll");
      return false;
    }
    // Validate the schema before ingesting events – a stale schema must not
    // silently accept rows for unknown contract topics (#282, #687).
    verifySchemaUpToDate();

    const currentLedger = (await rpcClient.getLatestLedger()).sequence;

    // --- Group contracts by their per-contract ledger pointer (#720) ---
    // Contracts sharing a pointer are polled together in one getEvents call.
    // A newly registered contract starts from its start_ledger and catches up
    // separately until it joins the main group. The global pointer remains as
    // the default for legacy single-contract setups.
    // contractIds were resolved (with the CONTRACT_ID fallback) above, so
    // every active contract has a row here.
    const contracts = getActiveContractsWithPointers();

    // Group contracts by the ledger they are indexed up to, so each group
    // makes one getEvents call.
    const groups = new Map<number, string[]>();
    for (const { contractId, lastLedgerSequence } of contracts) {
      const group = groups.get(lastLedgerSequence) ?? [];
      group.push(contractId);
      groups.set(lastLedgerSequence, group);
    }

    let totalEvents = 0;
    // Webhooks must cover the earliest ledger any group fetched from, so a
    // catching-up contract's backfilled events are delivered too.
    let minStartLedger = Number.POSITIVE_INFINITY;
    const diagnosticsBatch: EventRow[] = [];
    let anyGroupPolled = false;

    // Safety valve so one poll cycle can never page forever (#608).
    const maxPagesPerPoll = parseInt(
      process.env.POLLER_MAX_PAGES_PER_POLL || "20",
      10,
    );
    const pageLimit = 100;

    for (const [pointer, groupContractIds] of groups) {
      if (currentLedger <= pointer) continue;
      anyGroupPolled = true;

      let startLedger = pointer + 1;
      minStartLedger = Math.min(minStartLedger, startLedger);

      logger.info("Polling events for contract group", {
        startLedger,
        currentLedger,
        contractCount: groupContractIds.length,
      });

      // Fetch one page, transparently clamping past the RPC retention window.
      // When the requested start is older than the oldest retained ledger the
      // RPC rejects with invalid-params naming the oldest ledger; we log the
      // gap, record it for operators, and retry once from the oldest ledger
      // (#609). Normal polls with no gap take the fast path untouched.
      const fetchPageRetentionAware = async (
        pageStart: number,
        cursorValue: string | undefined,
      ): Promise<any> => {
        try {
          // All RPC calls share RpcPollerClient's single retry policy, which
          // backs off on timeouts, resets, 429s (honouring Retry-After) and
          // 5xx (#688).
          return await rpcClient.getEvents(
            buildGetEventsRequest({
              startLedger: pageStart,
              contractIds: groupContractIds,
              limit: pageLimit,
              ...(cursorValue ? { cursor: cursorValue } : {}),
            }),
          );
        } catch (err) {
          const oldest = extractOldestLedger(err);
          if (oldest !== undefined && pageStart < oldest && !cursorValue) {
            logger.warn(
              "Poller start ledger is outside RPC retention window – clamping",
              {
                from: pageStart,
                to: oldest,
                skippedFrom: pageStart,
                skippedTo: oldest - 1,
              },
            );
            if (oldest - 1 >= pageStart) {
              recordSkippedLedgerRange(pageStart, oldest - 1);
            }
            startLedger = oldest;
            minStartLedger = Math.min(minStartLedger, startLedger);
            return await rpcClient.getEvents(
              buildGetEventsRequest({
                startLedger: oldest,
                contractIds: groupContractIds,
                limit: pageLimit,
              }),
            );
          }
          throw err;
        }
      };

      // Follow the RPC cursor until a short page arrives so ledgers holding
      // more than one page of events are fully collected (#608). Progress is
      // persisted after every page: each page commits its rows and advances
      // the ledger pointer before the next page is requested, so a failure
      // on page N leaves pages 1..N-1 stored and the pointer at the last
      // ledger fully stored. INSERT OR IGNORE + UNIQUE(event_id) keeps a
      // retried cycle idempotent.
      let cursor: string | undefined;
      let lastStoredLedger = pointer;
      for (let page = 0; page < maxPagesPerPoll; page++) {
        const events = await fetchPageRetentionAware(startLedger, cursor);

        const pageEvents: any[] = (events as any).events ?? [];
        // Build the batch to be written atomically (#84)
        const batch: EventRow[] = pageEvents.map((event) =>
          toEventRow(event, groupContractIds[0])
        );

        // Register escrow contracts created by the factory (#660) so the next
        // poll indexes them, and fetch the new contract's first page now so a
        // job created this cycle is visible without waiting a poll interval.
        let childEventCount = 0;
        for (const ev of [...batch]) {
          if (ev.eventType.toLowerCase() !== "created") continue;
          let childContractId: string | null = null;
          try {
            const data = JSON.parse(ev.dataJson) as Record<string, unknown>;
            childContractId =
              (typeof data.contract_id === "string" ? data.contract_id : null) ||
              (typeof data.contractId === "string" ? data.contractId : null) ||
              (typeof data.address === "string" ? data.address : null) ||
              (typeof data.child === "string" ? data.child : null);
          } catch {
            // Ignore parse errors on dataJson
          }
          if (!childContractId) continue;

          logger.info("Factory created new escrow child contract", {
            childContractId,
            ledgerSequence: ev.ledgerSequence,
          });
          registerContract(childContractId, "escrow_child", ev.ledgerSequence);

          try {
            const childEvents = await rpcClient.getEvents(
              buildGetEventsRequest({
                startLedger: ev.ledgerSequence,
                contractIds: [childContractId],
                limit: pageLimit,
              }),
            );
            const childPage: any[] = (childEvents as any).events ?? [];
            const childBatch: EventRow[] = childPage.map((childEv) =>
              toEventRow(childEv, childContractId as string)
            );
            batch.push(...childBatch);
            childEventCount += childBatch.length;
            // A full page may not be the end: only jump the child's pointer to
            // the chain head when the page ran short, else to its last event.
            const childLedger =
              childPage.length < pageLimit
                ? currentLedger
                : Math.max(
                    ...childPage.map((e: any) => Number(e.ledger) || ev.ledgerSequence)
                  );
            updateContractPointer(childContractId, childLedger);
          } catch (childErr) {
            logger.warn("Failed immediate poll for new child contract, will catch up next cycle", {
              childContractId,
              error: formatError(childErr),
            });
          }
        }

        const pageMaxLedger =
          pageEvents.length > 0
            ? Math.max(...pageEvents.map((e: any) => Number(e.ledger) || startLedger))
            : lastStoredLedger;
        const nextCursor = (events as any)?.cursor as string | undefined;
        const isLastPage =
          pageEvents.length < pageLimit || !nextCursor;

        // Only advance the pointer to the ledger of the last event actually
        // processed, or to the RPC's latest ledger once the final page ran
        // short and there is nothing left to collect.
        const newLedger = isLastPage
          ? ((events as any)?.latestLedger ?? currentLedger)
          : pageMaxLedger;

        // Persist the page and advance both pointers atomically per page.
        // Called even with an empty batch so the global pointer advances.
        await enqueueEventInsert(batch, newLedger);

        // Advance each contract in the group to the stored ledger (#720).
        for (const contractId of groupContractIds) {
          updateContractPointer(contractId, newLedger);
        }

        totalEvents += pageEvents.length + childEventCount;
        diagnosticsBatch.push(...batch);
        lastStoredLedger = newLedger;
        if (isLastPage) break;
        cursor = nextCursor;
      }
    }

    // Record success for any poll that completes without throwing, even idle cycles.
    const totalElapsed = performance.now() - pollStart;
    failureMonitor.recordSuccess();

    // --- Dynamic poller throttling (#265) ---
    const throttleState = adjustPollerInterval(totalEvents);
    adjustIndexerRunnerPollInterval(totalEvents);

    logger.info("Processed indexer poll", {
      eventCount: totalEvents,
      upToLedger: currentLedger,
      elapsedMs: Math.round(totalElapsed),
      pollIntervalMs: throttleState.currentIntervalMs,
    });

    if (anyGroupPolled) {
      logPollDiagnostics(
        performance.now() - pollStartedAt,
        diagnosticsBatch,
        stallWindow,
      );

      deliverWebhooks(minStartLedger, currentLedger).catch((err) =>
        logger.error("Error delivering webhooks", {
          error: formatError(err),
        })
      );
    }

    if (!anyGroupPolled) {
      return false;
    }

    return true;
  } catch (err) {
    const totalElapsed = performance.now() - pollStart;
    const consecutiveFailures = failureMonitor.recordFailure("poll", {
      error: formatError(err),
      operation: "poll_events",
    });

    logger.error("Error polling events", {
      error: formatError(err),
      consecutiveFailures,
      elapsedMs: Math.round(totalElapsed),
    });

    // Keep legacy poller alert message for existing #271 tests
    if (
      failureMonitor.getConsecutiveFailures() >=
      failureMonitor.getFailureThreshold()
    ) {
      logger.error("Poller alert: consecutive failure threshold exceeded", {
        consecutiveFailures: failureMonitor.getConsecutiveFailures(),
        threshold: failureMonitor.getFailureThreshold(),
        lastSuccessAt: failureMonitor.getLastSuccessfulAt(),
      });
    }

    // A failed poll advanced nothing, so report no progress to the throttler.
    return false;
  }
}

let pollerTimeout: NodeJS.Timeout | null = null;
let pollerRunning = false;

/**
 * One poll plus the interval adjustment its outcome implies (#689).
 *
 * Never rejects: `pollEvents` already converts failures to a `false`
 * return, but a defensive catch keeps the loop alive even if a future code
 * path throws outside that contract (or rejects the interval update).
 */
async function runPollCycle(): Promise<void> {
  try {
    const sawActivity = await pollEvents();
    currentPollIntervalMs = nextPollIntervalMs(currentPollIntervalMs, sawActivity);
  } catch (err) {
    const consecutiveFailures = failureMonitor.recordFailure("poll", {
      error: formatError(err),
      operation: "run_poll_cycle",
    });
    logger.error("Poll cycle escaped pollEvents catch – recording failure", {
      error: formatError(err),
      consecutiveFailures,
    });
  }
}

async function pollLoop() {
  if (!pollerRunning) return;
  await runPollCycle();
  if (!pollerRunning) return;
  pollerTimeout = setTimeout(pollLoop, currentPollIntervalMs);
}

export function startPoller() {
  if (pollerRunning) return;

  // Migration verification hook: fail-fast on startup if the database schema is
  // out of sync, so the indexer cannot start against a stale schema (#255).
  assertSchemaValid();

  pollerRunning = true;
  currentPollIntervalMs = POLL_INTERVAL_MIN_MS;
  logger.info("Starting event indexer poller", {
    intervalMs: currentPollIntervalMs,
  });

  // The first cycle runs immediately; the loop is scheduled off its outcome so
  // the very first idle poll already widens the wait. A rejection handler
  // keeps an unexpected throw from becoming an unhandled rejection (#689).
  void runPollCycle()
    .catch((err) => {
      logger.error("Initial poll cycle failed", {
        error: formatError(err),
      });
    })
    .then(() => {
      if (pollerRunning) {
        pollerTimeout = setTimeout(pollLoop, currentPollIntervalMs);
      }
    });
}

export function stopPoller() {
  pollerRunning = false;
  if (pollerTimeout) {
    clearTimeout(pollerTimeout);
    pollerTimeout = null;
  }
  resetPollerThrottleState();
  currentPollIntervalMs = POLL_INTERVAL_MIN_MS;
}
