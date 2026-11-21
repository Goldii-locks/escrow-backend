import { StrKey } from "@stellar/stellar-sdk";

/** Returns true when `contractId` is a valid Soroban contract address (C...). */
export function isValidStellarContractId(contractId: string): boolean {
  return typeof contractId === "string" && StrKey.isValidContract(contractId);
}

/** Returns true when `address` is a valid Stellar account address (G...). */
export function isValidStellarAddress(address: string): boolean {
  return typeof address === "string" && StrKey.isValidEd25519PublicKey(address);
}

/**
 * Truncate a Stellar address to `GABC…WXYZ` for info-level logs.
 *
 * Full addresses must never appear at `info` (the production log level)
 * because the HTTP request logger records the caller's IP on every request,
 * so logging the full address alongside it builds a durable IP↔wallet map.
 * Four leading + four trailing characters are enough for same-session
 * correlation without exposing the complete key.
 */
export function maskAddress(address: string | undefined | null): string {
  if (!address || address.length < 10) return address ?? "";
  return `${address.slice(0, 4)}\u2026${address.slice(-4)}`;
}
