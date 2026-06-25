import { isValidStellarContractId } from "./stellar.js";

export type ValidationResult = {
  valid: boolean;
  error?: string;
};

export type ParamSchema = {
  type: "string";
  required?: boolean;
  pattern?: RegExp;
  minLength?: number;
  maxLength?: number;
  custom?: (value: string) => boolean;
  errorMessage?: string;
};

export function validateParam(
  value: unknown,
  schema: ParamSchema,
  label: string
): ValidationResult {
  if (value === undefined || value === null) {
    if (schema.required !== false) {
      return { valid: false, error: `${label} is required` };
    }
    return { valid: true };
  }

  if (typeof value !== "string") {
    return { valid: false, error: `${label} must be a string` };
  }

  if (schema.custom && !schema.custom(value)) {
    return { valid: false, error: schema.errorMessage || `${label} has an invalid value` };
  }

  if (schema.minLength !== undefined && value.length < schema.minLength) {
    return {
      valid: false,
      error: `${label} must be at least ${schema.minLength} characters`,
    };
  }

  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    return {
      valid: false,
      error: `${label} must be at most ${schema.maxLength} characters`,
    };
  }

  if (schema.pattern && !schema.pattern.test(value)) {
    return { valid: false, error: schema.errorMessage || `${label} has an invalid format` };
  }

  return { valid: true };
}

export const contractIdSchema: ParamSchema = {
  type: "string",
  required: true,
  minLength: 56,
  maxLength: 56,
  custom: (value: string) => isValidStellarContractId(value),
  errorMessage: "contractId must be a valid Stellar contract address (C...)",
};

export function validateContractId(contractId: unknown): ValidationResult {
  return validateParam(contractId, contractIdSchema, "contractId");
}
