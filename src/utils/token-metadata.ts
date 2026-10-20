/**
 * Centralized token metadata registry (#699).
 *
 * Asset metadata used to be hard-coded in five separate registries, each with
 * its own (and mutually disagreeing) decimals and labels:
 *
 *   - `src/utils/stablecoin_cents_multiplier.ts`  – `STABLECOIN_CONFIGS`
 *   - `src/utils/refund_ratio_helper.ts`           – `KNOWN_REFUND_ASSETS`
 *   - `src/utils/financial_report_exporter.ts`     – `KNOWN_REPORT_ASSETS`
 *   - `src/utils/conversion_rate_math.ts`          – `KNOWN_ASSETS`
 *   - `src/utils/audit_ledger_sum_checker.ts`      – `KNOWN_ASSETS`
 *
 * Escrow jobs are keyed by *token contract address* (`InitializedEvent.token`),
 * and the whitelist holds contract addresses, so none of those ticker-keyed
 * tables could ever be applied to real job data. A whitelisted token whose
 * `decimals()` differs from the assumed value was formatted wrongly.
 *
 * This module resolves the metadata straight from the token contract by
 * simulating the SEP-41 view calls `decimals()`, `symbol()` and `name()`, and
 * caches the result for a long time (token metadata is immutable for the life
 * of a contract). Only a small static map of *display labels* is kept locally
 * — the single static asset table in `src/`.
 */

import {
  Account,
  Contract,
  Keypair,
  TransactionBuilder,
  scValToNative,
} from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";
import NodeCache from "node-cache";
import logger from "./logger.js";

/** Metadata resolved for a token contract. */
export interface TokenMetadata {
  /** Token contract address (the key the metadata was resolved for). */
  address: string;
  /** SEP-41 `symbol()` value (empty when the contract does not implement it). */
  symbol: string;
  /** SEP-41 `decimals()` value (the on-chain precision of the asset). */
  decimals: number;
  /** SEP-41 `name()` value (falls back to the display label). */
  name: string;
}

/**
 * Precision assumed when a token contract does not implement `decimals()`.
 * Seven is the Stellar-native precision used by XLM and by the classic
 * Stellar asset tokens.
 */
export const DEFAULT_TOKEN_DECIMALS = 7;

/**
 * Upper bound for `decimals()`. SEP-41 allows any u32, but real tokens stay
 * within 0-18; the bound keeps the scale (and the 10^decimals multiplier)
 * within a sane range.
 */
export const MAX_TOKEN_DECIMALS = 18;

/** Label used when neither the contract nor the override table names the asset. */
export const DEFAULT_TOKEN_LABEL = "Unknown Stellar Token";

/**
 * The one static asset table left in `src/`: display labels for well-known
 * tickers. It carries **no** precision — decimals always come from the token
 * contract.
 */
export const TOKEN_LABEL_OVERRIDES: Readonly<Record<string, string>> =
  Object.freeze({
    XLM: "Stellar Lumens",
    USDC: "USD Coin (Stellar)",
    EURC: "Euro Coin (Stellar)",
    USDT: "Tether (Stellar)",
    BTC: "Bitcoin (Stellar)",
    ETH: "Ether (Stellar)",
  });

/** Stellar asset codes are 1-12 alphanumeric characters. */
const STELLAR_ASSET_CODE = /^[A-Za-z0-9]{1,12}$/;

/**
 * Display label for a ticker symbol. Falls back to `DEFAULT_TOKEN_LABEL` for
 * symbols that are not in the override table.
 */
export function getTokenLabel(symbol?: string | null): string {
  const key = normalizeTokenSymbol(symbol);
  if (!key) return DEFAULT_TOKEN_LABEL;
  return TOKEN_LABEL_OVERRIDES[key] ?? DEFAULT_TOKEN_LABEL;
}

/**
 * Whether a ticker symbol has a static display-label override.
 */
