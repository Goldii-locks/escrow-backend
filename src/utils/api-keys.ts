import { createHash, timingSafeEqual } from "crypto";
import type { Request } from "express";

export function configuredApiKeys(
  pluralEnvName: string,
  singularEnvName: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configured = env[pluralEnvName] ?? env[singularEnvName];
  return configured
    ?.split(",")
    .map((key) => key.trim())
    .filter(Boolean) ?? [];
}

export function matchingApiKeyIndex(
  providedKey: string | undefined,
  expectedKeys: string[],
): number | undefined {
  if (providedKey === undefined) return undefined;

  const providedDigest = createHash("sha256").update(providedKey).digest();
  let matchedIndex: number | undefined;

  expectedKeys.forEach((expectedKey, index) => {
    const expectedDigest = createHash("sha256").update(expectedKey).digest();
    if (timingSafeEqual(providedDigest, expectedDigest) && matchedIndex === undefined) {
      matchedIndex = index;
    }
  });

  return matchedIndex;
}

/** The token from an `Authorization: Bearer <token>` header, if present. */
export function getBearerToken(req: Request): string | undefined {
  const auth = req.header("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length);
  }
  return undefined;
}

/**
 * Public (API_KEYS) credential: `x-api-key`, falling back to a Bearer token.
 * Shared by requireApiKey so the two middlewares no longer carry identical
 * copies of the header parsing (#970).
 */
export function getProvidedApiKey(req: Request): string | undefined {
  const headerKey = req.header("x-api-key");
  if (headerKey) return headerKey;
  return getBearerToken(req);
}

export type AdminKeySource = "x-admin-key" | "bearer" | "x-api-key";

/**
 * Admin (ADMIN_API_KEYS) credential (#970). Admin keys belong in the
 * dedicated `x-admin-key` header or `Authorization: Bearer`. `x-api-key` is
 * still accepted during the deprecation period, reported as its own source so
 * the caller can log a warning.
 */
export function getProvidedAdminKey(
  req: Request,
): { key: string; source: AdminKeySource } | undefined {
  const adminHeader = req.header("x-admin-key");
  if (adminHeader) return { key: adminHeader, source: "x-admin-key" };

  const bearer = getBearerToken(req);
  if (bearer) return { key: bearer, source: "bearer" };

  const legacyHeader = req.header("x-api-key");
  if (legacyHeader) return { key: legacyHeader, source: "x-api-key" };

  return undefined;
}

/**
 * Throw when any value is configured as both a public and an admin key
 * (#970). Such a key would unlock admin routes for every client holding the
 * public key. Accepts an explicit env mapping so it can be unit tested.
 */
export function assertDisjointApiKeyLists(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const publicKeys = new Set(configuredApiKeys("API_KEYS", "API_KEY", env));
  const overlapping = configuredApiKeys("ADMIN_API_KEYS", "ADMIN_API_KEY", env)
    .filter((key) => publicKeys.has(key));
  if (overlapping.length > 0) {
    throw new Error(
      `${overlapping.length} key(s) appear in both API_KEYS and ADMIN_API_KEYS; ` +
        "admin keys must be distinct from public API keys",
    );
  }
}
