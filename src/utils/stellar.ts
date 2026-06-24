import { StrKey } from "@stellar/stellar-sdk";

/** Returns true when `contractId` is a valid Soroban contract address (C...). */
export function isValidStellarContractId(contractId: string): boolean {
  return typeof contractId === "string" && StrKey.isValidContract(contractId);
}