export function isKnownTokenSymbol(symbol?: string | null): boolean {
  const key = normalizeTokenSymbol(symbol);
  if (!key) return false;
  return Object.prototype.hasOwnProperty.call(TOKEN_LABEL_OVERRIDES, key);
}

/**
 * Normalize a ticker symbol: trimmed and upper-cased. Returns an empty string
 * when the value is not a well-formed Stellar asset code.
 */
export function normalizeTokenSymbol(symbol?: string | null): string {
  if (typeof symbol !== "string") return "";
  const trimmed = symbol.trim();
  if (!STELLAR_ASSET_CODE.test(trimmed)) return "";
  return trimmed.toUpperCase();
}

// ---------------------------------------------------------------------------
// SEP-41 simulation
// ---------------------------------------------------------------------------

const RPC_URL =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.SOROBAN_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
const BASE_FEE = "100";

/** The SEP-41 view calls resolved for every token. */
export type TokenMetadataViewMethod = "decimals" | "symbol" | "name";

/**
 * Simulates a single read-only contract call and returns the decoded value.
 * Injectable so tests can exercise the resolver with a mocked simulation.
 */
export type TokenViewSimulator = (
  tokenAddress: string,
  method: TokenMetadataViewMethod,
) => Promise<unknown>;

/**
 * Default simulator: builds a read-only transaction against the token
 * contract and asks the Soroban RPC to simulate it. A simulation does not
 * need a funded source account, so a random keypair is used as the source.
 */
const simulateTokenView: TokenViewSimulator = async (tokenAddress, method) => {
  const server = new Server(RPC_URL);
  const source = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(tokenAddress).call(method))
    .setTimeout(30)
    .build();

  const simulation = (await server.simulateTransaction(tx)) as unknown as {
    error?: string;
    result?: { retval?: unknown };
  };

  if (simulation.error || !simulation.result?.retval) {
    throw new Error(
      `${method}() simulation failed for ${tokenAddress}: ${
        simulation.error ?? "no result"
      }`,
    );
  }

  return scValToNative(simulation.result.retval as never);
};

/** Test hook: replaces the RPC simulator for the whole process. */
let simulatorOverride: TokenViewSimulator | null = null;

/**
 * Install a mocked simulator (tests) or restore the real one by passing
 * `null`.
 */
export function setTokenMetadataSimulatorForTests(
  simulator: TokenViewSimulator | null,
): void {
  simulatorOverride = simulator;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Token metadata is immutable, so it is cached for a long time. The TTL can
 * be tuned with `TOKEN_METADATA_CACHE_TTL_SECONDS`.
 */
const CACHE_TTL_SECONDS = Math.max(
  60,
  parseInt(process.env.TOKEN_METADATA_CACHE_TTL_SECONDS || "86400", 10) || 86400,
);

/** Failed resolutions are cached briefly so a broken token cannot hammer the RPC. */
const FAILURE_CACHE_TTL_SECONDS = 60;

const metadataCache = new NodeCache({
  stdTTL: CACHE_TTL_SECONDS,
  checkperiod: 600,
  useClones: false,
});

const failureCache = new NodeCache({
  stdTTL: FAILURE_CACHE_TTL_SECONDS,
  checkperiod: 60,
  useClones: false,
});

/** Drop every cached token metadata entry (tests / manual refresh). */
export function clearTokenMetadataCache(): void {
  metadataCache.flushAll();
  failureCache.flushAll();
}

/** Cached metadata for a token address, or `null` when it was never resolved. */
export function getCachedTokenMetadata(
  tokenAddress: string,
): TokenMetadata | null {
  const address = normalizeTokenAddress(tokenAddress);
  if (!address) return null;
  return (metadataCache.get(address) as TokenMetadata | undefined) ?? null;
}

/**
 * Cached decimals for a token address, or `null` when the token was never
 * resolved. Never performs an RPC call.
 */
export function getCachedTokenDecimals(tokenAddress: string): number | null {
  return getCachedTokenMetadata(tokenAddress)?.decimals ?? null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Options accepted by the token metadata resolver. */
export interface TokenMetadataOptions {
  /** Override the Soroban RPC endpoint (defaults to `SOROBAN_RPC_URL`). */
  rpcUrl?: string;
  /** Override the network passphrase (defaults to `SOROBAN_NETWORK_PASSPHRASE`). */
  networkPassphrase?: string;
  /** Override the simulation timeout in seconds (defaults to 30). */
  timeoutSeconds?: number;
  /** Injectable simulator (tests mock the Soroban RPC simulation). */
  simulate?: TokenViewSimulator;
}

/** Thrown when the token metadata cannot be resolved from the contract. */
export class TokenMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenMetadataError";
  }
}

