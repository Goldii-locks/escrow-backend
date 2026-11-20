import { jest } from "@jest/globals";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { xdr as Xdr } from "@stellar/stellar-sdk";

/**
 * #969: the example `data` payloads in docs/webhooks.md are produced here by
 * running contract-shaped ScVals through the poller's real decoding path
 * (`toEventRow`), so the docs show exactly what a webhook delivers: amounts
 * and u64 timestamps as decimal strings, unit enums as one-element vecs,
 * BytesN<32> hashes as serialised Buffers, and struct fields in Soroban's
 * (alphabetical) map order.
 *
 * Every documented example must match this output. After changing a fixture,
 * regenerate the doc blocks with:
 *
 *   UPDATE_WEBHOOK_DOCS=1 npx jest __tests__/webhook-event-payloads.test.ts
 *
 * Fixture field sets mirror the event structs in escrow-contract's
 * `contracts/milestone-escrow/src/lib.rs` (see its EVENTS.md).
 */

jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { nativeToScVal, xdr } = await import("@stellar/stellar-sdk");
const { toEventRow } = await import("../src/indexer/poller.js");
const { EVENT_TYPES } = await import("../src/indexer/event_type_filter.js");

type ScVal = Xdr.ScVal;

const ESCROW = "CARZQMYKDGA4TTIE2XBDJ42EX27VYLLJGGG4WGUIXXWIVHPDTX3UCLJA";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const ADMIN = "GAQSEIZEEUTCOKBJFIVSYLJOF4YDCMRTGQ2TMNZYHE5DWPB5HY7UAIOK";
const CLIENT = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";
const FREELANCER = "GB5CRPXUGXZCG6BESL4CM4F3VUAGQGFNYNBHPBRJAGLXXSRYJSEGZHUV";
const ARBITER = "GABNCQRZNTG6MMITD33VHFITKJZ5PSYW2XVEXMP52BSMTPLU7WORDQNT";
const NEW_PARTY = "GAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPSABOV";

const addr = (a: string): ScVal => nativeToScVal(a, { type: "address" });
const i128 = (n: bigint): ScVal => nativeToScVal(n, { type: "i128" });
const u64 = (n: bigint): ScVal => nativeToScVal(n, { type: "u64" });
const u32 = (n: number): ScVal => nativeToScVal(n, { type: "u32" });
const bool = (b: boolean): ScVal => xdr.ScVal.scvBool(b);
/** A `#[contracttype]` unit enum variant is encoded as `vec![Symbol]`. */
const unitEnum = (variant: string): ScVal =>
  xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant)]);
const vec = (items: ScVal[]): ScVal => xdr.ScVal.scvVec(items);
const HASH = (): ScVal => xdr.ScVal.scvBytes(Buffer.alloc(32, 0xab));

/** A `#[contracttype]` struct: a map with symbol keys, sorted by key. */
function struct(fields: Record<string, ScVal>): ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map(
        (key) =>
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: fields[key] }),
      ),
  );
}

