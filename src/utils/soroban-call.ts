/**
 * Soroban RPC call helpers (#620).
 *
 * Collapses the `new Contract → getAccount → new TransactionBuilder` sequence
 * that every contract read/write route used to repeat into two entry points:
 *
 * - `simulateRead`  – read-only simulation, returns the decoded retval.
 * - `prepareInvoke` – builds and prepares an invocation, returns unsigned XDR.
 *
 * `simulateCall` exposes the raw simulation response for callers that need
 * to inspect error strings or decode the retval themselves.
 */

import {
  Contract,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  scValToNative,
} from "@stellar/stellar-sdk";
import type { Account, xdr } from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";

export const RPC_URL =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE =
  process.env.SOROBAN_NETWORK_PASSPHRASE || Networks.TESTNET;

// #691: Apply an explicit HTTP timeout so stalled RPC connections surface as
// a 504 rather than hanging indefinitely. Default 10 s; override via env.
const RPC_TIMEOUT_MS = parseInt(process.env.RPC_TIMEOUT_MS || "10000", 10);
export const server = new Server(RPC_URL, { timeout: RPC_TIMEOUT_MS });

/** Transaction timeout (seconds) applied to every built transaction. */
const TX_TIMEOUT_S = 30;

type SimulateResponse = Awaited<ReturnType<Server["simulateTransaction"]>>;

/**
 * Map a Soroban simulation error string to an HTTP status + client-safe
 * message:
 *  - Upstream RPC timeout → 504
 *  - Missing / unregistered contract → 404 (Contract not found)
 *  - Missing source account → 404 (Account not found)
 *  - Contract assertion / revert (error codes) → 422
 *  - Everything else → 500
 */
export function classifySimError(rawError: string): { status: number; message: string } {
  // 504 – upstream RPC stalled or timed out (#691)
  if (/timeout|ETIMEDOUT|ECONNRESET|socket hang up|request timeout|connect timeout/i.test(rawError)) {
    return { status: 504, message: "Upstream RPC timeout" };
  }

  // 404 – source account missing on the network
  if (/missing account|account not found/i.test(rawError)) {
    return { status: 404, message: "Source account not found on network" };
  }

  // 404 – contract missing / unregistered on the network
  if (
    /not found|NotFound|contract not found/i.test(rawError) ||
    /contract error #1\b/i.test(rawError)
  ) {
    return { status: 404, message: "Contract not found on network" };
  }

  // 422 – contract executed but reverted / assertion failed
  const contractErrMatch = rawError.match(/contract error #(\d+)/i);
  if (contractErrMatch) {
    return {
      status: 422,
      message: `Contract execution reverted (error code ${contractErrMatch[1]})`,
    };
  }
  if (/revert|assert|panic|trap/i.test(rawError)) {
    return { status: 422, message: "Contract execution reverted" };
  }

  // 500 – everything else (never forward the raw error to the client)
  return { status: 500, message: "Internal server error" };
}

/**
 * Carries an HTTP status + client-safe message out of an async cache/dedup
 * block so the outer catch can respond correctly without re-classifying.
 * `rawError` keeps the original simulation error for server-side logging.
 */
export class SimError extends Error {
  status: number;
  rawError?: string;
  constructor(status: number, message: string, rawError?: string) {
    super(message);
    this.name = "SimError";
    this.status = status;
    this.rawError = rawError;
  }
}

/**
 * Raised by `prepareInvoke` when fetching the source account or preparing
 * the transaction fails. The original RPC error message is preserved so
 * callers can keep classifying on it.
 */
export class InvokeError extends Error {
  stage: "account" | "prepare";
  cause: unknown;
  constructor(stage: "account" | "prepare", cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "InvokeError";
    this.stage = stage;
    this.cause = cause;
  }
}

function buildTx(
  contractId: string,
  account: Account,
  method: string,
  args: xdr.ScVal[],
) {
  const contract = new Contract(contractId);
  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(TX_TIMEOUT_S)
    .build();
}

/**
 * Simulate a contract call from the deployer account and return the raw
 * simulation response. RPC failures (getAccount / simulateTransaction
 * throwing) propagate unchanged.
 */
export async function simulateCall(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<SimulateResponse> {
  const account = await server.getAccount(process.env.DEPLOYER_ADDRESS || "");
  return server.simulateTransaction(buildTx(contractId, account, method, args));
}

/**
 * Simulate a read-only contract call and return `scValToNative(retval)`.
 *
 * Throws `SimError` when the simulation reports an error (classified via
 * `classifySimError`) or returns no retval (500). RPC throws propagate
 * unchanged.
 */
export async function simulateRead(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<any> {
  const result = await simulateCall(contractId, method, args);

  if ("error" in result) {
    const rawError = String(result.error);
    const { status, message } = classifySimError(rawError);
    throw new SimError(status, message, rawError);
  }
  if ("result" in result && result.result?.retval) {
    return scValToNative(result.result.retval);
  }
  throw new SimError(500, "Internal server error");
}

/**
 * Build and prepare a contract invocation, returning the unsigned
 * transaction XDR. `source` is either a Stellar address (its account is
 * fetched) or an already-loaded account.
 *
 * Throws `InvokeError` (stage `account` or `prepare`) on RPC failure.
 */
export async function prepareInvoke(
  contractId: string,
  source: string | Account,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<string> {
  let account: Account;
  if (typeof source === "string") {
    try {
      account = await server.getAccount(source);
    } catch (err) {
      throw new InvokeError("account", err);
    }
  } else {
    account = source;
  }

  const tx = buildTx(contractId, account, method, args);
  try {
    const prepared = await server.prepareTransaction(tx);
    return prepared.toXDR();
  } catch (err) {
    throw new InvokeError("prepare", err);
  }
}
