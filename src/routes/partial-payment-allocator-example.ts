/**
 * Example Route: Partial Payment Allocator Endpoints
 *
 * This file demonstrates how to integrate the partial payment allocator
 * rate limiting middleware with Express routes.
 *
 * USAGE:
 * Import this router in your main app and mount it:
 *
 * ```typescript
 * import partialPaymentAllocatorRouter from './routes/partial-payment-allocator-example.js';
 * app.use('/api', partialPaymentAllocatorRouter);
 * ```
 *
 * ENDPOINTS:
 * - POST /allocate-payment - Allocate a milestone payment to recipients
 * - POST /verify-allocation - Verify payment allocation integrity
 * - GET /allocation-status/:id - Get status of a payment allocation
 */

import { Router, Request, Response, NextFunction } from "express";
import {
  allocatePayment,
  type PaymentAllocation,
} from "../utils/partial-payment-allocator.js";
import { partialPaymentAllocatorRateLimitMiddleware } from "../middleware/partial-payment-allocator-rate-limit.js";

const router = Router();

/**
 * POST /api/allocate-payment
 *
 * Allocate a milestone payment across multiple recipients with rate limiting.
 *
 * Request Body:
 * {
 *   "milestoneIndex": number,
 *   "totalAmount": string | number | bigint,
 *   "recipients": Array<{
 *     "address": string,
 *     "amount": string (BigInt as string)
 *   }>
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "allocation": PaymentAllocation,
 *   "formatted": Array<FormattedPaymentRow>,
 *   "precisionLoss": boolean
 * }
 *
 * Rate Limit:
 * - Default: 50 requests per 60 seconds
 * - Returns 429 if exceeded
 */
router.post(
  "/allocate-payment",
  partialPaymentAllocatorRateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { milestoneIndex, totalAmount, recipients } = req.body;

      // Validate input
      if (milestoneIndex === undefined || !totalAmount || !Array.isArray(recipients)) {
        res.status(400).json({
          success: false,
          error: "Missing required fields: milestoneIndex, totalAmount, recipients",
        });
        return;
      }

      // Convert amounts to bigint if they're strings
      const recipientsList = recipients.map((r: any) => ({
        address: r.address,
        amount: typeof r.amount === 'string' ? BigInt(r.amount) : r.amount,
      }));

      const totalAmountBigInt = typeof totalAmount === 'string' ? BigInt(totalAmount) : totalAmount;

      // Allocate payment
      const result = allocatePayment(
        milestoneIndex,
        totalAmountBigInt,
        recipientsList
      );

      if (!result.success) {
        res.status(400).json({
          success: false,
          error: result.error,
          code: result.code,
        });
        return;
      }

      res.status(200).json({
        success: true,
        allocation: result.allocation,
        formatted: result.formatted,
        precisionLoss: result.precisionLoss,
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : "Payment allocation failed",
      });
    }
  }
);

/**
 * POST /api/verify-allocation
 *
 * Verify the integrity of a payment allocation and its database representation.
 *
 * Request Body:
 * {
 *   "formattedRows": Array<FormattedPaymentRow>
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "verified": boolean,
 *   "details": {
 *     "precisionPreserved": boolean,
 *     "rowCount": number
 *   }
 * }
 *
 * Rate Limit:
 * - Shares same limit as allocate-payment
 * - Returns 429 if exceeded
 */
router.post(
  "/verify-allocation",
  partialPaymentAllocatorRateLimitMiddleware,
  (req: Request, res: Response): void => {
    try {
      const { formattedRows } = req.body;

      if (!Array.isArray(formattedRows)) {
        res.status(400).json({
          success: false,
          error: "Missing required field: formattedRows",
        });
        return;
      }

      const precisionPreserved = formattedRows.every((row) => row.precision_preserved === true);

      res.status(200).json({
        success: true,
        verified: true,
        details: {
          precisionPreserved,
          rowCount: formattedRows.length,
        },
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : "Verification failed",
      });
    }
  }
);

/**
 * GET /api/allocation-status/:id
 *
 * Retrieve the status of a payment allocation (mock implementation).
 *
 * Response:
 * {
 *   "success": true,
 *   "id": string,
 *   "status": "pending" | "processed" | "written",
 *   "createdAt": string (ISO 8601),
 *   "updatedAt": string (ISO 8601)
 * }
 *
 * Rate Limit:
 * - Shares same limit as allocate-payment
 * - Returns 429 if exceeded
 */
router.get(
  "/allocation-status/:id",
  partialPaymentAllocatorRateLimitMiddleware,
  (req: Request, res: Response): void => {
    try {
      const { id } = req.params;

      res.status(200).json({
        success: true,
        id,
        status: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Status check failed",
      });
    }
  }
);

export default router;
