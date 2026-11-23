import NodeCache from "node-cache";

/**
 * Job state cache for GET /api/jobs/:contractId (#679).
 *
 * Every dashboard view used to cost a getAccount + simulateTransaction round
 * trip. Results are now cached for JOB_STATE_CACHE_TTL_S, concurrent misses
 * share one RPC call, and the indexer drops a contract's entry as soon as it
 * stores a new event for it, so a state change is never hidden for the TTL.
 *
 * Lives under indexer/ (not routes/) so the poller can invalidate without
 * importing the Express router.
 */

const parsedTtl = parseInt(process.env.JOB_STATE_CACHE_TTL_S || "5", 10);
export const JOB_STATE_CACHE_TTL_S = Number.isNaN(parsedTtl) ? 5 : Math.max(0, parsedTtl);

export const jobStateCache = new NodeCache({
  stdTTL: JOB_STATE_CACHE_TTL_S,
  useClones: false,
});

const inFlightJobStateRequests = new Map<string, Promise<unknown>>();

/**
 * Bumped on every invalidation. A load that started before an invalidation
 * must not write its (possibly pre-event) result back into the cache.
 */
const generations = new Map<string, number>();

function generationOf(contractId: string): number {
  return generations.get(contractId) ?? 0;
}

export type JobStateSource = "cache" | "in-flight" | "rpc";

/**
 * Returns the cached state for `contractId`, joins an in-flight load, or runs
 * `load`. Only non-null results are cached; `null` (job not found) and
 * rejections are shared with concurrent callers but never stored.
 */
export async function getCachedJobState<T>(
  contractId: string,
  load: () => Promise<T | null>,
): Promise<{ value: T | null; source: JobStateSource }> {
  const cached = jobStateCache.get<T>(contractId);
  if (cached !== undefined) return { value: cached, source: "cache" };

  const existing = inFlightJobStateRequests.get(contractId) as Promise<T | null> | undefined;
  if (existing) return { value: await existing, source: "in-flight" };

  const startedAt = generationOf(contractId);
  const request = (async () => {
    const value = await load();
    if (value !== null && generationOf(contractId) === startedAt && JOB_STATE_CACHE_TTL_S > 0) {
      jobStateCache.set(contractId, value);
    }
    return value;
  })();

  inFlightJobStateRequests.set(contractId, request);
  try {
    return { value: await request, source: "rpc" };
  } finally {
    // Only clear our own entry: an invalidation may already have replaced it.
    if (inFlightJobStateRequests.get(contractId) === request) {
      inFlightJobStateRequests.delete(contractId);
    }
  }
}

/** Drop the cached and in-flight state for one contract. */
export function invalidateJobState(contractId: string): void {
  generations.set(contractId, generationOf(contractId) + 1);
  jobStateCache.del(contractId);
  inFlightJobStateRequests.delete(contractId);
}

/** Drop cached state for every contract that has rows in `rows`. */
export function invalidateJobStateForEvents(rows: ReadonlyArray<{ contractId: string }>): void {
  for (const contractId of new Set(rows.map((row) => row.contractId))) {
    invalidateJobState(contractId);
  }
}

/** Clear everything (used by tests). */
export function resetJobStateCache(): void {
  jobStateCache.flushAll();
  inFlightJobStateRequests.clear();
  generations.clear();
}
