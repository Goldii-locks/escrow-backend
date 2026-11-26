/**
 * #863: parseJobFromResult returns every Job / Milestone field from a real
 * get_job ScVal, with bigints as strings and hashes as lowercase hex.
 */
import { Keypair, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { parseJobFromResult } from "../src/routes/jobs/shared.js";

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const entry = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: sym(key), val });
const addr = (a: string) => nativeToScVal(a, { type: "address" });
const u64 = (n: number | bigint) => nativeToScVal(BigInt(n), { type: "u64" });
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const bytes = (b: Buffer) => xdr.ScVal.scvBytes(b);
const unitEnum = (v: string) => xdr.ScVal.scvVec([sym(v)]);

const CLIENT = Keypair.random().publicKey();
const FREELANCER = Keypair.random().publicKey();
const ARBITER = Keypair.random().publicKey();
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 7));
const SPEC = Buffer.alloc(32, 0xab);
const DELIVERABLE = Buffer.from("00ff".repeat(16), "hex");

function milestone(opts: {
  amount: bigint; released: bigint; status: string; deliveredAt: number;
  funded: boolean; spec: Buffer; deliverable: Buffer;
}): xdr.ScVal {
  // Soroban encodes struct fields as a map sorted by key.
  return xdr.ScVal.scvMap([
    entry("amount", i128(opts.amount)),
    entry("delivered_at", u64(opts.deliveredAt)),
    entry("deliverable", bytes(opts.deliverable)),
    entry("funded", xdr.ScVal.scvBool(opts.funded)),
    entry("released_amount", i128(opts.released)),
    entry("spec_hash", bytes(opts.spec)),
    entry("status", unitEnum(opts.status)),
  ]);
}

function jobRetval(): xdr.ScVal {
  return xdr.ScVal.scvMap([
    entry("arbiter", addr(ARBITER)),
    entry("auto_release_seconds", u64(604800)),
    entry("client", addr(CLIENT)),
    entry("freelancer", addr(FREELANCER)),
    entry("funded", xdr.ScVal.scvBool(true)),
    entry("milestones", xdr.ScVal.scvVec([
      milestone({ amount: 5000000n, released: 2000000n, status: "PartiallyReleased",
        deliveredAt: 1700000000, funded: true, spec: SPEC, deliverable: DELIVERABLE }),
      milestone({ amount: 3000000n, released: 0n, status: "Pending",
        deliveredAt: 0, funded: false, spec: Buffer.alloc(32), deliverable: Buffer.alloc(32) }),
    ])),
    entry("token", addr(TOKEN)),
  ]);
}

describe("parseJobFromResult (#863)", () => {
  it("returns every Job and Milestone field", () => {
    const job = parseJobFromResult({ result: { retval: jobRetval() } }, "CID");
    expect(job).toEqual({
      id: "CID",
      client: CLIENT,
      freelancer: FREELANCER,
      arbiter: ARBITER,
      token: TOKEN,
      funded: true,
      autoReleaseSeconds: 604800,
      milestones: [
        {
          index: 0, amount: "5000000", releasedAmount: "2000000",
          status: "PartiallyReleased", deliveredAt: 1700000000, funded: true,
          specHash: "ab".repeat(32), deliverable: "00ff".repeat(16),
        },
        {
          index: 1, amount: "3000000", releasedAmount: "0",
          status: "Pending", deliveredAt: 0, funded: false,
          specHash: null, deliverable: null,
        },
      ],
    });
  });
});
