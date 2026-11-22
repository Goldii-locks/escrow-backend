/**
 * Contract error definitions mapped from Soroban contracts:
 * - Milestone Escrow (contracts/milestone-escrow/src/lib.rs)
 * - Escrow Factory (contracts/escrow-factory/src/lib.rs)
 */

export interface ContractErrorDefinition {
  name: string;
  message: string;
  status: number;
}

export type ContractType = "escrow" | "factory";

export const ESCROW_ERRORS: Record<number, ContractErrorDefinition> = {
  1: {
    name: "AlreadyInitialized",
    message: "Contract instance has already been initialized",
    status: 409,
  },
  2: {
    name: "NotInitialized",
    message: "Contract instance is not initialized",
    status: 400,
  },
  3: {
    name: "AlreadyFunded",
    message: "Escrow is already funded",
    status: 409,
  },
  4: {
    name: "NotFunded",
    message: "Escrow is not yet funded",
    status: 400,
  },
  5: {
    name: "Unauthorized",
    message: "Caller is not authorized to perform this operation",
    status: 403,
  },
  6: {
    name: "InvalidMilestone",
    message: "Invalid milestone index or configuration",
    status: 400,
  },
  7: {
    name: "InvalidStatus",
    message: "Milestone or escrow status does not allow this operation",
    status: 409,
  },
  8: {
    name: "TokenNotWhitelisted",
    message: "Token is not whitelisted for this escrow",
    status: 400,
  },
  9: {
    name: "TokenAlreadyWhitelisted",
    message: "Token is already whitelisted",
    status: 409,
  },
  10: {
    name: "InvalidAmount",
    message: "Amount is invalid or exceeds available balance",
    status: 400,
  },
  11: {
    name: "DeadlineNotPassed",
    message: "The auto-release window has not passed yet",
    status: 409,
  },
  12: {
    name: "InvalidAddress",
    message: "Invalid address specified",
    status: 400,
  },
  13: {
    name: "Paused",
    message: "Escrow is currently paused",
    status: 409,
  },
  14: {
    name: "InvalidRatio",
    message: "Invalid refund ratio specified",
    status: 400,
  },
  15: {
    name: "InvalidExtension",
    message: "Invalid extension parameters",
    status: 400,
  },
  16: {
    name: "EscrowLocked",
    message: "Escrow is locked and cannot be modified",
    status: 409,
  },
  17: {
    name: "MultiSigNoSigners",
    message: "No multi-sig signers provided",
    status: 400,
  },
  18: {
    name: "MultiSigTooManySigners",
    message: "Too many multi-sig signers provided",
    status: 400,
  },
  19: {
    name: "MultiSigInvalidThreshold",
    message: "Invalid multi-sig threshold",
    status: 400,
  },
  20: {
    name: "MultiSigDuplicateSigner",
    message: "Duplicate signer in multi-sig list",
    status: 400,
  },
  21: {
    name: "MultiSigInvalidSigner",
    message: "Invalid signer for multi-sig action",
    status: 400,
  },
  22: {
    name: "MultiSigThresholdNotMet",
    message: "Multi-sig threshold has not been met",
    status: 400,
  },
  23: {
    name: "MultiSigActionExpired",
    message: "Multi-sig action has expired",
    status: 409,
  },
  24: {
    name: "MultiSigActionAlreadyExecuted",
    message: "Multi-sig action has already been executed",
    status: 409,
  },
  25: {
    name: "MultiSigEmptyBalance",
    message: "Multi-sig escrow has empty balance",
    status: 400,
  },
  26: {
    name: "TaxWithholdingInProgress",
    message: "Tax withholding is in progress",
    status: 409,
  },
  27: {
    name: "PlatformFeeAllocationInProgress",
    message: "Platform fee allocation is in progress",
    status: 409,
  },
  28: {
    name: "EmergencyPauseInProgress",
    message: "Emergency pause is in progress",
    status: 409,
  },
  29: {
    name: "EmergencyPauseAlreadyActive",
    message: "Emergency pause is already active",
    status: 409,
  },
  30: {
    name: "NotPaused",
    message: "Escrow is not currently paused",
    status: 400,
  },
  31: {
    name: "InvalidAllocationWeights",
    message: "Invalid allocation weights specified",
    status: 400,
  },
  32: {
    name: "EmptyBalance",
    message: "Escrow balance is empty",
    status: 400,
  },
  33: {
    name: "TimeExtInProgress",
    message: "Time extension request is in progress",
    status: 409,
  },
  34: {
    name: "PaymentStreamingInProgress",
    message: "Payment streaming is in progress",
    status: 409,
  },
  35: {
    name: "FeeTooHigh",
    message: "Configured fee exceeds maximum allowed fee",
    status: 400,
  },
  36: {
    name: "ArithmeticOverflow",
    message: "Arithmetic overflow occurred in contract calculation",
    status: 400,
  },
  37: {
    name: "InsufficientBalance",
    message: "Insufficient balance in escrow",
    status: 400,
  },
  38: {
    name: "InvalidDisputeTimeout",
    message: "Invalid dispute timeout specified",
    status: 400,
  },
  39: {
    name: "DisputeTimeoutNotReached",
    message: "Dispute timeout has not been reached yet",
    status: 409,
  },
  40: {
    name: "InvalidFundingMode",
    message: "Invalid funding mode for escrow",
    status: 400,
  },
  41: {
    name: "MaxRevisions",
    message: "Maximum milestone revision limit reached",
    status: 400,
  },
  42: {
    name: "NothingToSweep",
    message: "No unclaimed tokens available to sweep",
    status: 400,
  },
  43: {
    name: "NotAccepted",
    message: "Milestone has not been accepted",
    status: 400,
  },
  44: {
    name: "InvalidParties",
    message: "Invalid parties specified for escrow",
    status: 400,
  },
  45: {
    name: "TooManyMilestones",
    message: "Too many milestones specified",
    status: 400,
  },
  46: {
    name: "EvidenceLimitReached",
    message: "Dispute evidence limit reached",
    status: 400,
  },
};

export const FACTORY_ERRORS: Record<number, ContractErrorDefinition> = {
  1: {
    name: "NotInitialized",
    message: "Factory contract is not initialized",
    status: 400,
  },
  2: {
    name: "AlreadyInitialized",
    message: "Factory contract has already been initialized",
    status: 409,
  },
  3: {
    name: "Unauthorized",
    message: "Caller is not authorized to invoke factory operation",
    status: 403,
  },
  4: {
    name: "TokenNotAllowed",
    message: "Token is not allowed by factory policy",
    status: 400,
  },
  5: {
    name: "InvalidAmount",
    message: "Invalid amount specified to factory",
    status: 400,
  },
  6: {
    name: "InvalidDisputeTimeout",
    message: "Invalid dispute timeout for factory escrow creation",
    status: 400,
  },
};

export function getContractError(
  code: number,
  contractType?: ContractType,
): ContractErrorDefinition | undefined {
  if (contractType === "escrow") {
    return ESCROW_ERRORS[code];
  }
  if (contractType === "factory") {
    return FACTORY_ERRORS[code];
  }
  return undefined;
}
