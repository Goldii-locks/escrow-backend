import type { Request, Response, NextFunction } from "express";
import {
  Contract,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  Address,
} from "@stellar/stellar-sdk";
import {
  getJobsByWallet,
  getEventsByContract,
  iterateEventsByContract,
  saveJobDraft,
  getJobDraftById,
} from "../../indexer/db.js";
import {
  jobContractRateLimit,
  jobWhitelistRateLimit,
  whitelistUpdateRateLimit,
  partialReleaseRateLimit,
  buildTxRateLimit,
  timeRemainingRateLimit,
  createJobDraftRateLimit,
  claimAutoReleaseRateLimit,
  submitRateLimit,
} from "../../middleware/job-contract-rate-limit.js";
import {
  jobContractCors,
  jobContractSecurityHeaders,
  createJobDraftCors,
  createJobDraftSecurityHeaders,
  submitCors,
  submitSecurityHeaders,
  timeRemainingCors,
  timeRemainingSecurityHeaders,
  byWalletCors,
  byWalletSecurityHeaders,
  partialReleaseCors,
  partialReleaseSecurityHeaders,
  claimAutoReleaseCors,
  claimAutoReleaseSecurityHeaders,
  updateWhitelistCors,
  updateWhitelistSecurityHeaders,
  buildTxCors,
  buildTxSecurityHeaders,
} from "../../middleware/job-contract-security.js";
import { sendError, sendSuccess } from "../../utils/api-response.js";
import { validate, validateWithFields } from "../../middleware/validate.js";
import type { RequestWithValidatedQuery } from "../../middleware/validate.js";
import { createJobDraftValidation } from "../../middleware/create-job-draft-validation.js";
import {
  contractIdParamsSchema,
  whitelistParamsSchema,
  contractMilestoneParamsSchema,
  // Schema for building transaction requests
  buildTxBodySchema,
  submitBodySchema,
  partialReleaseBodySchema,
  claimAutoReleaseBodySchema,
  byWalletParamsSchema,
  byWalletQuerySchema,
  createJobDraftBodySchema,
  createJobDraftLegacyBodySchema,
  whitelistUpdateBodySchema,
  whitelistUpdateRequestSchema,
  feePreviewQuerySchema,
  historyQuerySchema,
  type ByWalletQuery,
  type CreateJobDraftBody,
  type CreateJobDraftLegacyBody,
  type UpdateWhitelistBody,
  type WhitelistUpdateBody,
  type WhitelistUpdateRequestBody,
  type FeePreviewQuery,
} from "../../schemas/jobs.js";
import {
  RPC_URL,
  NETWORK_PASSPHRASE,
  server,
  getRpcUrl,
  simulationSource,
} from "../../utils/soroban-call.js";
import logger from "../../utils/logger.js";
import { isValidStellarContractId } from "../../utils/stellar.js";
import { randomUUID } from "crypto";

/**
 * Truncate a Stellar address to `GABC…WXYZ` for info-level logs.
 *
 * Full addresses must never appear at `info` (the production log level)
 * because the HTTP request logger records the caller's IP on every request,
 * so logging the full address alongside it builds a durable IP↔wallet map.
 * Four leading + four trailing characters are enough for same-session
 * correlation without exposing the complete key.
 *
 * Pass the raw value to `logger.debug` wherever the full address is needed
 * for post-incident debugging.
 */
export function maskAddress(address: string | undefined | null): string {
  if (!address || address.length < 10) return address ?? "";
  return `${address.slice(0, 4)}\u2026${address.slice(-4)}`;
}

export const CONTRACT_ID = process.env.CONTRACT_ID || "";
// The RPC Server, network config and read-simulation source live in
// utils/soroban-call.ts (#620); re-exported here for the route modules.
export { NETWORK_PASSPHRASE, server, getRpcUrl, simulationSource };


/**
 * #692: Validate that the configured SOROBAN_NETWORK_PASSPHRASE matches the
 * passphrase the RPC server actually reports. Called once at startup.
 *
 * Throws with a descriptive message on any mismatch so the process exits
 * before serving any traffic with the wrong network config.
 */
export async function assertRpcNetworkMatches(): Promise<void> {
  const localPassphrase =
    process.env.SOROBAN_NETWORK_PASSPHRASE || Networks.TESTNET;

  let rpcPassphrase: string;
  try {
    const network = await server.getNetwork();
    rpcPassphrase = network.passphrase;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Startup network check failed – could not reach RPC at ${RPC_URL}: ${msg}`,
    );
  }

  if (rpcPassphrase !== localPassphrase) {
    throw new Error(
      `Network passphrase mismatch: RPC reported "${rpcPassphrase}" ` +
        `but SOROBAN_NETWORK_PASSPHRASE is set to "${localPassphrase}". ` +
        `Refusing to start to prevent transactions being built for the wrong network.`,
    );
  }

  logger.info("RPC network verified", {
    network: rpcPassphrase === Networks.TESTNET ? "testnet" : "public",
    rpc: RPC_URL,
  });
}


/**
 * Convert a value produced by `scValToNative` into a JSON-safe structure
 * where all numeric amounts are returned as decimal strings (#719).
 * Handles Maps (contract return values), Arrays, bigints, and primitives.
 */
export function convertScValToNativeStrings(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean")
    return value;
  if (Array.isArray(value)) return value.map(convertScValToNativeStrings);
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of value) {
      obj[String(k)] = convertScValToNativeStrings(v);
    }
    return obj;
  }
  if (typeof value === "object") {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      obj[k] = convertScValToNativeStrings(v);
    }
    return obj;
  }
  return value;
}


export {
  Contract, Networks, TransactionBuilder, BASE_FEE, nativeToScVal, scValToNative, Address,
  getJobsByWallet, getEventsByContract, iterateEventsByContract, saveJobDraft, getJobDraftById,
  jobContractRateLimit, jobWhitelistRateLimit, whitelistUpdateRateLimit, partialReleaseRateLimit,
  buildTxRateLimit, timeRemainingRateLimit, createJobDraftRateLimit, claimAutoReleaseRateLimit,
  submitRateLimit,
  jobContractCors, jobContractSecurityHeaders, createJobDraftCors, createJobDraftSecurityHeaders,
  submitCors, submitSecurityHeaders, timeRemainingCors, timeRemainingSecurityHeaders,
  byWalletCors, byWalletSecurityHeaders, partialReleaseCors, partialReleaseSecurityHeaders,
  claimAutoReleaseCors, claimAutoReleaseSecurityHeaders, updateWhitelistCors,
  updateWhitelistSecurityHeaders, buildTxCors, buildTxSecurityHeaders,
  sendError, sendSuccess, validate, validateWithFields, createJobDraftValidation,
  contractIdParamsSchema, whitelistParamsSchema, contractMilestoneParamsSchema, buildTxBodySchema,
  submitBodySchema, partialReleaseBodySchema, claimAutoReleaseBodySchema, byWalletParamsSchema,
  byWalletQuerySchema, createJobDraftBodySchema, createJobDraftLegacyBodySchema,
  whitelistUpdateBodySchema, whitelistUpdateRequestSchema, feePreviewQuerySchema,
  historyQuerySchema, logger, isValidStellarContractId, randomUUID,
};
export type {
  Request, Response, NextFunction, RequestWithValidatedQuery, ByWalletQuery,
  CreateJobDraftBody, CreateJobDraftLegacyBody, UpdateWhitelistBody, WhitelistUpdateBody,
  WhitelistUpdateRequestBody, FeePreviewQuery,
};