function normalizeTokenAddress(tokenAddress: unknown): string {
  if (typeof tokenAddress !== "string") return "";
  return tokenAddress.trim();
}

function normalizeDecimals(value: unknown): number {
  const numeric =
    typeof value === "bigint" ? Number(value) : (value as unknown as number);
  if (
    typeof numeric !== "number" ||
    !Number.isFinite(numeric) ||
    !Number.isInteger(numeric) ||
    numeric < 0 ||
    numeric > MAX_TOKEN_DECIMALS
  ) {
    throw new TokenMetadataError(
      `token decimals() returned an invalid value: ${String(value)}`,
    );
  }
  return numeric;
}

function normalizeText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "bigint" || typeof value === "number") {
    return String(value);
  }
  return "";
}

/**
 * Resolve `{ symbol, decimals, name }` for a token contract address.
 *
 * The three SEP-41 view calls are simulated in parallel; `decimals()` is
 * mandatory (an unusable precision would silently mis-format amounts), while
 * a missing `symbol()`/`name()` degrades to the display-label override.
 *
 * Results are cached for a long time, so repeated lookups for the same token
 * cost a single RPC round trip.
 */
export async function resolveTokenMetadata(
  tokenAddress: string,
  options: TokenMetadataOptions = {},
): Promise<TokenMetadata> {
  const address = normalizeTokenAddress(tokenAddress);
  if (!address) {
    throw new TokenMetadataError("a token contract address is required");
  }

  const cached = metadataCache.get(address) as TokenMetadata | undefined;
  if (cached) return cached;

  const cachedFailure = failureCache.get(address) as string | undefined;
  if (cachedFailure) {
    throw new TokenMetadataError(cachedFailure);
  }

  const simulate = options.simulate ?? simulatorOverride ?? simulateTokenView;

  // `Promise.resolve().then(...)` turns a synchronous throw of the simulator
  // into a rejection, so one failing view call never escapes as an exception.
  const [decimalsResult, symbolResult, nameResult] = await Promise.allSettled([
    Promise.resolve().then(() => simulate(address, "decimals")),
    Promise.resolve().then(() => simulate(address, "symbol")),
    Promise.resolve().then(() => simulate(address, "name")),
  ]);

  if (decimalsResult.status === "rejected") {
    const reason =
      decimalsResult.reason instanceof Error
        ? decimalsResult.reason.message
        : String(decimalsResult.reason);
    const message = `failed to resolve token decimals for ${address}: ${reason}`;
    failureCache.set(address, message);
    throw new TokenMetadataError(message);
  }

  const decimals = normalizeDecimals(decimalsResult.value);
  const symbol = normalizeText(
    symbolResult.status === "fulfilled" ? symbolResult.value : "",
  );
  const name = normalizeText(
    nameResult.status === "fulfilled" ? nameResult.value : "",
  );

  const metadata: TokenMetadata = {
    address,
    symbol,
    decimals,
    name: name || getTokenLabel(symbol),
  };

  metadataCache.set(address, metadata);
  return metadata;
}

/**
 * On-chain decimals for a token contract address.
 */
