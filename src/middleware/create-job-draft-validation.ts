import type { NextFunction, Request, Response } from "express";
import {
  createJobDraftBodySchema,
  createJobDraftLegacyBodySchema,
} from "../schemas/jobs.js";
import { validate } from "./validate.js";
import logger from "../utils/logger.js";

/**
 * Field names used by the legacy `*Address` naming variant of the
 * create-job-draft body.
 */
const ADDRESS_SUFFIX_FIELDS = [
  "clientAddress",
  "freelancerAddress",
  "arbiterAddress",
  "tokenAddress",
];

function usesAddressSuffix(body: unknown): boolean {
  return (
    !!body &&
    typeof body === "object" &&
    ADDRESS_SUFFIX_FIELDS.some(
      (field) => field in (body as Record<string, unknown>),
    )
  );
}

/**
 * Reusable Zod request-shape validation middleware for
 * POST /api/jobs/create-job-draft.
 *
 * Two merged PRs shipped the endpoint with different field naming, so the
 * middleware picks the matching schema based on the body shape:
 *  - `client` / `freelancer` / `arbiter` / `token` → `createJobDraftBodySchema`
 *  - `clientAddress` / `freelancerAddress` / …    → `createJobDraftLegacyBodySchema`
 *
 * Invalid payloads are rejected with a 400 `ValidationError` response carrying
 * a field-by-field `details` array (see `middleware/validate.ts`), so malformed
 * formats are reported back as field validation errors before the handler runs.
 */
export function createJobDraftValidation(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const schema = usesAddressSuffix(req.body)
    ? createJobDraftLegacyBodySchema
    : createJobDraftBodySchema;

  validate(schema, "body", (r) =>
    logger.warn("Invalid create-job-draft request body", { body: r.body }),
  )(req, res, next);
}
