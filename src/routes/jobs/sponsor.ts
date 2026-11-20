import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { FeeBumpTransaction, Keypair, Transaction } from "@stellar/stellar-sdk";
import {
  submitCors,
  submitSecurityHeaders,
  sendError,
  validate,
  submitBodySchema,
  logger,
  randomUUID,
  NETWORK_PASSPHRASE,
  maskAddress,
} from "./shared.js";
import { BUILD_TX_ALLOWED_METHODS } from "../../schemas/jobs.js";
import { config } from "../../config.js";
import { rejectedRequestLogMeta, xdrLogMeta } from "../../utils/log-redaction.js";
import { submitAndRespond } from "./submit.js";

// ---------------------------------------------------------------------------
// POST /api/jobs/sponsor – opt-in fee sponsorship (#966)
// ---------------------------------------------------------------------------
// Takes a user-signed transaction, checks it is a single escrow call the
// frontend could have built through /build-tx, wraps it in a fee-bump paid
// and signed by SPONSOR_SECRET_KEY, and submits it through the /submit path.
// The user still signs (and is the source of) the inner transaction; only the
// fee moves to the sponsor account. Disabled unless SPONSOR_SECRET_KEY is set.
//
// The secret is read from the environment on every request and never logged.

/** Whether fee sponsorship is enabled (SPONSOR_SECRET_KEY set). */
export function isSponsorshipEnabled(): boolean {
  return Boolean(process.env.SPONSOR_SECRET_KEY);
}

// ---------------------------------------------------------------------------
// Rate limits: per IP (middleware) and per source account (in the handler,
// once the transaction is decoded). Fixed windows of SPONSOR_RATE_WINDOW_MS.
// ---------------------------------------------------------------------------

type Bucket = { count: number; resetAt: number };

function makeKeyedWindow() {
  const buckets = new Map<string, Bucket>();
  return {
    buckets,
    /** Count one hit for `key`; returns the bucket after counting. */
    hit(key: string, windowMs: number, now = Date.now()): Bucket {
      let bucket = buckets.get(key);
      if (!bucket || now >= bucket.resetAt) {
        // Drop expired buckets so the map does not grow without bound.
        for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      return bucket;
    },
  };
}

const ipWindow = makeKeyedWindow();
const accountWindow = makeKeyedWindow();

function sendRateLimited(res: Response, max: number, bucket: Bucket): void {
  res.setHeader("X-RateLimit-Limit", String(max));
  res.setHeader("X-RateLimit-Remaining", "0");
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
  res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000))));
  sendError(res, 429, "Too many requests, please try again later");
}

