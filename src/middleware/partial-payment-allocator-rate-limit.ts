/**
 * Partial Payment Allocator Rate Limiting Middleware
 *
 * This module provides rate limiting for partial payment allocator endpoints.
 * It uses a path-based rate limiting strategy to protect against abuse.
 *
 * Environment Variables:
 * - PARTIAL_PAYMENT_ALLOCATOR_RATE_MAX: Maximum requests per window (default: 50)
 * - PARTIAL_PAYMENT_ALLOCATOR_RATE_WINDOW_MS: Time window in milliseconds (default: 60000)
 *
 * Returns:
 * - 429 Too Many Requests when limit is exceeded
 * - X-RateLimit-* headers with current limit info
 */

import type { Request, Response, NextFunction } from "express";
import {
  partialPaymentAllocatorRateLimit,
  resetPartialPaymentAllocatorRateLimitBuckets,
} from "./job-contract-rate-limit.js";

/**
 * Middleware to rate limit partial payment allocator requests.
 * Tracks requests by client IP and enforces configured limits.
 *
 * @param req Express request
 * @param res Express response
 * @param next Express next function
 *
 * @returns void
 *
 * @example
 * ```typescript
 * import { partialPaymentAllocatorRateLimitMiddleware } from './middleware/partial-payment-allocator-rate-limit.js';
 * 
 * router.post(
 *   '/api/payments/allocate',
 *   partialPaymentAllocatorRateLimitMiddleware,
 *   allocatePaymentHandler
 * );
 * ```
 */
export function partialPaymentAllocatorRateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  partialPaymentAllocatorRateLimit(req, res, next);
}

/**
 * Reset all rate limit buckets for testing purposes.
 * Clears all tracked client buckets.
 */
export function resetPartialPaymentAllocatorRateLimits(): void {
  resetPartialPaymentAllocatorRateLimitBuckets();
}

export default partialPaymentAllocatorRateLimitMiddleware;
