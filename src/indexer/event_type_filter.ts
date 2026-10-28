import type { Api } from "@stellar/stellar-sdk/rpc";
/**
 * Canonical topic[0] discriminators emitted by the milestone-escrow contract
 * (#687).
 *
 * Generated from `escrow-contract/contracts/milestone-escrow/src/lib.rs` by
 * collecting every `symbol_short!("…")` used as an event topic (#687, #774;
 * refreshed against escrow-contract main), e.g.:
 *
 * ```sh
 * grep -rhoE 'symbol_short!\("([^"]+)"' \
 *   escrow-contract/contracts/milestone-escrow/src/lib.rs \
 *   | sed -E 's/^[^(]*[(]"([^"]+)".+$/\1/' | sort -u
 * ```
 *
 * Every entry fits `symbol_short!`'s 9-character limit and the list contains
 * no duplicates (see `__tests__/event-type-filter.test.ts`). The indexer
 * sends no topic filter at all (see `buildGetEventsRequest`): `contractIds`
 * already scopes each request, and it wants every event the contract emits.
 */
export const EVENT_TYPES = [
  "acceptarb",
  "acceptjob",
  "adcovls",
  "adcovrf",
  "admin",
  "admincxl",
  "adminexc",
  "adminprp",
  "admovrf",
  "admovrls",
  "admstrm",
  "adtwsplt",
  "adtxrfd",
  "adtxrls",
  "approve",
  "arbchg",
  "arbsplit",
  "cancel",
  "cancelrev",
  "claim",
  "cxlappr",
  "cxlspref",
  "deliver",
  "dispescal",
  "dispute",
  "emoverrid",
  "empause",
  "emunpause",
  "epalloc",
  "epclaim",
  "epspltref",
  "evidence",
  "extend",
  "freerot",
  "fund",
  "init",
  "intyield",
  "iyspltref",
  "m_ext",
  "m_extcns",
  "migrate",
  "ms_add",
  "ms_reduce",
  "msadmref",
  "msadmrel",
  "msfund",
  "msigappr",
  "msigcfg",
  "msigcfgp",
  "msigcfgx",
  "msiginit",
  "mslock",
  "msrev",
  "p_strcns",
  "p_stream",
  "pause",
  "pf_lock",
  "pf_ovr",
  "pf_set",
  "pf_split",
  "resolve",
  "resume",
  "rolechg",
  "splitref",
  "sprefnet",
  "sweep",
  "taxpaid",
  "taxrcpt",
  "taxwh",
  "taxwith",
  "twspltref",
  "unaccref",
  "upgrade",
  "withdraw",
  "wldel",
  "wtok",
  "yldacc",
  "yldcons",
  "yldlock",
  "yldrate",
  "yldset",
  "yldunlock",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Return true when `topic` is one of the contract's emitted discriminators.
 */
export function isKnownEventType(topic: unknown): topic is EventType {
  return (
    typeof topic === "string" &&
    (EVENT_TYPES as readonly string[]).includes(topic)
  );
}

/** The `Server.getEvents` request this module builds (#645). */
export interface GetEventsRequest {
  startLedger?: number;
  cursor?: string;
  filters: Api.EventFilter[];
  limit: number;
}

/** Parameters for building a `Server.getEvents` request. */
export interface GetEventsParams {
  startLedger?: number;
  cursor?: string;
  contractIds?: string[];
  filters?: Api.EventFilter[];
  limit?: number;
}

/** Shape of `Server.getEvents` that this module depends on (subset). */
export interface RpcGetEventsResult {
  events: Array<{
    contractId: { contractId(): string } | undefined;
    topic: unknown[];
    value: unknown;
    ledger: number;
    ledgerClosedAt: string | undefined;
  }>;
}

/**
 * Build the `Server.getEvents` request for a poll window (#688).
 *
 * Filters by contract only, with no topic filter. `contractIds` already
 * scopes every request to our own contracts, and the indexer wants every
 * event they emit.
 *
 * Do not add a topic filter. Soroban RPC topic filters are positional: the
 * wildcard `"*"` matches exactly one topic segment, so `topics: [["*"]]`
 * silently drops every event with more than one topic, which since #739 is
 * most escrow events (init, fund, deliver, approve, dispute... carry party
 * addresses as extra topics). Enumerating topic[0] values cannot work either:
 * the contract emits more discriminators than the RPC's 5 topics per filter
 * and 5 filters per request allow.
 *
 * Retry policy lives in exactly one place: `RpcPollerClient` (see
 * `rpc-poller-client.ts`). Callers must route the returned request through
 * `RpcPollerClient.getEvents()` so 429/503 responses honour `Retry-After`
 * and share the same backoff as every other RPC call in the indexer.
 */
export function buildGetEventsRequest(params: GetEventsParams): GetEventsRequest {
  const filters =
    params.filters ??
    [
      {
        type: "contract" as const,
        contractIds: params.contractIds ?? [],
      },
    ];
  const request: GetEventsRequest = {
    filters,
    limit: params.limit ?? 100,
  };
  if (params.cursor !== undefined) {
    request.cursor = params.cursor;
  } else if (params.startLedger !== undefined) {
    request.startLedger = params.startLedger;
  }
  return request;
}
