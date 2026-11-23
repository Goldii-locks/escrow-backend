// Simulation error helpers (#83) live in utils/soroban-call.ts (#620).
export { classifySimError, SimError } from "../../utils/soroban-call.js";

// ---------------------------------------------------------------------------
// Submit error helper  – maps sendTransaction / XDR errors to HTTP statuses
// ---------------------------------------------------------------------------

export type Classified = { status: number; message: string };

export function classifySubmitError(rawError: string): Classified {
  // 504 – upstream RPC stalled or timed out (#691)
  if (/timeout|ETIMEDOUT|ECONNRESET|socket hang up|request timeout|connect timeout/i.test(rawError)) {
    return { status: 504, message: "Upstream RPC timeout" };
  }

  // 401 – authentication / signature / authorization failures
  if (
    /unauthorized|401/i.test(rawError) ||
    /BAD_AUTH|bad_auth|invalid.*signature|wrong.*network|wrong.*passphrase/i.test(rawError) ||
    /authentication.*(failed|required)|credentials/i.test(rawError)
  ) {
    return { status: 401, message: "Unauthorized: invalid signature or wrong network" };
  }

  // 404 – account / contract not found on the network at submission time
  if (
    /not found|NotFound|404/i.test(rawError) ||
    /missing account|account.*does not exist|contract not found/i.test(rawError) ||
    /no such (account|contract|data entry)/i.test(rawError) ||
    /tx_no_source_account|NO_ACCOUNT/i.test(rawError)
  ) {
    return { status: 404, message: "Account or contract not found on network" };
  }

  // 422 – well-formed transaction rejected at protocol / contract level
  const contractErrMatch = rawError.match(/contract error #(\d+)/i);
  if (contractErrMatch) {
    return {
      status: 422,
      message: `Contract execution reverted (error code ${contractErrMatch[1]})`,
    };
  }
  if (
    /revert|assert|panic|trap/i.test(rawError) ||
    /tx_failed|op_(bad_auth|underfunded|no_trust|line_full|invalid)/i.test(rawError) ||
    /INSUFFICIENT_BALANCE|BAD_SEQ|TOO_EARLY|TOO_LATE|MISSING_OPERATION/i.test(rawError) ||
    /transaction.*(failed|rejected|invalid)/i.test(rawError)
  ) {
    return { status: 422, message: "Transaction rejected by network" };
  }

  // 400 – structural / malformed XDR issues that are definitively client errors
  if (
    /malformed|bad_request|bad xdr|invalid xdr|unparseable/i.test(rawError) ||
    /tx_malformed|MALFORMED/i.test(rawError) ||
    /XDR.*pars/i.test(rawError)
  ) {
    return { status: 400, message: "Malformed transaction XDR" };
  }

  // 500 – everything else (network blips, timeouts, RPC 5xx, etc.)
  return { status: 500, message: "Internal server error" };
}