/** Event topic -> contract struct published as the event's data. */
const WEBHOOK_EVENT_FIXTURES: Record<string, ScVal> = {
  // InitializedEvent
  init: struct({
    admin: addr(ADMIN),
    client: addr(CLIENT),
    freelancer: addr(FREELANCER),
    arbiter: addr(ARBITER),
    token: addr(TOKEN),
    auto_release_seconds: u64(604800n),
    milestone_amounts: vec([i128(10000000n), i128(20000000n)]),
    milestone_spec_hashes: vec([HASH(), HASH()]),
    total_amount: i128(30000000n),
    milestone_count: u32(2),
    created_at: u64(1735603200n),
  }),
  // FundedEvent
  fund: struct({
    client: addr(CLIENT),
    total_amount: i128(30000000n),
  }),
  // MilestoneFundedEvent
  msfund: struct({
    client: addr(CLIENT),
    milestone_index: u32(1),
    amount: i128(20000000n),
    token: addr(TOKEN),
  }),
  // DeliveredEvent
  deliver: struct({
    milestone_index: u32(0),
    freelancer: addr(FREELANCER),
    client: addr(CLIENT),
    delivered_at: u64(1735689600n),
    status: unitEnum("Delivered"),
    amount: i128(10000000n),
    deliverable: HASH(),
  }),
  // ApprovedEvent
  approve: struct({
    milestone_index: u32(0),
    amount: i128(10000000n),
    released_amount: i128(10000000n),
    remaining: i128(0n),
    status: unitEnum("Released"),
  }),
  // ClaimedEvent
  claim: struct({
    milestone_index: u32(0),
    caller: addr(FREELANCER),
    freelancer: addr(FREELANCER),
    token: addr(TOKEN),
    amount: i128(10000000n),
  }),
  // WithdrawnEvent
  withdraw: struct({
    recipient: addr(CLIENT),
    token: addr(TOKEN),
    amount: i128(20000000n),
  }),
  // DisputeRaisedEvent
  dispute: struct({
    milestone_index: u32(0),
    caller: addr(CLIENT),
    milestone_amount: i128(10000000n),
    reason_hash: HASH(),
    disputed_at: u64(1735776000n),
    new_status: unitEnum("Disputed"),
  }),
  // EvidenceSubmittedEvent
  evidence: struct({
    milestone_index: u32(0),
    caller: addr(FREELANCER),
    evidence_hash: HASH(),
    submitted_at: u64(1735779600n),
  }),
  // DisputeResolvedEvent
  resolve: struct({
    milestone_index: u32(0),
    arbiter: addr(ARBITER),
    amount: i128(10000000n),
    paid_amount: i128(9500000n),
    arbiter_fee_amount: i128(500000n),
    released_to_freelancer: bool(true),
    status: unitEnum("Released"),
    decision_hash: HASH(),
  }),
  // ArbitrationSplitAppliedEvent
  arbsplit: struct({
    arbiter: addr(ARBITER),
    milestone_index: u32(0),
    client: addr(CLIENT),
    freelancer: addr(FREELANCER),
    token: addr(TOKEN),
    client_refund: i128(4000000n),
    freelancer_payout: i128(6000000n),
    arbiter_fee_amount: i128(0n),
    client_refund_bps: u32(4000),
    freelancer_payout_bps: u32(6000),
    released_amount: i128(6000000n),
    status: unitEnum("Split"),
    decision_hash: HASH(),
  }),
  // DisputeEscalatedEvent
  dispescal: struct({
    milestone_index: u32(0),
    caller: addr(CLIENT),
    disputed_at: u64(1735776000n),
    escalated_at: u64(1736380800n),
    restored_status: unitEnum("Delivered"),
  }),
  // CancelEscrowInitiatedEvent
  cancel: struct({
    caller: addr(CLIENT),
    caller_is_client: bool(true),
    client: addr(CLIENT),
    freelancer: addr(FREELANCER),
    token: addr(TOKEN),
    milestone_count: u32(2),
    total_amount: i128(30000000n),
  }),
  // MilestoneAddedEvent
  ms_add: struct({
    client: addr(CLIENT),
    freelancer: addr(FREELANCER),
    milestone_index: u32(2),
    amount: i128(5000000n),
    total_amount: i128(35000000n),
    milestone_count: u32(3),
  }),
  // MilestoneReducedEvent
  ms_reduce: struct({
    client: addr(CLIENT),
    freelancer: addr(FREELANCER),
    milestone_index: u32(1),
    old_amount: i128(20000000n),
    new_amount: i128(15000000n),
    refund: i128(5000000n),
    total_amount: i128(25000000n),
    milestone_count: u32(2),
  }),
  // ArbiterReplacedEvent
  arbchg: struct({
    client: addr(CLIENT),
    freelancer: addr(FREELANCER),
    old: addr(ARBITER),
    new: addr(NEW_PARTY),
  }),
  // FreelancerRotatedEvent
  freerot: struct({
    client: addr(CLIENT),
    previous_freelancer: addr(FREELANCER),
    new_freelancer: addr(NEW_PARTY),
  }),
  // OverdueReclaimedEvent
  overdue: struct({
    client: addr(CLIENT),
    milestone_index: u32(1),
    due_at: u64(1736380800n),
    amount: i128(20000000n),
  }),
  // UnacceptedWithdrawnEvent
  unaccref: struct({
    client: addr(CLIENT),
    token: addr(TOKEN),
    amount: i128(30000000n),
  }),
};

