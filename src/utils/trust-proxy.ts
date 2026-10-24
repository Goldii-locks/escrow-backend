/**
 * Resolve Express's "trust proxy" setting (#600).
 *
 * Production traffic arrives through one nginx hop, so without this every
 * request's req.ip is the nginx container address and all clients share one
 * rate-limit bucket. A hop count is used rather than `true`, which would let
 * clients spoof X-Forwarded-For.
 *
 * TRUST_PROXY_HOPS overrides the default: a non-negative integer, where 0
 * disables trust. Default is 1 in production and false otherwise.
 */
export function resolveTrustProxy(env: NodeJS.ProcessEnv = process.env): number | false {
  const raw = env.TRUST_PROXY_HOPS?.trim();
  if (raw) {
    const hops = Number(raw);
    if (!Number.isInteger(hops) || hops < 0) {
      throw new Error(`TRUST_PROXY_HOPS must be a non-negative integer, got "${raw}"`);
    }
    return hops > 0 ? hops : false;
  }
  return env.NODE_ENV === "production" ? 1 : false;
}
