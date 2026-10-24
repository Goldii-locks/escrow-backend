import { Router } from "express";
import type { Request, Response } from "express";
import {
  createJobDraftRateLimit,
  createJobDraftCors,
  createJobDraftSecurityHeaders,
  sendError,
  sendSuccess,
  createJobDraftValidation,
  logger,
  randomUUID,
} from "./shared.js";
import type {
  CreateJobDraftBody,
  CreateJobDraftLegacyBody,
} from "./shared.js";

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/jobs/create-job-draft
// Validates and stores a job draft payload (off-chain) before on-chain create.
// ---------------------------------------------------------------------------
router.options("/create-job-draft", createJobDraftCors);

/**
 * Two PRs implemented POST /create-job-draft independently and both were
 * merged, leaving two `router.post("/create-job-draft", …)` registrations. Only
 * the first could ever run, so the second PR's rate limiter was dead code and
 * its tests failed. They are collapsed here into one route that honours both
 * contracts: the body is validated against whichever schema matches the field
 * naming used, and the response carries both shapes. The Zod request-shape
 * validation itself lives in the reusable `createJobDraftValidation`
 * middleware (see `middleware/create-job-draft-validation.ts`).
 */

router.post(
  "/create-job-draft",
  createJobDraftCors,
  createJobDraftSecurityHeaders,
  createJobDraftRateLimit,
  createJobDraftValidation,
  (req: Request, res: Response) => {
    const traceId = randomUUID();
    const pathVars = { route: "/api/jobs/create-job-draft" };

    logger.debug("Create-job-draft handler entered", {
      traceId,
      ...pathVars,
      bodyKeys: Object.keys((req.body as Record<string, unknown>) ?? {}),
      ip: req.ip ?? req.socket?.remoteAddress,
    });

    try {
      const body = req.body as Partial<CreateJobDraftBody> &
        Partial<CreateJobDraftLegacyBody>;

      const client = body.client ?? body.clientAddress;
      const freelancer = body.freelancer ?? body.freelancerAddress;
      const arbiter = body.arbiter ?? body.arbiterAddress;
      const token = body.token ?? body.tokenAddress;

      const draft = {
        id: randomUUID(),
        status: "draft" as const,
        client,
        freelancer,
        arbiter,
        token,
        autoReleaseDays: body.autoReleaseDays,
        milestones: body.milestones,
        acceptedAssets: body.acceptedAssets,
        requirements: body.requirements,
        createdAt: new Date().toISOString(),
        // `*Address` naming echoed back for the second PR's response contract.
        draft: {
          clientAddress: client,
          freelancerAddress: freelancer,
          arbiterAddress: arbiter,
          tokenAddress: token,
          milestones: body.milestones,
        },
      };

      logger.debug("Create-job-draft draft built", {
        traceId,
        ...pathVars,
        milestoneCount: body.milestones?.length ?? 0,
      });

      logger.info("Job draft created", {
        traceId,
        ...pathVars,
        client,
        freelancer,
        arbiter,
        token,
        milestoneCount: body.milestones?.length ?? 0,
      });

      sendSuccess(res, draft);

      logger.debug("Create-job-draft response sent", {
        traceId,
        ...pathVars,
        status: 200,
        success: true,
        draftId: draft.id,
        milestoneCount: body.milestones?.length ?? 0,
      });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      logger.error("Failed to create job draft", {
        traceId,
        ...pathVars,
        error: message,
        stack: err?.stack,
      });
      sendError(res, 500, "Internal server error");
    }
  },
);
export default router;
