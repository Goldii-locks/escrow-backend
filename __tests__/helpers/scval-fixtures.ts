import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";

/** Deterministic, valid G-address for fixture slot `n`. */
export const testAddress = (n: number): string =>
  Keypair.fromRawEd25519Seed(Buffer.alloc(32, n)).publicKey();

export const CLIENT = testAddress(1);
export const FREELANCER = testAddress(2);
export const ARBITER = testAddress(3);
export const TOKEN = testAddress(4);

/** Build a real get_job retval ScVal (an scvMap, as the contract returns). */
export function jobScVal(
  milestones: Array<{ amount: bigint; status: string }> = [{ amount: 100n, status: "Pending" }],
  funded = true,
): xdr.ScVal {
  return nativeToScVal({
    client: new Address(CLIENT).toScVal(),
    freelancer: new Address(FREELANCER).toScVal(),
    arbiter: new Address(ARBITER).toScVal(),
    token: new Address(TOKEN).toScVal(),
    funded: xdr.ScVal.scvBool(funded),
    milestones: xdr.ScVal.scvVec(
      milestones.map((m) =>
        nativeToScVal({
          amount: nativeToScVal(m.amount, { type: "i128" }),
          status: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(m.status)]),
        }),
      ),
    ),
  });
}

/** Build a real get_whitelisted_tokens retval: an scvVec of Address ScVals. */
export const tokenVecScVal = (...addresses: string[]): xdr.ScVal =>
  xdr.ScVal.scvVec(addresses.map((a) => new Address(a).toScVal()));
