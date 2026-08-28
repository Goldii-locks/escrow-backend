import type { NextFunction, Request, Response } from "express";

type RateBucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, RateBucket>();

export function resetJobContractRateLimitBuckets(): void {
  buckets.clear();
}

function resolveWindowMs(): number {
  const configured = Number(process.env.JOB_CONTRACT_RATE_WINDOW_MS ?? "60000");
  return Number.isFinite(configured) && configured > 0 ? configured : 60000;
}

function resolveMaxRequests(): number {
  const configured = Number(process.env.JOB_CONTRACT_RATE_MAX ?? "30");
  return Number.isFinite(configured) && configured > 0 ? configured : 30;
}

/** Dedicated rate limiter for GET /api/jobs/:contractId. */
export function jobContractRateLimit(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const windowMs = resolveWindowMs();
  const maxRequests = resolveMaxRequests();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();

  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }

  bucket.count += 1;

  const remaining = Math.max(0, maxRequests - bucket.count);
  res.setHeader("X-RateLimit-Limit", String(maxRequests));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count > maxRequests) {
    res.status(429).json({
      success: false,
      error: "Too many requests, please try again later",
    });
    return;
  }

  next();
}

const partialReleaseBuckets = new Map<string, RateBucket>();

export function resetPartialReleaseRateLimitBuckets(): void {
  partialReleaseBuckets.clear();
}

function resolvePartialReleaseWindowMs(): number {
  const configured = Number(process.env.PARTIAL_RELEASE_RATE_WINDOW_MS ?? "60000");
  return Number.isFinite(configured) && configured > 0 ? configured : 60000;
}

function resolvePartialReleaseMaxRequests(): number {
  const configured = Number(process.env.PARTIAL_RELEASE_RATE_MAX ?? "10");
  return Number.isFinite(configured) && configured > 0 ? configured : 10;
}

/** Dedicated rate limiter for POST /api/jobs/:contractId/milestones/:index/partial-release. */
export function partialReleaseRateLimit(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const windowMs = resolvePartialReleaseWindowMs();
  const maxRequests = resolvePartialReleaseMaxRequests();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();

  let bucket = partialReleaseBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    partialReleaseBuckets.set(key, bucket);
  }

  bucket.count += 1;

  const remaining = Math.max(0, maxRequests - bucket.count);
  res.setHeader("X-RateLimit-Limit", String(maxRequests));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count > maxRequests) {
    res.status(429).json({
      success: false,
      error: "Too many requests, please try again later",
    });
    return;
  }

  next();
}

const whitelistBuckets = new Map<string, RateBucket>();

export function resetJobWhitelistRateLimitBuckets(): void {
  whitelistBuckets.clear();
}

// ---------------------------------------------------------------------------
// createJobDraft rate limiter
// ---------------------------------------------------------------------------

const createJobDraftBuckets = new Map<string, RateBucket>();

export function resetCreateJobDraftRateLimitBuckets(): void {
  createJobDraftBuckets.clear();
}

function resolveCreateJobDraftWindowMs(): number {
  const configured = Number(process.env.CREATE_JOB_DRAFT_RATE_WINDOW_MS ?? "60000");
  return Number.isFinite(configured) && configured > 0 ? configured : 60000;
}

function resolveCreateJobDraftMaxRequests(): number {
  const configured = Number(process.env.CREATE_JOB_DRAFT_RATE_MAX ?? "5");
  return Number.isFinite(configured) && configured > 0 ? configured : 5;
}

function resolveWhitelistWindowMs(): number {
  const configured = Number(process.env.JOB_WHITELIST_RATE_WINDOW_MS ?? "60000");
  return Number.isFinite(configured) && configured > 0 ? configured : 60000;
}

function resolveWhitelistMaxRequests(): number {
  const configured = Number(process.env.JOB_WHITELIST_RATE_MAX ?? "20");
  return Number.isFinite(configured) && configured > 0 ? configured : 20;
}

/** Dedicated rate limiter for GET /api/jobs/:contractId/whitelist. */
export function jobWhitelistRateLimit(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const windowMs = resolveWhitelistWindowMs();
  const maxRequests = resolveWhitelistMaxRequests();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();

  let bucket = whitelistBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    whitelistBuckets.set(key, bucket);
  }

  bucket.count += 1;

  const remaining = Math.max(0, maxRequests - bucket.count);
  res.setHeader("X-RateLimit-Limit", String(maxRequests));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count > maxRequests) {
    res.status(429).json({
      success: false,
      error: "Too many requests, please try again later",
    });
    return;
  }

  next();
}

const timeRemainingBuckets = new Map<string, RateBucket>();

export function resetTimeRemainingRateLimitBuckets(): void {
  timeRemainingBuckets.clear();
}

function resolveTimeRemainingWindowMs(): number {
  const configured = Number(process.env.TIME_REMAINING_RATE_WINDOW_MS ?? "60000");
  return Number.isFinite(configured) && configured > 0 ? configured : 60000;
}

function resolveTimeRemainingMaxRequests(): number {
  const configured = Number(process.env.TIME_REMAINING_RATE_MAX ?? "60");
  return Number.isFinite(configured) && configured > 0 ? configured : 60;
}

