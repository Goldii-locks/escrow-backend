/**
 * Unified integer-division rounding (issue #670).
 *
 * Single source of truth for all backend preview math that divides integer
 * minor units. Canonical implementation extracted from
 * `tax_deduction_estimator.roundIntegerDivision`, which already supported
 * every mode with exhaustive sign handling.
 *
 * | Call site | File | Mode used | Why |
 * |---|---|---|---|
 * | `divideHalfEven` | `utils/financial_report_math.ts` | `half-even` | report sums must not accumulate directional bias |
 * | `divideRoundHalfEven` | `utils/conversion_rate_math.ts` | `half-even` | fractional rates without float bias |
 * | `roundIntegerDivision` | `utils/tax_deduction_estimator.ts` | caller-chosen | tax preview; default `truncate` matches prior behavior |
 * | `calculateFeeDeductionHalfEven` | `utils/fee_deduction_calculator.ts` | `half-even` | fee/net must reconcile exactly |
 * | `applyStablecoinCentsMultiplier` | `utils/stablecoin_cents_multiplier.ts` | caller-chosen (default `half-even`) | cents scaling |
 *
 * NOTE on-chain policy: the Soroban contract truncates (Rust `/` on `i128`)
 * in fee/yield math. Backend *previews* of on-chain amounts must therefore
 * use `truncate`; half-even is for off-chain aggregates (reports, fees).
 */

export type RoundingMode =
  | "truncate"
  | "floor"
  | "ceil"
  | "half-up"
  | "half-even";

/** Aliases accepted for compatibility with existing call sites. */
export type RoundingModeInput = RoundingMode | "round-to-nearest-even";

export function normalizeRoundingMode(mode: RoundingModeInput): RoundingMode {
  if (mode === "round-to-nearest-even") return "half-even";
  return mode;
}

/**
 * Divide `n` by `d` with the given rounding `mode`.
 *
 * Pure bigint arithmetic — no float intermediate. Sign handling:
 * divisor sign is normalized (both operands negated), quotient truncates
 * toward zero, then the mode adjusts using the sign of the dividend.
 *
 * @throws RangeError when `d === 0n`.
 */
export function divRound(
  n: bigint,
  d: bigint,
  mode: RoundingModeInput = "truncate",
): bigint {
  const m = normalizeRoundingMode(mode);
  if (d === 0n) {
    throw new RangeError("divRound: divisor must not be zero");
  }

  let N = n;
  let D = d;
  if (D < 0n) {
    N = -N;
    D = -D;
  }

  const q = N / D;
  const r = N % D;
  if (r === 0n) return q;

  const sign = N >= 0n ? 1n : -1n;
  const absR = r >= 0n ? r : -r;
  const twiceR = 2n * absR;

  if (m === "truncate") return q;
  if (m === "floor") return N < 0n ? q - 1n : q;
  if (m === "ceil") return N > 0n ? q + 1n : q;
  if (m === "half-up") return twiceR >= D ? q + sign : q;

  // half-even (Banker's rounding): ties go to the even neighbor.
  if (twiceR < D) return q;
  if (twiceR > D) return q + sign;
  return q % 2n === 0n ? q : q + sign;
}
