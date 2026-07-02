import { z } from "zod";
import { isValidStellarContractId, isValidStellarAddress } from "../utils/stellar.js";

// ---------------------------------------------------------------------------
// Reusable field schemas
// ---------------------------------------------------------------------------

/**
 * Validates a Soroban contract address: starts with 'C', 56 characters total,
 * and passes the Stellar SDK StrKey check.
 */
export const contractIdSchema = z
  .string({ required_error: "contractId is required" })
  .refine(isValidStellarContractId, {
    message: "contractId must be a valid Stellar contract address (C...)",
  });

/**
 * Validates a Stellar account (G…) address: starts with 'G', 56 characters,
 * passes StrKey.isValidEd25519PublicKey.
 */
export const stellarAddressSchema = z
  .string({ required_error: "address is required" })
  .refine((v) => StrKey.isValidEd25519PublicKey(v), {
    message: "address must be a valid Stellar account address (G…, 56 chars)",
  });

/**
 * Milestone index: non-negative integer (supplied as a URL param string or number).
 */
export const milestoneIndexSchema = z
  .union([z.string(), z.number()])
  .transform((v) => {
    const n = typeof v === "number" ? v : parseInt(v, 10);
    return n;
  })
  .refine((n) => Number.isInteger(n) && n >= 0, {
    message: "index must be a non-negative integer",
  });

/**
 * Amount: a positive numeric string or integer that can be coerced to BigInt.
 * Accepts strings like "100", "100000000", or plain numbers.
 */
export const amountSchema = z
  .union([z.string(), z.number(), z.bigint()])
  .refine(
    (v) => {
      try {
        const n = BigInt(v as string | number | bigint);
        return n > 0n;
      } catch {
        return false;
      }
    },
    { message: "amount must be a positive numeric value" },
  );

// ---------------------------------------------------------------------------
// Composed route schemas
// ---------------------------------------------------------------------------

/** Route params: /:contractId */
export const contractIdParamsSchema = z.object({
  contractId: contractIdSchema,
});

/** Route params: /:contractId/milestones/:index */
export const contractMilestoneParamsSchema = z.object({
  contractId: contractIdSchema,
  index: milestoneIndexSchema,
});

/** POST /build-tx body */
export const buildTxBodySchema = z.object({
  contractId: contractIdSchema,
  method: z.string({ required_error: "method is required" }).min(1, "method cannot be empty"),
  args: z.array(z.any()).optional().default([]),
  sourceAddress: stellarAddressSchema,
});

/** POST /submit body */
export const submitBodySchema = z.object({
  signedXdr: z
    .string({ required_error: "signedXdr is required" })
    .min(1, "signedXdr cannot be empty"),
});

/** POST /:contractId/milestones/:index/partial-release body */
export const partialReleaseBodySchema = z.object({
  amount: amountSchema,
  sourceAddress: stellarAddressSchema,
});

/** POST /:contractId/milestones/:index/claim-auto-release body */
export const claimAutoReleaseBodySchema = z.object({
  sourceAddress: stellarAddressSchema,
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