/** Dedicated rate limiter for GET /api/jobs/:contractId/milestones/:index/time-remaining. */
export function timeRemainingRateLimit(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const windowMs = resolveTimeRemainingWindowMs();
  const maxRequests = resolveTimeRemainingMaxRequests();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();

  let bucket = timeRemainingBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    timeRemainingBuckets.set(key, bucket);
  }

  bucket.count += 1;

  const remaining = Math.max(0, maxRequests - bucket.count);
  res.setHeader("X-RateLimit-Limit", String(maxRequests));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count > maxRequests) {
    res.status(429).json({
      success: false,
      error: "Too many requests, please try again later",
    });
    return;
  }

  next();
}


const buildTxBuckets = new Map<string, RateBucket>();

export function resetBuildTxRateLimitBuckets(): void {
  buildTxBuckets.clear();
}

function resolveBuildTxWindowMs(): number {
  const configured = Number(process.env.BUILD_TX_RATE_WINDOW_MS ?? "60000");
  return Number.isFinite(configured) && configured > 0 ? configured : 60000;
}

function resolveBuildTxMaxRequests(): number {
  const configured = Number(process.env.BUILD_TX_RATE_MAX ?? "20");
  return Number.isFinite(configured) && configured > 0 ? configured : 20;
}

/** Dedicated rate limiter for POST /api/jobs/build-tx. */
export function buildTxRateLimit(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const windowMs = resolveBuildTxWindowMs();
  const maxRequests = resolveBuildTxMaxRequests();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();

  let bucket = buildTxBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    buildTxBuckets.set(key, bucket);
  }

  bucket.count += 1;

  const remaining = Math.max(0, maxRequests - bucket.count);
  res.setHeader("X-RateLimit-Limit", String(maxRequests));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count > maxRequests) {
    res.status(429).json({
      success: false,
      error: "Too many requests, please try again later",
    });
    return;
  }

  next();
}

/** Dedicated rate limiter for POST /api/jobs/create-job-draft. */
export function createJobDraftRateLimit(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const windowMs = resolveCreateJobDraftWindowMs();
  const maxRequests = resolveCreateJobDraftMaxRequests();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();

  let bucket = createJobDraftBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    createJobDraftBuckets.set(key, bucket);
  }

  bucket.count += 1;

  const remaining = Math.max(0, maxRequests - bucket.count);
  res.setHeader("X-RateLimit-Limit", String(maxRequests));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count > maxRequests) {
    res.status(429).json({
      success: false,
      error: "Too many requests, please try again later",
    });
    return;
  }

  next();
}

const claimAutoReleaseBuckets = new Map<string, RateBucket>();

export function resetClaimAutoReleaseRateLimitBuckets(): void {
  claimAutoReleaseBuckets.clear();
}

function resolveClaimAutoReleaseWindowMs(): number {
  const configured = Number(process.env.CLAIM_AUTO_RELEASE_RATE_WINDOW_MS ?? "60000");
  return Number.isFinite(configured) && configured > 0 ? configured : 60000;
}

function resolveClaimAutoReleaseMaxRequests(): number {
  const configured = Number(process.env.CLAIM_AUTO_RELEASE_RATE_MAX ?? "10");
  return Number.isFinite(configured) && configured > 0 ? configured : 10;
}

/** Dedicated rate limiter for POST /api/jobs/:contractId/milestones/:index/claim-auto-release. */
export function claimAutoReleaseRateLimit(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const windowMs = resolveClaimAutoReleaseWindowMs();
  const maxRequests = resolveClaimAutoReleaseMaxRequests();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();

  let bucket = claimAutoReleaseBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    claimAutoReleaseBuckets.set(key, bucket);
  }

  bucket.count += 1;

  const remaining = Math.max(0, maxRequests - bucket.count);
  res.setHeader("X-RateLimit-Limit", String(maxRequests));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count > maxRequests) {
    res.status(429).json({
      success: false,
      error: "Too many requests, please try again later",
    });
    return;
  }

  next();
}

// ---------------------------------------------------------------------------
// Submit rate limiter – dedicated buckets for POST /api/jobs/submit
// ---------------------------------------------------------------------------

const submitBuckets = new Map<string, RateBucket>();

export function resetSubmitRateLimitBuckets(): void {
  submitBuckets.clear();
}

function resolveSubmitWindowMs(): number {
  const configured = Number(process.env.SUBMIT_RATE_WINDOW_MS ?? "60000");
  return Number.isFinite(configured) && configured > 0 ? configured : 60000;
}

function resolveSubmitMaxRequests(): number {
  const configured = Number(process.env.SUBMIT_RATE_MAX ?? "5");
  return Number.isFinite(configured) && configured > 0 ? configured : 5;
}

/** Dedicated rate limiter for POST /api/jobs/submit. */
export function submitRateLimit(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const windowMs = resolveSubmitWindowMs();
  const maxRequests = resolveSubmitMaxRequests();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();

  let bucket = submitBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    submitBuckets.set(key, bucket);
  }

  bucket.count += 1;

  const remaining = Math.max(0, maxRequests - bucket.count);
  res.setHeader("X-RateLimit-Limit", String(maxRequests));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count > maxRequests) {
    res.status(429).json({
      success: false,
      error: "Too many requests, please try again later",
    });
    return;
  }

  next();
}
