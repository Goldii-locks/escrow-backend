// ---------------------------------------------------------------------------
// Simulation error helpers  (#83)
// ---------------------------------------------------------------------------

/**
 * Inspects a simulation error string and returns the appropriate HTTP status
 * code plus a client-safe message.
 *
 * Mappings:
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
 */
export class SimError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

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

