/**
 * Oracle conversion-rate scraper helpers with overflow / digit-limit validation
 * and detailed parameter error structure / calculation exception handling (#494).
 * Rejects rates and notionals whose digit count would risk unsafe numeric overflow,
 * and validates response body shapes against declared error definitions.
 */

/** Max decimal digits allowed for a conversion rate or notional (below Number.MAX_SAFE_INTEGER). */
export const MAX_SAFE_DIGITS = 15;

export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "OVERFLOW_EXCESSIVE_DIGITS",
  INVALID_RATE: "OVERFLOW_INVALID_RATE",
  PRODUCT_OVERFLOW: "OVERFLOW_PRODUCT_EXCEEDED",
  MISSING_PARAMETER: "MISSING_PARAMETER",
  EXTRA_PARAMETER: "EXTRA_PARAMETER",
  INVALID_PARAMETER_TYPE: "INVALID_PARAMETER_TYPE",
  INVALID_PARAMETER_ORDER: "INVALID_PARAMETER_ORDER",
  UNKNOWN_ERROR_DEFINITION: "UNKNOWN_ERROR_DEFINITION",
  CALCULATION_EXCEPTION: "CALCULATION_EXCEPTION",
  PARAM_STRUCTURE_MISMATCH: "PARAM_STRUCTURE_MISMATCH",
} as const;

export type ScraperErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type OverflowErrorCode = ScraperErrorCode;

export type ValidationResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: ScraperErrorCode };

export interface ParameterDefinition {
  name: string;
  type: "string" | "number" | "bigint" | "boolean" | "object" | "array";
  required?: boolean;
}

export interface ErrorDefinition {
  code: string;
  message?: string;
  parameters: ParameterDefinition[];
  ordered?: boolean;
}

export interface ParameterValidationSuccess {
  ok: true;
  code?: string;
  validatedParams: Record<string, unknown>;
}

export interface ParameterValidationFailure {
  ok: false;
  error: string;
  code: ScraperErrorCode;
  details?: {
    expectedDefinition?: ErrorDefinition;
    providedParams?: unknown;
    missingParams?: string[];
    extraParams?: string[];
    typeMismatches?: Array<{ param: string; expected: string; actual: string }>;
    orderMismatches?: Array<{ expected: string; actual: string; index: number }>;
    context?: unknown;
    reason?: string;
  };
}

export type ParameterValidationResult =
  | ParameterValidationSuccess
  | ParameterValidationFailure;

export interface CalculationContext {
  notional?: unknown;
  rate?: unknown;
  operation?: string;
  [key: string]: unknown;
}

function digitCount(normalized: string): number {
  const digits = normalized.replace(/^-/, "").replace(/^0+(?=\d)/, "");
  return digits.length === 0 ? 1 : digits.length;
}

function parseIntegerInput(
  input: string | number | bigint,
  label: string,
  invalidCode: ScraperErrorCode
): ValidationResult {
  let raw: string;

  if (typeof input === "bigint") {
    raw = input.toString();
  } else if (typeof input === "number") {
    if (!Number.isFinite(input) || !Number.isInteger(input)) {
      return {
        ok: false,
        error: `${label} must be a finite integer`,
        code: invalidCode,
      };
    }
    raw = String(input);
  } else if (typeof input === "string") {
    raw = input.trim();
    if (!/^-?\d+$/.test(raw)) {
      return {
        ok: false,
        error: `${label} must be an integer numeric value`,
        code: invalidCode,
      };
    }
  } else {
    return {
      ok: false,
      error: `${label} must be an integer numeric value`,
      code: invalidCode,
    };
  }

  if (digitCount(raw) > MAX_SAFE_DIGITS) {
    return {
      ok: false,
      error: `${label} exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
      code: ERROR_CODES.EXCESSIVE_DIGITS,
    };
  }

  return { ok: true, value: BigInt(raw) };
}

/**
 * Validate an oracle conversion rate against digit limits.
 */
export function validateConversionRate(
  rate: string | number | bigint
): ValidationResult {
  return parseIntegerInput(rate, "rate", ERROR_CODES.INVALID_RATE);
}

/**
 * Convert a notional by rate after validating both operands for overflow.
 * Rate is treated as an integer scaled factor (e.g. fixed-point).
 */
export function applyConversionRate(
  notional: string | number | bigint,
  rate: string | number | bigint
): ValidationResult {
  const amount = parseIntegerInput(
    notional,
    "notional",
    ERROR_CODES.INVALID_RATE
  );
  if (!amount.ok) {
    return amount;
  }

  const factor = validateConversionRate(rate);
  if (!factor.ok) {
    return factor;
  }

  const product = amount.value * factor.value;
  if (digitCount(product.toString()) > MAX_SAFE_DIGITS) {
    return {
      ok: false,
      error: `converted value exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
      code: ERROR_CODES.PRODUCT_OVERFLOW,
    };
  }

  return { ok: true, value: product };
}

