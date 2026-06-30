import type { Request, Response, NextFunction } from "express";
import { z, ZodError, ZodSchema } from "zod";
import { sendError } from "../utils/api-response.js";
import { isValidStellarContractId } from "../utils/stellar.js";

/**
 * Shape of a request that can be validated.
 * Each key maps to a Zod schema that will be used to parse the
 * corresponding part of the Express request object.
 */
export interface RequestSchemas {
  params?: ZodSchema;
  query?: ZodSchema;
  body?: ZodSchema;
}

/**
 * Formats a ZodError into a single, human-readable message that lists every
 * field-level issue.  Example: `"contractId: Invalid input"`.
 */
export function formatZodError(err: ZodError): string {
  return err.errors
    .map((issue) => {
      const field = issue.path.join(".");
      return field ? `${field}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/**
 * Returns an Express middleware that validates the request against the
 * provided Zod schemas.  On failure it responds with 400 and a structured
 * error body that lists every field-level validation issue.  On success it
 * calls `next()` so the route handler can proceed.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { validateRequest } from "../middleware/validate-request.js";
 *
 * router.get(
 *   "/:contractId/whitelist",
 *   validateRequest({
 *     params: z.object({ contractId: whitelistParamsSchema.shape.contractId }),
 *   }),
 *   handler,
 * );
 * ```
 */
export function validateRequest(schemas: RequestSchemas) {
  return function validationMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    // Validate params
    if (schemas.params) {
      const result = schemas.params.safeParse(req.params);
      if (!result.success) {
        sendError(res, 400, formatZodError(result.error));
        return;
      }
    }

    // Validate query string
    if (schemas.query) {
      const result = schemas.query.safeParse(req.query);
      if (!result.success) {
        sendError(res, 400, formatZodError(result.error));
        return;
      }
    }

    // Validate request body
    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (!result.success) {
        sendError(res, 400, formatZodError(result.error));
        return;
      }
    }

    next();
  };
}

/**
 * Zod schema for the `:contractId` route parameter shared by all
 * `/api/jobs/:contractId/*` endpoints.
 *
 * Rules:
 *  - Must be a string
 *  - Exactly 56 characters
 *  - Must start with the letter "C" (Soroban contract addresses always do)
 *  - Must be a valid Soroban contract address per the Stellar StrKey format
 *
 * The custom `.refine()` delegates to the same `isValidStellarContractId`
 * helper used elsewhere in the codebase so the validation logic stays in one
 * place.
 */

export const contractIdParamSchema = z.object({
  contractId: z
    .string({ required_error: "contractId is required" })
    .length(56, {
      message: "contractId must be a valid Stellar contract address (C...)",
    })
    .refine(isValidStellarContractId, {
      message: "contractId must be a valid Stellar contract address (C...)",
    }),
});
