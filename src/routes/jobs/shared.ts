import type { Request, Response, NextFunction } from "express";
import {
  Account,
  Contract,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  Address,
} from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";
import { getJobsByWallet, getEventsByContract } from "../../indexer/db.js";
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
import { config } from "../../config.js";
import logger from "../../utils/logger.js";
import { isValidStellarContractId } from "../../utils/stellar.js";
import { randomUUID } from "crypto";

export const CONTRACT_ID = process.env.CONTRACT_ID || "";
const RPC_URL =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE =
  process.env.SOROBAN_NETWORK_PASSPHRASE || Networks.TESTNET;

// #691: Apply an explicit HTTP timeout so stalled RPC connections surface as
// a 504 rather than hanging indefinitely. Default 10 s; override via env.
const RPC_TIMEOUT_MS = config.rpcTimeoutMs;
export const server = new Server(RPC_URL, { timeout: RPC_TIMEOUT_MS });

/**
 * Source account for read-only simulations (#616). Simulation never checks
 * the source sequence number, so a local Account needs no RPC getAccount
 * lookup — and removes the hidden DEPLOYER_ADDRESS requirement that turned
 * every read endpoint into a 500 when it was unset.
 */
export function simulationSource(): Account {
  return new Account(
    process.env.SIMULATION_SOURCE ||
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0",
  );
}

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


// ---------------------------------------------------------------------------
// Helper: parse job fields out of a successful simulation result
// ---------------------------------------------------------------------------
export const parseJobFromResult = (result: any, contractId: string) => {
  if ("result" in result && result.result?.retval) {
    const val = result.result.retval;
    const client = val.client().toString();
    const freelancer = val.freelancer().toString();
    const arbiter = val.arbiter().toString();
    const token = val.token().toString();
    const funded = val.funded();
    const milestones = val.milestones().map((m: any, i: number) => ({
      index: i,
      amount: m.amount().toString(),
      status: Object.keys(m.status())[0],
    }));

    return { id: contractId, client, freelancer, arbiter, token, funded, milestones };
  }
  return null;
};

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
  getJobsByWallet, getEventsByContract,
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