export async function getTokenDecimals(
  tokenAddress: string,
  options: TokenMetadataOptions = {},
): Promise<number> {
  const metadata = await resolveTokenMetadata(tokenAddress, options);
  return metadata.decimals;
}

/**
 * On-chain symbol for a token contract address.
 */
export async function getTokenSymbol(
  tokenAddress: string,
  options: TokenMetadataOptions = {},
): Promise<string> {
  const metadata = await resolveTokenMetadata(tokenAddress, options);
  return metadata.symbol;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Options for the amount formatting helpers. */
export interface TokenAmountFormatOptions extends TokenMetadataOptions {
  /** Keep the trailing zeroes up to `decimals` (fixed scale). */
  fixedScale?: boolean;
}

/**
 * Render a raw on-chain amount with the given precision.
 */
export function formatWithDecimals(
  value: bigint,
  decimals: number,
  fixedScale = false,
): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;

  if (decimals === 0) {
    const text = abs.toString();
    return negative ? `-${text}` : text;
  }

  const scale = 10n ** BigInt(decimals);
  const wholePart = abs / scale;
  const fractionPart = (abs % scale).toString().padStart(decimals, "0");
  const trimmed = fixedScale ? fractionPart : fractionPart.replace(/0+$/, "");
  const text =
    trimmed.length > 0 ? `${wholePart.toString()}.${trimmed}` : wholePart.toString();

  return negative ? `-${text}` : text;
}

/**
 * Format a raw on-chain amount using the token contract's own precision.
 */
export async function formatTokenAmount(
  rawAmount: string | number | bigint,
  tokenAddress: string,
  options: TokenAmountFormatOptions = {},
): Promise<string> {
  const metadata = await resolveTokenMetadata(tokenAddress, options);
  return formatWithDecimals(
    BigInt(typeof rawAmount === "bigint" ? rawAmount : String(rawAmount)),
    metadata.decimals,
    options.fixedScale ?? false,
  );
}

/**
 * Format a raw on-chain amount with the *cached* precision of the token.
 *
 * Never performs an RPC call: when the token was not resolved yet the
 * Stellar-native default precision is used. Useful on hot paths (CSV
 * exports, webhook payloads) that must not block on the network.
 */
export function formatTokenAmountSync(
  rawAmount: string | number | bigint,
  tokenAddress: string,
  fixedScale = false,
): string {
  const decimals = getCachedTokenDecimals(tokenAddress) ?? DEFAULT_TOKEN_DECIMALS;
  return formatWithDecimals(
    BigInt(typeof rawAmount === "bigint" ? rawAmount : String(rawAmount)),
    decimals,
    fixedScale,
  );
}

/**
 * Convert a human-readable amount into raw on-chain units using the token
 * contract's precision.
 */
export async function toTokenUnits(
  humanAmount: string | number,
  tokenAddress: string,
  options: TokenMetadataOptions = {},
): Promise<bigint> {
  const metadata = await resolveTokenMetadata(tokenAddress, options);
  const decimals = metadata.decimals;

  if (typeof humanAmount === "number" && !Number.isFinite(humanAmount)) {
    throw new TokenMetadataError("amount must be a finite number");
  }

  const raw = String(humanAmount).trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new TokenMetadataError("amount must be a numeric decimal value");
  }

  const [wholePart, fractionalPart = ""] = raw.split(".");
  if (fractionalPart.length > decimals) {
    throw new TokenMetadataError(
      `amount has more fractional digits than the token precision (${decimals}) allows`,
    );
  }

  const combined = `${wholePart}${fractionalPart.padEnd(decimals, "0")}`.replace(
    /^0+(?=\d)/,
    "",
  );

  return BigInt(combined);
}

/**
 * Log a warning when a token could not be resolved. Kept here so every
 * caller reports the same way.
 */
export function warnTokenMetadataFailure(
  tokenAddress: string,
  err: unknown,
): void {
  logger.warn("Token metadata resolution failed", {
    tokenAddress,
    error: err instanceof Error ? err.message : String(err),
  });
}
