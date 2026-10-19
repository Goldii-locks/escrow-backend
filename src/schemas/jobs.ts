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

/** Largest value the escrow contract's i128 amounts can hold. */
export const I128_MAX = (1n << 127n) - 1n;
/** Largest value a Soroban u64 argument can hold. */
export const U64_MAX = (1n << 64n) - 1n;

const DECIMAL_DIGITS = /^[0-9]+$/;

/**
 * Builds a strict on-chain amount schema (#678).
 *
 * Only plain decimal-digit strings are accepted. JSON numbers are rejected
 * outright: anything above 2^53 has already lost precision by the time
 * JSON.parse hands it to us, so silently accepting them would build a
 * transaction for a different amount than the user typed. Values must be in
 * 1..i128::MAX.
 *
 * `invalidMessage` is used for strings that are not a positive integer, so
 * each route can keep its existing wording.
 */
export function positiveAmountStringSchema(
  field = "amount",
  invalidMessage = `${field} must be a positive integer`,
) {
  return z
    .unknown()
    .superRefine((value, ctx) => {
      if (value === undefined || value === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} is required` });
        return;
      }
      if (typeof value !== "string") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} must be a string of digits`,
        });
        return;
      }
      if (!DECIMAL_DIGITS.test(value) || BigInt(value) <= 0n) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: invalidMessage });
        return;
      }
      if (BigInt(value) > I128_MAX) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} must not exceed i128::MAX (${I128_MAX})`,
        });
      }
    })
    .transform((value) => value as string);
}

/**
 * Amount: a positive decimal string within i128 range. JSON numbers are
 * rejected with "amount must be a string of digits".
 */
export const amountSchema = positiveAmountStringSchema(
  "amount",
  "amount must be a positive numeric value",
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
// build-tx contract method allowlist (#709)
// ---------------------------------------------------------------------------

/**
 * User-facing Milesto escrow entry points the frontend may build
 * transactions for via POST /build-tx. Everything else (e.g. `transfer`)
 * is rejected with 400 before any RPC call is made.
 *
 * Sources: issue #709 method list, backend `contract.call` usages, and the
 * whitelist-management methods with dedicated arg validation in
 * `src/routes/jobs.ts`.
 */
export const BUILD_TX_ALLOWED_METHODS = [
  "initialize",
  "fund",
  "mark_delivered",
  "approve_milestone",
  "approve_partial",
  "raise_dispute",
  "resolve_dispute",
  "claim_auto_release",
  "add_whitelisted_token",
  "remove_whitelisted_token",
  // Admin pause switch, called from the frontend admin page.
  "admin_pause_escrow",
  "admin_resume_escrow",
] as const;

export type BuildTxMethod = (typeof BUILD_TX_ALLOWED_METHODS)[number];

/** i128 build-tx arguments are escrow amounts: same rules as body amounts. */
const i128ArgValueSchema = positiveAmountStringSchema("amount");

/**
 * Validates the `value` of one typed build-tx argument. Only the 64/128-bit
 * integer types are checked: they are the ones that lose precision when sent
 * as JSON numbers (#678). Other types keep their existing pass-through.
 */
function checkTypedArg(arg: unknown, path: (string | number)[], ctx: z.RefinementCtx): void {
  if (typeof arg !== "object" || arg === null) return;
  const { type, value } = arg as { type?: unknown; value?: unknown };

  if (type === "i128") {
    const result = i128ArgValueSchema.safeParse(value);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.message, path: [...path, "value"] });
      }
    }
    return;
  }

  if (type === "u64") {
    let message: string | undefined;
    if (typeof value !== "string") {
      message = "u64 value must be a string of digits";
    } else if (!DECIMAL_DIGITS.test(value)) {
      message = "u64 value must be a non-negative integer";
    } else if (BigInt(value) > U64_MAX) {
      message = `u64 value must not exceed u64::MAX (${U64_MAX})`;
    }
    if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [...path, "value"] });
    return;
  }

  if (type === "vec" && Array.isArray(value)) {
    value.forEach((item, i) => checkTypedArg(item, [...path, "value", i], ctx));
  }
}

const buildTxArgsSchema = z
  .array(z.any())
  .optional()
  .default([])
  .superRefine((args, ctx) => {
    args.forEach((arg, i) => checkTypedArg(arg, [i], ctx));
  });

// ---------------------------------------------------------------------------
// Composed route schemas
// ---------------------------------------------------------------------------

/** Route params: /:contractId */
export const contractIdParamsSchema = z.object({
  contractId: contractIdSchema,
});

/** Route params: /:contractId/whitelist */
export const whitelistParamsSchema = z.object({
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
  // The contract method name to call — restricted to the Milesto escrow's
  // user-facing entry points so the endpoint can't be used as a
  // general-purpose transaction builder on the backend's RPC quota (#709).
  // Kept as z.string (not z.enum) so type errors keep their existing
  // messages ("Expected string, received boolean").
  method: z
    .string({ required_error: "method is required" })
    .min(1, "method cannot be empty")
    // Empty strings are left to .min(1) so they keep their own message.
    .refine((m) => m === "" || (BUILD_TX_ALLOWED_METHODS as readonly string[]).includes(m), {
      message: `method must be one of: ${BUILD_TX_ALLOWED_METHODS.join(", ")}`,
    }),
  // Optional arguments for the method, defaults to an empty array. i128/u64
  // values must be decimal strings so they reach the XDR unrounded (#678).
  args: buildTxArgsSchema,
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
 * partial-release.test.ts asserts on these exact strings. JSON numbers are
 * rejected with "amount must be a string of digits" (#678).
 */
export const partialReleaseBodySchema = z.object({
  amount: positiveAmountStringSchema("amount"),
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
        amount: positiveAmountStringSchema("amount"),
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

/**
 * POST /:contractId/whitelist/update body.
 * Validates the token address and the action (add/remove).
 */
export const whitelistUpdateBodySchema = z.object({
  token: z
    .string({
      required_error: "token is required",
      invalid_type_error: "token must be a string",
    })
    .min(1, "token cannot be empty")
    .refine(isValidStellarContractId, {
      message: "token must be a valid Stellar contract address (C...)",
    }),
  action: z
    .enum(["add", "remove"], {
      required_error: "action is required",
      invalid_type_error: "action must be one of: add, remove",
    }),
  adminAddress: stellarAccountField("adminAddress"),
}).strict();

export type WhitelistUpdateBody = z.infer<typeof whitelistUpdateBodySchema>;

export type CreateJobDraftLegacyBody = z.infer<typeof createJobDraftLegacyBodySchema>;

/**
 * Validates a Stellar address that can be either a public key account address (G...)
 * or a Soroban contract address (C...).
 */
export const stellarAddressOrContractSchema = z
  .string({ required_error: "Address is required" })
  .refine((v) => isValidStellarAddress(v) || isValidStellarContractId(v), {
    message: "Invalid Stellar address",
  });

/**
 * POST /:contractId/whitelist/update body schema.
 * Accepts `addresses` (or `tokens` fallback) array containing valid Stellar addresses.
 */
export const updateWhitelistBodySchema = z
  .object({
    addresses: z
      .array(stellarAddressOrContractSchema, {
        required_error: "addresses array is required",
        invalid_type_error: "addresses must be an array",
      })
      .optional(),
    tokens: z
      .array(stellarAddressOrContractSchema, {
        invalid_type_error: "tokens must be an array",
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    const addresses = data.addresses ?? data.tokens;
    if (!addresses) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "addresses array is required",
        path: ["addresses"],
      });
      return;
    }
    if (addresses.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "addresses array cannot be empty",
        path: ["addresses"],
      });
    }
  });

export type UpdateWhitelistBody = z.infer<typeof updateWhitelistBodySchema>;

/**
 * POST /:contractId/whitelist/update accepts two historical body shapes:
 *
 * - the single-token form `{ token, action, adminAddress }`
 *   (`whitelistUpdateBodySchema`), and
 * - the bulk form `{ addresses | tokens }` (`updateWhitelistBodySchema`).
 *
 * A plain `z.union` would collapse both branches into one `invalid_union`
 * issue with an empty path, and the route's error responses are asserted
 * field-by-field. So dispatch on the shape instead and forward the chosen
 * branch's issues verbatim, which keeps `details[].field` populated.
 *
 * An ambiguous body (neither `addresses` nor `tokens` present) is reported
 * against the single-token form, so an empty `{}` lists token/action/
 * adminAddress as missing.
 */
export const whitelistUpdateRequestSchema = z
  .object({})
  .passthrough()
  .superRefine((data, ctx) => {
    const body = (data ?? {}) as Record<string, unknown>;
    const isBulkForm = "addresses" in body || "tokens" in body;
    const branch = isBulkForm
      ? updateWhitelistBodySchema
      : whitelistUpdateBodySchema;

    const result = branch.safeParse(body);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue(issue);
      }
    }
  });

export type WhitelistUpdateRequestBody =
  | WhitelistUpdateBody
  | UpdateWhitelistBody;

export type ContractIdParams = z.infer<typeof contractIdParamsSchema>;
export type ContractMilestoneParams = z.infer<typeof contractMilestoneParamsSchema>;
export type WhitelistParams = z.infer<typeof whitelistParamsSchema>;
export type BuildTxBody = z.infer<typeof buildTxBodySchema>;
export type SubmitBody = z.infer<typeof submitBodySchema>;
export type PartialReleaseBody = z.infer<typeof partialReleaseBodySchema>;
export type ClaimAutoReleaseBody = z.infer<typeof claimAutoReleaseBodySchema>;
export type ByWalletParams = z.infer<typeof byWalletParamsSchema>;
export type ByWalletQuery = z.infer<typeof byWalletQuerySchema>;
export type CreateJobDraftBody = z.infer<typeof createJobDraftBodySchema>;

/**
 * Query params: ?amount=<stroops> for GET /:contractId/fee-preview.
 * Validates `amount` as a positive i128 decimal string (#719).
 */

export const feePreviewQuerySchema = z.object({
  amount: z
    .string({ required_error: "amount is required" })
    .refine(
      (val) => {
        // Plain decimal digits only: BigInt() would also accept "0x10" or " 5".
        if (!/^\d+$/.test(val)) return false;
        const n = BigInt(val);
        return n > 0n && n <= I128_MAX;
      },
      { message: "amount must be a positive i128 decimal string" },
    ),
});

export type FeePreviewQuery = z.infer<typeof feePreviewQuerySchema>;
