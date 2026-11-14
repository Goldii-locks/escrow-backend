/* Authorized Protocol Quality Assurance & Formal Invariant Verification */

export interface YieldEstimateInput {
  principalAmount: bigint;
  annualRateBps: bigint; // Basis points (10000 = 100%)
  durationSeconds: bigint;
  secondsPerYear?: bigint;
}

export function calculateEscrowYield(input: YieldEstimateInput): bigint {
  const secondsPerYear = input.secondsPerYear ?? BigInt(31536000); // 365 days
  if (input.durationSeconds <= 0n || input.principalAmount <= 0n || input.annualRateBps <= 0n) {
    return 0n;
  }
  // Formula: (principal * annualRateBps * durationSeconds) / (10000 * secondsPerYear)
  const numerator = input.principalAmount * input.annualRateBps * input.durationSeconds;
  const denominator = 10000n * secondsPerYear;
  return numerator / denominator;
}
