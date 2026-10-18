/**
 * Canonical topic[0] discriminators emitted by the milestone-escrow contract
 * (#687).
 *
 * Generated from `escrow-contract/contracts/milestone-escrow/src/lib.rs` by
 * collecting every `symbol_short!("…")` publish site, e.g.:
 *
 * ```sh
 * grep -rhoE 'symbol_short!\("([^"]+)"' \
 *   escrow-contract/contracts/milestone-escrow/src/lib.rs \
 *   | sed -E 's/.*\("([^"]+)".*/\1/' | sort -u
 * ```
 *
 * Every entry fits `symbol_short!`'s 9-character limit and the list contains
 * no duplicates (see `__tests__/event-type-filter.test.ts`). The indexer
 * requests all topics with a wildcard filter (see `buildGetEventsRequest`)
 * because Soroban RPC caps filters at 5 topics per filter and 5 filters per
 * request (25 alternatives maximum), so 52 topics cannot be expressed as an
 * enumerated filter. `contractIds` already scopes each request, and the
 * indexer wants every event the contract emits, making the wildcard
 * semantically identical to an (unrepresentable) enumeration.
 */
export const EVENT_TYPES = [
  "init",
  "fund",
  "deliver",
  "approve",
  "dispute",
  "resolve",
  "claim",
  "cancel",
  "arbsplit",
  "splitref",
  "epspltref",
  "cxlspref",
  "admovrls",
  "admovrf",
  "admstrm",
  "adtxrls",
  "msadmrel",
  "msadmref",
  "create",
  "deposit",
  "payout",
  "refund",
  "release",
  "lock",
  "unlock",
  "pause",
  "unpause",
  "vote",
  "mcreate",
  "mfund",
  "mdeliver",
  "mapprove",
  "mrelease",
  "mrefund",
  "mclaim",
  "mdispute",
  "mresolve",
  "mcancel",
  "arbset",
  "arbpay",
  "arbvote",
  "setfee",
  "feeupd",
  "tokadd",
  "tokrem",
  "wstake",
  "unstake",
  "slash",
  "topup",
  "withdraw",
  "escrow",
  "finalize",
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

/** Parameters for building a `Server.getEvents` request. */
export interface GetEventsParams {
  startLedger?: number;
  cursor?: string;
  contractIds?: string[];
  filters?: any[];
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
 * All topics are requested with a wildcard filter. Soroban RPC requires each
 * topic segment to be either the wildcard `"*"` or a base64-encoded XDR
 * ScVal; sending raw ASCII topic strings is rejected with -32602
 * ("illegal base64 data").
 *
 * The wildcard is the correct, permanent choice — not a placeholder pending
 * a narrower filter. Do not replace it with an enumerated topic filter: that
 * migration is structurally impossible, for two independent reasons.
 *
 *   1. It does not fit. The contract emits 52 distinct topic[0]
 *      discriminators (the `symbol_short!` literals across
 *      `milestone-escrow/src/lib.rs`, see `EVENT_TYPES`). Soroban RPC caps
 *      filters at 5 topics per filter and 5 filters per request — 25
 *      alternatives maximum. 52 cannot be expressed, neither as one filter
 *      nor split across filters (`maximum 5 topics per filter` /
 *      `maximum 5 filters per request`).
 *
 *   2. It would buy nothing. `contractIds` already scopes every request to
 *      our own contract, and the indexer wants every event that contract
 *      emits. Enumerating all 52 would be semantically identical to sending
 *      no topic filter at all.
 *
 * Retry policy lives in exactly one place: `RpcPollerClient` (see
 * `rpc-poller-client.ts`). Callers must route the returned request through
 * `RpcPollerClient.getEvents()` so 429/503 responses honour `Retry-After`
 * and share the same backoff as every other RPC call in the indexer.
 */
export function buildGetEventsRequest(params: GetEventsParams): {
  startLedger?: number;
  cursor?: string;
  filters: Array<{
    type: string;
    contractIds?: string[];
    topics: string[][];
  }>;
  limit: number;
} {
  const filters =
    params.filters ??
    [
      {
        type: "contract",
        contractIds: params.contractIds ?? [],
        topics: [["*"]],
      },
    ];
  const request: {
    startLedger?: number;
    cursor?: string;
    filters: Array<{
      type: string;
      contractIds?: string[];
      topics: string[][];
    }>;
    limit: number;
  } = {
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
