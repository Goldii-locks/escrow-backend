let indexerStartedAt: number | null = null;

export function markIndexerStarted() {
  if (!indexerStartedAt) {
    indexerStartedAt = Date.now();
  }
}

export function getIndexerUptimeSeconds(): number {
  if (!indexerStartedAt) return 0;
  return Math.floor((Date.now() - indexerStartedAt) / 1000);
}
