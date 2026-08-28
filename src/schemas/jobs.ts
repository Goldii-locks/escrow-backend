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
export const contractIdSchema = z.unknown().superRefine((value, ctx) => {
  if (value === undefined || value === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "contractId is required",
    });
    return;
  }

  if (typeof value !== "string") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "contractId must be a valid Stellar contract address (C...)",
    });
    return;
  }

  if (!isValidStellarContractId(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "contractId must be a valid Stellar contract address (C...)",
    });
  }
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

/**
 * Named Stellar account field (G…) with field-specific error messages.
 */
const stellarAccountField = (field: string) =>
  z
    .string({ required_error: `${field} is required` })
    .refine(isValidStellarAddress, {
      message: `${field} must be a valid Stellar account address (G...)`,
    });

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

/** POST /build-tx body schema validation */
export const buildTxBodySchema = z.object({
  // Must be a valid Soroban contract ID
  contractId: contractIdSchema,
  // The contract method name to call
  method: z.string({ required_error: "method is required" }).min(1, "method cannot be empty"),
  // Optional arguments for the method, defaults to an empty array
  args: z.array(z.any()).optional().default([]),
  // The Stellar address of the transaction source account
  sourceAddress: stellarAccountField("sourceAddress"),
});

/** POST /submit body */
export const submitBodySchema = z.object({
  signedXdr: z
    .string({ required_error: "signedXdr is required", invalid_type_error: "signedXdr must be a string" })
    .min(1, "signedXdr cannot be empty")
    .refine((v) => !/\s/.test(v), {
      message: "signedXdr must not contain whitespace",
    })
    .refine(
      (v) => {
        // Valid base64: only A-Z a-z 0-9 + / = characters, length divisible by 4
        return /^[A-Za-z0-9+/]*={0,2}$/.test(v) && v.length % 4 === 0;
      },
      { message: "signedXdr must be a valid base64-encoded XDR string" },
    ),
  sourceAddress: stellarAccountField("sourceAddress").optional(),
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
  sourceAddress: stellarAccountField("sourceAddress"),
}).strict();

/**
 * POST /:contractId/whitelist/update body.
 * Builds an unsigned tx to add or remove a token from the contract whitelist.
 */
export const whitelistUpdateBodySchema = z
  .object({
    token: z
      .string({ required_error: "token is required", invalid_type_error: "token must be a string" })
      .refine(isValidStellarContractId, {
        message: "token must be a valid Stellar contract address (C...)",
      }),
    action: z.enum(["add", "remove"], {
      required_error: "action is required",
      invalid_type_error: "action must be 'add' or 'remove'",
    }),
    sourceAddress: stellarAccountField("sourceAddress"),
  })
  .strict();

/** Route params: /by-wallet/:address */
export const byWalletParamsSchema = z.object({
  address: stellarAddressSchema,
});

/** Query params: ?page=&limit= for GET /by-wallet/:address */
export const byWalletQuerySchema = z.object({
  page: z
    .union([z.string(), z.number()])
    .optional()
    .default("1")
    .refine(
      (v) =>
        typeof v === "number"
          ? Number.isInteger(v) && v >= 1
          : /^\d+$/.test(v) && parseInt(v, 10) >= 1,
      { message: "page must be a positive integer" },
    )
    .transform((v) => (typeof v === "number" ? v : parseInt(v, 10))),
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .default("10")
    .refine(
      (v) =>
        typeof v === "number"
          ? Number.isInteger(v) && v >= 1 && v <= 100
          : /^\d+$/.test(v) &&
            parseInt(v, 10) >= 1 &&
            parseInt(v, 10) <= 100,
      { message: "limit must be between 1 and 100" },
    )
    .transform((v) => (typeof v === "number" ? v : parseInt(v, 10))),
});

/**
 * POST /create-job-draft body.
 * Validates payload shape/types and Stellar address formats for all party/token fields.
 */
export const createJobDraftBodySchema = z.object({
  client: stellarAccountField("client").optional(),
  freelancer: stellarAccountField("freelancer"),
  arbiter: stellarAccountField("arbiter"),
  token: z
    .string({ required_error: "token is required" })
    .refine(isValidStellarContractId, {
      message: "token must be a valid Stellar contract address (C...)",
    }),
  autoReleaseDays: z
    .any({ required_error: "autoReleaseDays is required" })
    .refine((v) => typeof v === "string" || typeof v === "number", {
      message: "autoReleaseDays must be a number",
    })
    .refine(
      (v) => {
        const n = typeof v === "number" ? v : Number(v);
        return Number.isInteger(n) && n >= 1 && n <= 365;
      },
      { message: "autoReleaseDays must be an integer between 1 and 365" },
    )
    .transform((v) => (typeof v === "number" ? v : parseInt(String(v), 10))),
  milestones: z
    .array(
      z.object({
        amount: z
          .union([z.string(), z.number()], {
            invalid_type_error: "amount must be a positive integer",
          })
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
      }),
      { required_error: "milestones is required", invalid_type_error: "milestones must be an array" },
    )
    .min(1, "milestones must contain at least one milestone"),
  acceptedAssets: z.array(z.string()).optional().default([]),
  requirements: z.array(z.string()).optional().default([]),
});

/**
 * POST /create-job-draft body — `*Address` naming variant.
 *
 * Two PRs shipped this endpoint with different field names, response shapes,
 * and token-validation strictness, and both were merged. This variant keeps a
 * permissive `.min(1)` token rule (its own tests post a token that is not a
 * valid 56-char contract id); the variant above enforces a real C… address.
 * `createJobDraftRouteValidator` in routes/jobs.ts picks between them by shape.
 */
export const createJobDraftLegacyBodySchema = z.object({
  clientAddress: stellarAddressSchema,
  freelancerAddress: stellarAddressSchema,
  arbiterAddress: stellarAddressSchema,
  tokenAddress: z
    .string({ required_error: "tokenAddress is required" })
    .min(1, "tokenAddress cannot be empty"),
  milestones: z
    .array(
      z.object({
        amount: amountSchema,
      }),
      { required_error: "milestones is required" },
    )
    .min(1, "milestones must contain at least one entry"),
});

export type CreateJobDraftLegacyBody = z.infer<typeof createJobDraftLegacyBodySchema>;

export type ContractIdParams = z.infer<typeof contractIdParamsSchema>;
export type ContractMilestoneParams = z.infer<typeof contractMilestoneParamsSchema>;
export type BuildTxBody = z.infer<typeof buildTxBodySchema>;
export type SubmitBody = z.infer<typeof submitBodySchema>;
export type PartialReleaseBody = z.infer<typeof partialReleaseBodySchema>;
export type ClaimAutoReleaseBody = z.infer<typeof claimAutoReleaseBodySchema>;
export type WhitelistUpdateBody = z.infer<typeof whitelistUpdateBodySchema>;
export type ByWalletParams = z.infer<typeof byWalletParamsSchema>;
export type ByWalletQuery = z.infer<typeof byWalletQuerySchema>;
export type CreateJobDraftBody = z.infer<typeof createJobDraftBodySchema>;
