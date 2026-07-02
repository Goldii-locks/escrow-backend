import { z } from "zod";
import { isValidStellarContractId, isValidStellarAddress } from "../utils/stellar.js";

export const contractIdParamsSchema = z.object({
  contractId: z
    .string({ required_error: "contractId is required" })
    .refine(isValidStellarContractId, {
      message: "contractId must be a valid Stellar contract address (C...)",
    }),
});

export type ContractIdParams = z.infer<typeof contractIdParamsSchema>;

export const whitelistParamsSchema = z.object({
  contractId: z
    .string({ required_error: "contractId is required" })
    .refine(isValidStellarContractId, {
      message: "contractId must be a valid Stellar contract address (C...)",
    }),
});

export type WhitelistParams = z.infer<typeof whitelistParamsSchema>;

export const partialReleaseParamsSchema = z.object({
  contractId: z
    .string({ required_error: "contractId is required" })
    .refine(isValidStellarContractId, {
      message: "contractId must be a valid Stellar contract address (C...)",
    }),
  index: z
    .string({ required_error: "index is required" })
    .regex(/^\d+$/, { message: "index must be a non-negative integer" }),
});

export const partialReleaseBodySchema = z.object({
  amount: z
    .union([z.string(), z.number()])
    .refine(
      (val) => {
        try {
          return BigInt(String(val)) > 0n;
        } catch {
          return false;
        }
      },
      { message: "amount must be a positive integer" },
    ),
  sourceAddress: z
    .string({ required_error: "sourceAddress is required" })
    .refine(isValidStellarAddress, {
      message: "sourceAddress must be a valid Stellar account address (G...)",
    }),
});
