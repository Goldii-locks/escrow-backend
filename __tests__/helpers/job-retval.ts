import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";

/** Distinct, valid parties for get_job fixtures. */
export const JOB_PARTIES = {
  client: Keypair.random().publicKey(),
  freelancer: Keypair.random().publicKey(),
  arbiter: Keypair.random().publicKey(),
  token: "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH",
};

const entry = (key: string, val: xdr.ScVal) =>
  new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });

/**
 * Encode a `get_job` return value the way the escrow contract does: a
 * #[contracttype] struct is an ScMap keyed by field-name symbols (sorted), and
 * a unit enum variant is a one-element vec holding the variant symbol.
 */
export function jobRetval(opts: {
  funded: boolean;
  milestones: Array<{ amount: string; status: string }>;
}): xdr.ScVal {
  const milestones = opts.milestones.map((m) =>
    xdr.ScVal.scvMap([
      entry("amount", nativeToScVal(BigInt(m.amount), { type: "i128" })),
      entry("delivered_at", nativeToScVal(0n, { type: "u64" })),
      entry("funded", xdr.ScVal.scvBool(opts.funded)),
      entry("released_amount", nativeToScVal(0n, { type: "i128" })),
      entry("spec_hash", xdr.ScVal.scvBytes(Buffer.alloc(32))),
      entry("status", xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(m.status)])),
    ]),
  );

  return xdr.ScVal.scvMap([
    entry("arbiter", Address.fromString(JOB_PARTIES.arbiter).toScVal()),
    entry("auto_release_seconds", nativeToScVal(604800n, { type: "u64" })),
    entry("client", Address.fromString(JOB_PARTIES.client).toScVal()),
    entry("freelancer", Address.fromString(JOB_PARTIES.freelancer).toScVal()),
    entry("funded", xdr.ScVal.scvBool(opts.funded)),
    entry("milestones", xdr.ScVal.scvVec(milestones)),
    entry("token", Address.fromString(JOB_PARTIES.token).toScVal()),
  ]);
}
