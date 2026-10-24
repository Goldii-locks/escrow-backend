import { BASE_FEE } from "@stellar/stellar-sdk";
import logger from "./logger.js";

/**
 * Inclusion fee for every transaction the backend builds (#681).
 *
 * - `INCLUSION_FEE_STRATEGY=fixed` (default): `INCLUSION_FEE_STROOPS`,
 *   falling back to the SDK's `BASE_FEE` (100 stroops).
 * - `INCLUSION_FEE_STRATEGY=feeStats`: the p90 Soroban inclusion fee from
 *   `getFeeStats()`, cached briefly, never below the fixed fee and never above
 *   `MAX_INCLUSION_FEE_STROOPS`. Any RPC failure falls back to the fixed fee
 *   so building a transaction never fails because fee stats were unavailable.
 *
 * Settings are read on each call so they can be changed without a restart
 * (and per test).
 */

export type InclusionFeeStrategy = "fixed" | "feeStats";

/** The slice of the Soroban RPC server this helper needs. */
export interface FeeStatsSource {
  getFeeStats(): Promise<{ sorobanInclusionFee: { p90: string } }>;
}

const DEFAULT_MAX_INCLUSION_FEE_STROOPS = 100_000;
const DEFAULT_FEE_STATS_CACHE_TTL_S = 15;

function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
  const value = parseInt(raw, 10);
  return value > 0 ? value : undefined;
}

export function resolveInclusionFeeStrategy(): InclusionFeeStrategy {
  return process.env.INCLUSION_FEE_STRATEGY === "feeStats" ? "feeStats" : "fixed";
}

/** `INCLUSION_FEE_STROOPS`, or `BASE_FEE` when unset or invalid. */
export function resolveFixedInclusionFee(): number {
  return readPositiveIntEnv("INCLUSION_FEE_STROOPS") ?? parseInt(BASE_FEE, 10);
}

/** Upper bound applied to fee-stats derived fees. */
export function resolveMaxInclusionFee(): number {
  return readPositiveIntEnv("MAX_INCLUSION_FEE_STROOPS") ?? DEFAULT_MAX_INCLUSION_FEE_STROOPS;
}

function resolveFeeStatsCacheTtlMs(): number {
  return (
    (readPositiveIntEnv("INCLUSION_FEE_CACHE_TTL_S") ?? DEFAULT_FEE_STATS_CACHE_TTL_S) * 1000
  );
}

let cachedFeeStats: { p90: number; expiresAt: number } | null = null;
let inFlightFeeStats: Promise<number> | null = null;

/** Clear the cached fee-stats value (used by tests). */
export function resetInclusionFeeCache(): void {
  cachedFeeStats = null;
  inFlightFeeStats = null;
}

/** p90 inclusion fee from RPC, cached for INCLUSION_FEE_CACHE_TTL_S. */
async function getP90InclusionFee(source: FeeStatsSource): Promise<number> {
  if (cachedFeeStats && Date.now() < cachedFeeStats.expiresAt) {
    return cachedFeeStats.p90;
  }
  if (!inFlightFeeStats) {
    inFlightFeeStats = (async () => {
      const stats = await source.getFeeStats();
      const p90 = Number(stats?.sorobanInclusionFee?.p90);
      if (!Number.isFinite(p90) || p90 < 0) {
        throw new Error(`Invalid sorobanInclusionFee.p90: ${stats?.sorobanInclusionFee?.p90}`);
      }
      cachedFeeStats = { p90, expiresAt: Date.now() + resolveFeeStatsCacheTtlMs() };
      return p90;
    })().finally(() => {
      inFlightFeeStats = null;
    });
  }
  return inFlightFeeStats;
}

/**
 * Inclusion fee (stroops, as the decimal string TransactionBuilder expects)
 * for a transaction built now.
 */
export async function getInclusionFee(source: FeeStatsSource): Promise<string> {
  const fixedFee = resolveFixedInclusionFee();
  if (resolveInclusionFeeStrategy() !== "feeStats") return String(fixedFee);

  try {
    const p90 = await getP90InclusionFee(source);
    const fee = Math.min(Math.max(Math.ceil(p90), fixedFee), resolveMaxInclusionFee());
    return String(fee);
  } catch (err) {
    logger.warn("Fee stats unavailable – using fixed inclusion fee", {
      fixedFee,
      error: err instanceof Error ? err.message : String(err),
    });
    return String(fixedFee);
  }
}
