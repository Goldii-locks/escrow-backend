/**
 * Whether a Soroban RPC client may talk plain HTTP to `url`.
 *
 * The Stellar SDK refuses `http://` RPC URLs unless `allowHttp` is set. A
 * local quickstart network (the E2E suite, local development) only serves
 * HTTP, so allow it there, but never in production, where an `http://` URL
 * is a misconfiguration and should fail loudly.
 */
export function rpcAllowHttp(url: string): boolean {
  return url.startsWith("http://") && process.env.NODE_ENV !== "production";
}