/** Per-IP limit: SPONSOR_RATE_MAX requests per SPONSOR_RATE_WINDOW_MS. */
export function sponsorIpRateLimit(req: Request, res: Response, next: NextFunction): void {
  const max = config.sponsorIpRateMax;
  const key = req.ip || req.socket?.remoteAddress || "unknown";
  const bucket = ipWindow.hit(key, config.sponsorRateWindowMs);
  if (bucket.count > max) {
    sendRateLimited(res, max, bucket);
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Daily budget per source account, in stroops of fee-bump fee (UTC days).
// A sponsorship reserves its full fee-bump fee up front and gives it back if
// the network never accepts the transaction. Kept in memory: a restart
// resets the day's spend, which errs towards the user, never towards
// sponsoring calls the allowlist would reject.
// ---------------------------------------------------------------------------

const dailySpend = new Map<string, { day: string; spent: bigint }>();

function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Reserve `fee` stroops of `account`'s daily budget; false when it would exceed it. */
export function reserveSponsorBudget(account: string, fee: bigint, now = Date.now()): boolean {
  const day = utcDay(now);
  const budget = BigInt(config.sponsorDailyBudgetStroops);
  let entry = dailySpend.get(account);
  if (!entry || entry.day !== day) {
    entry = { day, spent: 0n };
    dailySpend.set(account, entry);
  }
  if (entry.spent + fee > budget) return false;
  entry.spent += fee;
  return true;
}

/** Give back a reservation for a sponsorship that never reached the network. */
export function releaseSponsorBudget(account: string, fee: bigint, now = Date.now()): void {
  const entry = dailySpend.get(account);
  if (!entry || entry.day !== utcDay(now)) return;
  entry.spent = entry.spent > fee ? entry.spent - fee : 0n;
}

/** Stroops `account` has used of today's budget. */
export function getSponsorBudgetSpent(account: string, now = Date.now()): bigint {
  const entry = dailySpend.get(account);
  return entry && entry.day === utcDay(now) ? entry.spent : 0n;
}

/** Test helper: clear rate-limit windows and daily budgets. */
export function resetSponsorState(): void {
  ipWindow.buckets.clear();
  accountWindow.buckets.clear();
  dailySpend.clear();
}

// ---------------------------------------------------------------------------
// Inner transaction checks
// ---------------------------------------------------------------------------

class SponsorRejection extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Contracts the sponsor pays for: the configured escrow and factory, and every
 * contract the indexer actively monitors (factory-created escrows included).
 */
async function isSponsorableContract(contractId: string): Promise<boolean> {
  if (contractId === process.env.CONTRACT_ID) return true;
  if (contractId === process.env.FACTORY_CONTRACT_ID) return true;
  try {
    const { getActiveContractIds } = await import("../../indexer/db.js");
    return getActiveContractIds().includes(contractId);
  } catch (err) {
    logger.warn("Could not read monitored contracts for sponsorship", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

interface SponsorableCall {
  source: string;
  contractId: string;
  method: string;
}

/**
 * Accept only a signed, single-operation `invokeHostFunction` that calls a
 * build-tx allowlisted method on a sponsorable contract. Throws a
 * SponsorRejection otherwise.
 */
async function checkInnerTransaction(
  tx: Transaction | FeeBumpTransaction,
): Promise<SponsorableCall> {
  const { Address } = await import("@stellar/stellar-sdk");

  if ("innerTransaction" in tx) {
    throw new SponsorRejection(400, "Transaction is already a fee-bump transaction");
  }
  if (tx.signatures.length === 0) {
    throw new SponsorRejection(400, "Transaction must be signed by its source account");
  }
  if (tx.operations.length !== 1) {
    throw new SponsorRejection(400, "Only single-operation transactions can be sponsored");
  }
  const op = tx.operations[0];
  if (op.type !== "invokeHostFunction") {
    throw new SponsorRejection(400, "Only contract invocations can be sponsored");
  }
  // The budget and rate limits are keyed on the transaction source, so the
  // operation must act as that same account.
  if (op.source && op.source !== tx.source) {
    throw new SponsorRejection(400, "Operation source must be the transaction source");
  }
  if (op.func.switch().name !== "hostFunctionTypeInvokeContract") {
    throw new SponsorRejection(400, "Only contract invocations can be sponsored");
  }

  const invocation = op.func.invokeContract();
  const contractId = Address.fromScAddress(invocation.contractAddress()).toString();
  const method = invocation.functionName().toString();

  if (!(BUILD_TX_ALLOWED_METHODS as readonly string[]).includes(method)) {
    throw new SponsorRejection(403, `Method ${method} is not eligible for fee sponsorship`);
  }
  if (!(await isSponsorableContract(contractId))) {
    throw new SponsorRejection(403, "Contract is not eligible for fee sponsorship");
  }

  return { source: tx.source, contractId, method };
}

/** Soroban resource fee declared by the inner transaction (0 when absent). */
function innerResourceFee(tx: Transaction): bigint {
  const ext = tx.toEnvelope().v1().tx().ext();
  return ext.switch() === 1 ? BigInt(ext.sorobanData().resourceFee().toString()) : 0n;
}

/**
 * Wrap `inner` in a fee-bump paid by `sponsor`. The fee-bump base fee matches
 * the inner inclusion fee (at least BASE_FEE), so the outer fee is
 * baseFee * 2 + resourceFee — the least the network accepts.
 */
async function buildSponsoredTransaction(
  inner: Transaction,
  sponsor: Keypair,
): Promise<FeeBumpTransaction> {
  const { TransactionBuilder, BASE_FEE } = await import("@stellar/stellar-sdk");
  const resourceFee = innerResourceFee(inner);
  const inclusionFee = BigInt(inner.fee) - resourceFee;
  const baseFee = inclusionFee > BigInt(BASE_FEE) ? inclusionFee : BigInt(BASE_FEE);
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    sponsor,
    baseFee.toString(),
    inner,
    NETWORK_PASSPHRASE,
  );
  feeBump.sign(sponsor);
  return feeBump;
}

const router = Router();

/** Answer 404 when sponsorship is off, before any parsing or rate limiting. */
function requireSponsorshipEnabled(_req: Request, res: Response, next: NextFunction): void {
  if (!isSponsorshipEnabled()) {
    sendError(res, 404, "Fee sponsorship is not enabled");
    return;
  }
  next();
}

router.options("/sponsor", submitCors);

router.post(
  "/sponsor",
  submitCors,
  submitSecurityHeaders,
  requireSponsorshipEnabled,
  sponsorIpRateLimit,
  // Same body as /submit; the signed XDR is never logged (#680).
  validate(submitBodySchema, "body", (req, error) =>
    logger.warn("Invalid sponsor request body", {
      ...rejectedRequestLogMeta(req, error),
      ...xdrLogMeta(req.body?.signedXdr),
    }),
  ),
  async (req: Request, res: Response) => {
    const { signedXdr } = req.body as { signedXdr: string };
    const traceId = req.id ?? randomUUID();

    logger.info("Sponsor transaction request received", { traceId, ...xdrLogMeta(signedXdr) });

    const sdk = await import("@stellar/stellar-sdk");

    let sponsor: Keypair;
    try {
      sponsor = sdk.Keypair.fromSecret(process.env.SPONSOR_SECRET_KEY as string);
    } catch {
      logger.error("SPONSOR_SECRET_KEY is not a valid Stellar secret key", { traceId });
      sendError(res, 500, "Fee sponsorship is misconfigured");
      return;
    }

    let inner: Transaction;
    let call: SponsorableCall;
    try {
      let parsed: Transaction | FeeBumpTransaction;
      try {
        parsed = sdk.TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
      } catch {
        throw new SponsorRejection(400, "signedXdr is not a valid transaction envelope");
      }
      call = await checkInnerTransaction(parsed);
      inner = parsed as Transaction;
    } catch (err) {
      if (err instanceof SponsorRejection) {
        logger.warn("Sponsorship rejected", { traceId, reason: err.message });
        sendError(res, err.status, err.message);
        return;
      }
      throw err;
    }

    const accountMax = config.sponsorAccountRateMax;
    const accountBucket = accountWindow.hit(call.source, config.sponsorRateWindowMs);
    if (accountBucket.count > accountMax) {
      logger.warn("Sponsorship rate limited for source account", {
        traceId,
        source: maskAddress(call.source),
      });
      sendRateLimited(res, accountMax, accountBucket);
      return;
    }

    let feeBump: FeeBumpTransaction;
    try {
      feeBump = await buildSponsoredTransaction(inner, sponsor);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("Could not build fee-bump transaction", { traceId, error: message });
      sendError(res, 400, "Transaction cannot be fee-bumped");
      return;
    }

    const fee = BigInt(feeBump.fee);
    const maxFee = BigInt(config.sponsorMaxFeeStroops);
    if (fee > maxFee) {
      logger.warn("Sponsorship fee above SPONSOR_MAX_FEE", {
        traceId,
        fee: fee.toString(),
        maxFee: maxFee.toString(),
      });
      sendError(res, 422, `Sponsored fee ${fee} exceeds the maximum of ${maxFee} stroops`);
      return;
    }

    if (!reserveSponsorBudget(call.source, fee)) {
      logger.warn("Daily sponsorship budget exhausted", {
        traceId,
        source: maskAddress(call.source),
      });
      sendError(res, 429, "Daily fee sponsorship budget exhausted for this account");
      return;
    }

    logger.info("Submitting sponsored transaction", {
      traceId,
      contractId: call.contractId,
      method: call.method,
      source: maskAddress(call.source),
      fee: fee.toString(),
    });

    const outcome = await submitAndRespond(res, {
      // Distinct from /submit's key: the same inner XDR sent to /submit is
      // a different (unsponsored) transaction.
      cacheKey: `sponsor:${signedXdr}`,
      traceId,
      buildTx: async () => feeBump,
    });
    // Only a new submission the network accepted spends the budget.
    if (outcome !== "submitted") releaseSponsorBudget(call.source, fee);
  },
);

export default router;
