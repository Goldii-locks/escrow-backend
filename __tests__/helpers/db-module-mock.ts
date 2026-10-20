import { jest } from "@jest/globals";

/**
 * Shared mock for `src/indexer/db.js` in the #644 tests.
 *
 * The module is imported wholesale by the admin route and the poller, so the
 * mock has to provide every named export the import graph touches — Jest's
 * ESM loader rejects a module that is missing an export.
 */

export const dbModuleMock = {
  // Status
  getIndexerStatusData: jest.fn(() => ({
    lastIndexedLedger: 100,
    totalEvents: 42,
    lastEventAt: "2026-01-01T00:00:00.000Z",
    eventsByType: { deposit: 7 },
  })),

  // Contract registry
  getActiveContractIds: jest.fn(() => ["C_TEST_CONTRACT_ID"]),
  // The poll loop groups contracts by their ledger pointer and skips any
  // group whose pointer is already at or past the chain head — an empty list
  // (or a pointer >= the head) would leave it with nothing to poll, which the
  // loop counts as a failed cycle rather than a successful one. The pointer
  // therefore has to sit below the head the mocked RPC reports.
  getActiveContractsWithPointers: jest.fn(() => [
    { contractId: "C_TEST_CONTRACT_ID", lastLedgerSequence: 1 },
  ]),
  registerContract: jest.fn(),
  deregisterContract: jest.fn(),

  // Event writes
  insertEvent: jest.fn(),
  insertEventBatch: jest.fn(),
  insertEventBatchLocked: jest.fn(),
  insertEventLocked: jest.fn(),
  insertHistoricalEventBatch: jest.fn(),
  isDuplicateEvent: jest.fn(() => false),
  updateContractPointer: jest.fn(),
  resetEventInsertLocksForTests: jest.fn(),
  setEventInsertLockHookForTests: jest.fn(),
  getEventInsertLockCount: jest.fn(() => 0),

  // Reads
  getEventsByAddress: jest.fn(),
  getEventsByContract: jest.fn(),
  getHistoricalEventCounts: jest.fn(),
  getJobsByWallet: jest.fn(),
  getLastIndexedLedger: jest.fn(() => 100),
  setLastIndexedLedger: jest.fn(),

  // Poller throttle / interval
  // `adjustPollerInterval` returns the new throttle state; the poll loop
  // reads `currentIntervalMs` off it, so it must return an object.
  adjustPollerInterval: jest.fn(() => ({
    currentIntervalMs: 15000,
    lastEventAt: 0,
    eventsSinceLastPoll: 0,
  })),
  getCurrentPollIntervalMs: jest.fn(() => 15000),
  getPollerThrottleState: jest.fn(() => ({
    currentIntervalMs: 15000,
    lastEventAt: 0,
    eventsSinceLastPoll: 0,
  })),
  resetPollerThrottleState: jest.fn(),

  // Schema
  assertSchemaValid: jest.fn(),
  verifySchemaUpToDate: jest.fn(),
  verifySchemaIntegrity: jest.fn(() => ({})),
  initSchema: jest.fn(),
  runMigrations: jest.fn(),
  getShippedMigrationVersions: jest.fn(() => []),
  isSchemaRetryableError: jest.fn(() => false),
  computeSchemaBackoffMs: jest.fn(() => 100),
  withSchemaRetry: jest.fn(async (fn: () => unknown) => fn()),
  withSchemaRetrySync: jest.fn((fn: () => unknown) => fn()),
  logSchemaManagerPollDiagnostics: jest.fn(),

  // Subscriptions
  addSubscription: jest.fn(),
  removeSubscription: jest.fn(),
  getSubscriptions: jest.fn(() => []),
  getSubscriptionsForContract: jest.fn(() => []),

  // History validation
  validateHistoricalRange: jest.fn(),

  // Connection lifecycle
  getDb: jest.fn(),
  setDb: jest.fn(),
  closeDb: jest.fn(),
  resetJobsByWalletCache: jest.fn(),

  // Constants
  INDEXER_RUNNER_INDEXES: [],
  SCHEMA_MANAGER_INDEXES: [],
};
