import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";
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
 * Validated against the raw value before transforming, since parseInt() would
 * otherwise silently truncate decimal strings like "1.5" down to 1.
 */
export const milestoneIndexSchema = z
  .union([z.string(), z.number()])
  .refine(
    (v) => (typeof v === "number" ? Number.isInteger(v) && v >= 0 : /^\d+$/.test(v)),
    { message: "index must be a non-negative integer" },
  )
  .transform((v) => (typeof v === "number" ? v : parseInt(v, 10)));

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

const argSchema = z.object({
  type: z.string(),
  value: z.any(),
}).passthrough();

const buildTxArgSchema = argSchema.refine(
  (arg) => {
    if (arg.type === "address") {
      return StrKey.isValidEd25519PublicKey(arg.value);
    }
    return true;
  },
  (arg) => ({
    message: `Argument of type "address" must be a valid Stellar account address (G…, 56 chars), got ${JSON.stringify(arg.value)}`,
  }),
);

/** POST /build-tx body */
export const buildTxBodySchema = z.object({
  contractId: contractIdSchema,
  method: z.string({ required_error: "method is required" }).min(1, "method cannot be empty"),
  args: z.array(buildTxArgSchema).optional().default([]),
  sourceAddress: stellarAddressSchema,
});

/** POST /submit body */
export const submitBodySchema = z.object({
  signedXdr: z
    .string({ required_error: "signedXdr is required" })
    .min(1, "signedXdr cannot be empty"),
});

/**
 * POST /:contractId/milestones/:index/partial-release body.
 * Keeps its pre-existing field-specific error wording (rather than the
 * generic amountSchema/stellarAddressSchema messages) since __tests__/
 * partial-release.test.ts asserts on these exact strings.
 */
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

/** POST /:contractId/milestones/:index/claim-auto-release body */
export const claimAutoReleaseBodySchema = z.object({
  sourceAddress: stellarAddressSchema,
});

export type ContractIdParams = z.infer<typeof contractIdParamsSchema>;
export type ContractMilestoneParams = z.infer<typeof contractMilestoneParamsSchema>;
export type BuildTxBody = z.infer<typeof buildTxBodySchema>;
export type SubmitBody = z.infer<typeof submitBodySchema>;
export type PartialReleaseBody = z.infer<typeof partialReleaseBodySchema>;
export type ClaimAutoReleaseBody = z.infer<typeof claimAutoReleaseBodySchema>;