function checkType(value: unknown, expectedType: string): boolean {
  if (expectedType === "array") {
    return Array.isArray(value);
  }
  if (expectedType === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  if (expectedType === "bigint") {
    return typeof value === "bigint";
  }
  return typeof value === expectedType;
}

function getActualType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/**
 * Validate a response body (or error payload) against error definitions.
 */
export function validateErrorStructure(
  responseBody: unknown,
  definitions: ErrorDefinition[] | Record<string, ErrorDefinition> | ErrorDefinition,
  explicitCode?: string
): ParameterValidationResult {
  if (responseBody === null || typeof responseBody !== "object") {
    return {
      ok: false,
      error: "Response body must be a non-null object",
      code: ERROR_CODES.PARAM_STRUCTURE_MISMATCH,
      details: { providedParams: responseBody },
    };
  }

  const defMap = new Map<string, ErrorDefinition>();
  if (Array.isArray(definitions)) {
    for (const def of definitions) {
      defMap.set(def.code, def);
    }
  } else if ("code" in definitions && "parameters" in definitions) {
    const singleDef = definitions as ErrorDefinition;
    defMap.set(singleDef.code, singleDef);
  } else {
    for (const [key, value] of Object.entries(definitions as Record<string, ErrorDefinition>)) {
      defMap.set(key, value);
    }
  }

  const bodyObj = responseBody as Record<string, unknown>;
  const responseCode =
    explicitCode ||
    (typeof bodyObj.code === "string"
      ? bodyObj.code
      : typeof bodyObj.errorCode === "string"
      ? bodyObj.errorCode
      : typeof bodyObj.error === "string" && defMap.has(bodyObj.error as string)
      ? (bodyObj.error as string)
      : undefined);

  if (!responseCode || !defMap.has(responseCode)) {
    if (defMap.size === 1 && !responseCode && !bodyObj.code && !bodyObj.errorCode) {
      // Use single available definition
    } else {
      return {
        ok: false,
        error: `Unknown or missing error definition code: '${responseCode ?? "undefined"}'`,
        code: ERROR_CODES.UNKNOWN_ERROR_DEFINITION,
        details: { providedParams: responseBody },
      };
    }
  }

  const targetCode = responseCode || Array.from(defMap.keys())[0];
  const expectedDef = defMap.get(targetCode)!;

  let rawParams: unknown = bodyObj.parameters ?? bodyObj.params ?? bodyObj.args ?? bodyObj.data;
  if (rawParams === undefined) {
    const {
      code: _code,
      errorCode: _errorCode,
      error: _error,
      message: _message,
      details: _details,
      ...rest
    } = bodyObj;
    rawParams = rest;
  }

  if (typeof rawParams !== "object" || rawParams === null) {
    return {
      ok: false,
      error: `Parameters for error '${targetCode}' must be an object or array`,
      code: ERROR_CODES.PARAM_STRUCTURE_MISMATCH,
      details: { expectedDefinition: expectedDef, providedParams: rawParams },
    };
  }

  const expectedParams = expectedDef.parameters;
  const expectedNames = expectedParams.map((p) => p.name);
  const expectedParamMap = new Map<string, ParameterDefinition>();
  for (const p of expectedParams) {
    expectedParamMap.set(p.name, p);
  }

  if (Array.isArray(rawParams)) {
    const paramArray = rawParams as unknown[];

    const requiredCount = expectedParams.filter((p) => p.required !== false).length;
    if (paramArray.length < requiredCount) {
      const missingNames = expectedNames.slice(paramArray.length).filter(
        (_, idx) => expectedParams[paramArray.length + idx]?.required !== false
      );
      return {
        ok: false,
        error: `Missing required ordered parameters for error '${targetCode}': ${missingNames.join(", ")}`,
        code: ERROR_CODES.MISSING_PARAMETER,
        details: { expectedDefinition: expectedDef, providedParams: rawParams, missingParams: missingNames },
      };
    }

    if (paramArray.length > expectedParams.length) {
      return {
        ok: false,
        error: `Received ${paramArray.length} parameters, expected max ${expectedParams.length} for error '${targetCode}'`,
        code: ERROR_CODES.EXTRA_PARAMETER,
        details: { expectedDefinition: expectedDef, providedParams: rawParams },
      };
    }

    const hasNameProps =
      paramArray.length > 0 &&
      paramArray.every(
        (item) => typeof item === "object" && item !== null && "name" in item
      );

    if (expectedDef.ordered && hasNameProps) {
      const actualNames = (paramArray as Array<{ name: string; value?: unknown }>).map(
        (item) => item.name
      );
      for (let i = 0; i < actualNames.length; i++) {
        if (actualNames[i] !== expectedNames[i]) {
          return {
            ok: false,
            error: `Parameter order mismatch for error '${targetCode}': expected order [${expectedNames.join(
              ", "
            )}], received [${actualNames.join(", ")}]`,
            code: ERROR_CODES.INVALID_PARAMETER_ORDER,
            details: { expectedDefinition: expectedDef, providedParams: rawParams },
          };
        }
      }
    }

    const validatedParams: Record<string, unknown> = {};
    const typeMismatches: Array<{ param: string; expected: string; actual: string }> = [];

    for (let i = 0; i < paramArray.length; i++) {
      const expectedP = expectedParams[i];
      const rawVal = paramArray[i];
      const actualVal =
        typeof rawVal === "object" && rawVal !== null && "value" in rawVal
          ? (rawVal as { value: unknown }).value
          : rawVal;

      if (!checkType(actualVal, expectedP.type)) {
        typeMismatches.push({
          param: expectedP.name,
          expected: expectedP.type,
          actual: getActualType(actualVal),
        });
      }
      validatedParams[expectedP.name] = actualVal;
    }

    if (typeMismatches.length > 0) {
      return {
        ok: false,
        error: `Parameter type mismatch in ordered parameters for '${targetCode}': ${typeMismatches
          .map((m) => `${m.param} (expected ${m.expected}, got ${m.actual})`)
          .join("; ")}`,
        code: ERROR_CODES.INVALID_PARAMETER_TYPE,
        details: { expectedDefinition: expectedDef, providedParams: rawParams, typeMismatches },
      };
    }

    return {
      ok: true,
      code: targetCode,
      validatedParams,
    };
  }

  const paramObj = rawParams as Record<string, unknown>;
  const missingParams: string[] = [];
  const extraParams: string[] = [];
  const typeMismatches: Array<{ param: string; expected: string; actual: string }> = [];
  const validatedParams: Record<string, unknown> = {};

  for (const p of expectedParams) {
    if (!(p.name in paramObj)) {
      if (p.required !== false) {
        missingParams.push(p.name);
      }
    }
  }

  if (missingParams.length > 0) {
    return {
      ok: false,
      error: `Missing required parameter(s) for error '${targetCode}': ${missingParams.join(", ")}`,
      code: ERROR_CODES.MISSING_PARAMETER,
      details: { expectedDefinition: expectedDef, providedParams: paramObj, missingParams },
    };
  }

  for (const key of Object.keys(paramObj)) {
    if (!expectedParamMap.has(key)) {
      extraParams.push(key);
    }
  }

  if (extraParams.length > 0) {
    return {
      ok: false,
      error: `Unexpected extra parameter(s) for error '${targetCode}': ${extraParams.join(", ")}`,
      code: ERROR_CODES.EXTRA_PARAMETER,
      details: { expectedDefinition: expectedDef, providedParams: paramObj, extraParams },
    };
  }

  if (expectedDef.ordered) {
    const actualKeys = Object.keys(paramObj);
    for (let i = 0; i < actualKeys.length; i++) {
      if (actualKeys[i] !== expectedNames[i]) {
        return {
          ok: false,
          error: `Parameter order mismatch for error '${targetCode}': expected key order [${expectedNames.join(
            ", "
          )}], received key order [${actualKeys.join(", ")}]`,
          code: ERROR_CODES.INVALID_PARAMETER_ORDER,
          details: { expectedDefinition: expectedDef, providedParams: paramObj },
        };
      }
    }
  }

  for (const p of expectedParams) {
    const val = paramObj[p.name];
    if (!checkType(val, p.type)) {
      typeMismatches.push({
        param: p.name,
        expected: p.type,
        actual: getActualType(val),
      });
    }
    validatedParams[p.name] = val;
  }

  if (typeMismatches.length > 0) {
    return {
      ok: false,
      error: `Parameter type mismatch for error '${targetCode}': ${typeMismatches
        .map((m) => `${m.param} (expected ${m.expected}, got ${m.actual})`)
        .join("; ")}`,
      code: ERROR_CODES.INVALID_PARAMETER_TYPE,
      details: { expectedDefinition: expectedDef, providedParams: paramObj, typeMismatches },
    };
  }

  return {
    ok: true,
    code: targetCode,
    validatedParams,
  };
}

/**
 * Validate calculation parameters and context for conversion rate operations,
 * reporting calculation exceptions and parameter structure mismatches.
 */
export function validateCalculationParameters(
  context: CalculationContext,
  expectedDefinition?: ErrorDefinition
): ParameterValidationResult {
  if (context === null || typeof context !== "object") {
    return {
      ok: false,
      error: "Calculation context must be a valid non-null object",
      code: ERROR_CODES.PARAM_STRUCTURE_MISMATCH,
      details: { context },
    };
  }

  if (expectedDefinition) {
    const valResult = validateErrorStructure(context, expectedDefinition);
    if (!valResult.ok) {
      return valResult;
    }
  }

  const { notional, rate } = context;

  if (notional !== undefined) {
    const notionalRes = parseIntegerInput(
      notional as string | number | bigint,
      "notional",
      ERROR_CODES.INVALID_RATE
    );
    if (!notionalRes.ok) {
      return {
        ok: false,
        error: `Calculation exception on notional: ${notionalRes.error}`,
        code: ERROR_CODES.CALCULATION_EXCEPTION,
        details: { context, reason: notionalRes.error },
      };
    }
  }

  if (rate !== undefined) {
    const rateRes = validateConversionRate(rate as string | number | bigint);
    if (!rateRes.ok) {
      return {
        ok: false,
        error: `Calculation exception on rate: ${rateRes.error}`,
        code: ERROR_CODES.CALCULATION_EXCEPTION,
        details: { context, reason: rateRes.error },
      };
    }
  }

  return {
    ok: true,
    validatedParams: context as Record<string, unknown>,
  };
}

/**
 * Safe conversion rate calculation wrapper validating parameter structure and calculation exceptions.
 */
export function safeApplyConversionRateWithValidation(
  notional: unknown,
  rate: unknown,
  errorDef?: ErrorDefinition
): ParameterValidationResult & { value?: bigint } {
  const calcValidation = validateCalculationParameters({ notional, rate }, errorDef);
  if (!calcValidation.ok) {
    return calcValidation;
  }

  const applied = applyConversionRate(
    notional as string | number | bigint,
    rate as string | number | bigint
  );

  if (!applied.ok) {
    return {
      ok: false,
      error: `Calculation exception during rate application: ${applied.error}`,
      code: applied.code,
      details: { context: { notional, rate }, reason: applied.error },
    };
  }

  return {
    ok: true,
    validatedParams: { notional, rate },
    value: applied.value,
  };
}