/** Decode one fixture through the poller's real RPC-event mapping. */
function decode(eventType: string, value: ScVal) {
  return toEventRow(
    {
      id: "0005299864448000000-0000000001",
      ledger: 12345678,
      ledgerClosedAt: "2025-01-01T00:00:00Z",
      txHash: "9f2c".padEnd(64, "0"),
      topic: [xdr.ScVal.scvSymbol(eventType), addr(CLIENT)],
      value,
    } as unknown as Parameters<typeof toEventRow>[0],
    ESCROW,
  );
}

/** Pretty JSON with arrays of primitives kept on one line. */
function formatExample(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /\[\s+([^[\]{}]*?)\s+\]/g,
    (_match, inner: string) => `[${inner.split(/,\s+/).join(", ")}]`,
  );
}

const DOC_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../docs/webhooks.md",
);
const EXAMPLE_BLOCK = /(<!-- webhook-example:([a-z_]+) -->\n```json\n)([\s\S]*?)(\n```)/g;

function documentedExamples(doc: string): Map<string, string> {
  const examples = new Map<string, string>();
  for (const match of doc.matchAll(EXAMPLE_BLOCK)) {
    examples.set(match[2], match[3]);
  }
  return examples;
}

describe("webhook event payload examples (docs/webhooks.md, #969)", () => {
  const rows = new Map(
    Object.entries(WEBHOOK_EVENT_FIXTURES).map(([type, value]) => [
      type,
      decode(type, value),
    ]),
  );
  // webhook-delivery.ts sends `data: JSON.parse(event.data_json)`.
  const generated = new Map(
    [...rows].map(([type, row]) => [type, JSON.parse(row.dataJson) as unknown]),
  );

  if (process.env.UPDATE_WEBHOOK_DOCS === "1") {
    const doc = readFileSync(DOC_PATH, "utf8");
    writeFileSync(
      DOC_PATH,
      doc.replace(EXAMPLE_BLOCK, (match, open: string, type: string, _body, close: string) =>
        generated.has(type) ? `${open}${formatExample(generated.get(type))}${close}` : match,
      ),
    );
  }

  const doc = readFileSync(DOC_PATH, "utf8");
  const documented = documentedExamples(doc);

  it("covers only real contract topics, decoded as the row's event_type", () => {
    for (const [type, row] of rows) {
      expect(EVENT_TYPES).toContain(type);
      expect(row.eventType).toBe(type);
      expect(row.contractId).toBe(ESCROW);
    }
  });

  it("documents an example for every fixture, and no others", () => {
    expect([...documented.keys()].sort()).toEqual([...generated.keys()].sort());
  });

  it.each(Object.keys(WEBHOOK_EVENT_FIXTURES))(
    "the documented %s example matches toEventRow output",
    (type) => {
      const block = documented.get(type);
      expect(block).toBeDefined();
      expect(JSON.parse(block as string)).toEqual(generated.get(type));
    },
  );

  it("encodes amounts as decimal strings and unit enums as one-element vecs", () => {
    expect(generated.get("approve")).toEqual({
      amount: "10000000",
      milestone_index: 0,
      released_amount: "10000000",
      remaining: "0",
      status: ["Released"],
    });
  });
});
