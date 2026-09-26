/**
 * Financial report exporter — transaction-log spreadsheet writer with
 * detailed parameter warning codes for calculation exceptions and
 * mismatched error-structure payloads.
 *
 * Validation check (issue #512): response body shapes must match the
 * registered error definition lists (parameter names, types, and order).
 */

export const ERROR_CODES = {
  MISSING_PARAMETER: "FINANCIAL_REPORT_MISSING_PARAMETER",
  EXTRA_PARAMETER: "FINANCIAL_REPORT_EXTRA_PARAMETER",
  INVALID_PARAMETER_TYPE: "FINANCIAL_REPORT_INVALID_PARAMETER_TYPE",
  INVALID_PARAMETER_ORDER: "FINANCIAL_REPORT_INVALID_PARAMETER_ORDER",
  UNKNOWN_ERROR_DEFINITION: "FINANCIAL_REPORT_UNKNOWN_ERROR_DEFINITION",
  CALCULATION_EXCEPTION: "FINANCIAL_REPORT_CALCULATION_EXCEPTION",
  PARAM_STRUCTURE_MISMATCH: "FINANCIAL_REPORT_PARAM_STRUCTURE_MISMATCH",
  INVALID_AMOUNT: "FINANCIAL_REPORT_INVALID_AMOUNT",
  INVALID_ROW: "FINANCIAL_REPORT_INVALID_ROW",
  EMPTY_DATA: "FINANCIAL_REPORT_EMPTY_DATA",
  SERIALIZATION_ERROR: "FINANCIAL_REPORT_SERIALIZATION_ERROR",
  SUM_MISMATCH: "FINANCIAL_REPORT_SUM_MISMATCH",
} as const;

export type FinancialReportErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

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
  code: FinancialReportErrorCode;
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

/** Built-in error definitions used by the exporter for calculation warnings. */
export const FINANCIAL_REPORT_ERROR_DEFINITIONS: ErrorDefinition[] = [
  {
    code: ERROR_CODES.CALCULATION_EXCEPTION,
    message: "Calculation exception while aggregating transaction logs",
    parameters: [
      { name: "operation", type: "string", required: true },
      { name: "reason", type: "string", required: true },
      { name: "rowIndex", type: "number", required: false },
    ],
    ordered: true,
  },
  {
    code: ERROR_CODES.SUM_MISMATCH,
    message: "Spreadsheet totals do not match expected sum",
    parameters: [
      { name: "expected", type: "string", required: true },
      { name: "actual", type: "string", required: true },
      { name: "column", type: "string", required: true },
    ],
    ordered: true,
  },
  {
    code: ERROR_CODES.INVALID_AMOUNT,
    message: "Transaction amount is not a valid integer string",
    parameters: [
      { name: "field", type: "string", required: true },
      { name: "value", type: "string", required: true },
    ],
  },
  {
    code: ERROR_CODES.INVALID_ROW,
    message: "Transaction log row failed validation",
    parameters: [
      { name: "rowIndex", type: "number", required: true },
      { name: "reason", type: "string", required: true },
    ],
  },
];

export interface TransactionLogRow {
  transactionId: string;
  contractId: string;
  amount: string | number | bigint;
  currency?: string;
  eventType?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface CalculationContext {
  operation?: string;
  amounts?: unknown[];
  expectedTotal?: unknown;
  [key: string]: unknown;
}

export type ExportOutcome =
  | { ok: true; csv: string; rowCount: number; totalAmount: bigint }
  | ParameterValidationFailure;

function checkType(
  value: unknown,
  expectedType: ParameterDefinition["type"]
): boolean {
  if (expectedType === "array") return Array.isArray(value);
  if (expectedType === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  if (expectedType === "bigint") return typeof value === "bigint";
  return typeof value === expectedType;
}

function getActualType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function buildDefinitionMap(
  definitions: ErrorDefinition[] | Record<string, ErrorDefinition> | ErrorDefinition
): Map<string, ErrorDefinition> {
  const defMap = new Map<string, ErrorDefinition>();
  if (Array.isArray(definitions)) {
    for (const def of definitions) {
      defMap.set(def.code, def);
    }
  } else if ("code" in definitions && "parameters" in definitions) {
    const singleDef = definitions as ErrorDefinition;
    defMap.set(singleDef.code, singleDef);
  } else {
    for (const [key, value] of Object.entries(
      definitions as Record<string, ErrorDefinition>
    )) {
      defMap.set(key, value);
    }
  }
  return defMap;
}

/**
 * Validate a response body (or error payload) against error definition lists.
 * Asserts parameter names, types, and optional ordering match the definitions.
 */
export function validateErrorStructure(
  responseBody: unknown,
  definitions:
    | ErrorDefinition[]
    | Record<string, ErrorDefinition>
    | ErrorDefinition = FINANCIAL_REPORT_ERROR_DEFINITIONS,
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

  const defMap = buildDefinitionMap(definitions);
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
      // fall through using the sole definition
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

  let rawParams: unknown =
    bodyObj.parameters ?? bodyObj.params ?? bodyObj.args ?? bodyObj.data;
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
      const missingNames = expectedNames
        .slice(paramArray.length)
        .filter((_, idx) => expectedParams[paramArray.length + idx]?.required !== false);
      return {
        ok: false,
        error: `Missing required ordered parameters for error '${targetCode}': ${missingNames.join(", ")}`,
        code: ERROR_CODES.MISSING_PARAMETER,
        details: {
          expectedDefinition: expectedDef,
          providedParams: rawParams,
          missingParams: missingNames,
        },
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
      const actualNames = (
        paramArray as Array<{ name: string; value?: unknown }>
      ).map((item) => item.name);
      for (let i = 0; i < actualNames.length; i++) {
        if (actualNames[i] !== expectedNames[i]) {
          return {
            ok: false,
            error: `Parameter order mismatch for error '${targetCode}': expected order [${expectedNames.join(
              ", "
            )}], received [${actualNames.join(", ")}]`,
            code: ERROR_CODES.INVALID_PARAMETER_ORDER,
            details: {
              expectedDefinition: expectedDef,
              providedParams: rawParams,
              orderMismatches: [
                {
                  expected: expectedNames[i],
                  actual: actualNames[i],
                  index: i,
                },
              ],
            },
          };
        }
      }
    }

    const validatedParams: Record<string, unknown> = {};
    const typeMismatches: Array<{
      param: string;
      expected: string;
      actual: string;
    }> = [];

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
        details: {
          expectedDefinition: expectedDef,
          providedParams: rawParams,
          typeMismatches,
        },
      };
    }

    return { ok: true, code: targetCode, validatedParams };
  }

  const paramObj = rawParams as Record<string, unknown>;
  const missingParams: string[] = [];
  const extraParams: string[] = [];
  const typeMismatches: Array<{
    param: string;
    expected: string;
    actual: string;
  }> = [];
  const validatedParams: Record<string, unknown> = {};

  for (const p of expectedParams) {
    if (!(p.name in paramObj) && p.required !== false) {
      missingParams.push(p.name);
    }
  }

  if (missingParams.length > 0) {
    return {
      ok: false,
      error: `Missing required parameter(s) for error '${targetCode}': ${missingParams.join(", ")}`,
      code: ERROR_CODES.MISSING_PARAMETER,
      details: {
        expectedDefinition: expectedDef,
        providedParams: paramObj,
        missingParams,
      },
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
      details: {
        expectedDefinition: expectedDef,
        providedParams: paramObj,
        extraParams,
      },
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
          details: {
            expectedDefinition: expectedDef,
            providedParams: paramObj,
            orderMismatches: [
              {
                expected: expectedNames[i],
                actual: actualKeys[i],
                index: i,
              },
            ],
          },
        };
      }
    }
  }

  for (const p of expectedParams) {
    if (!(p.name in paramObj)) continue;
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
      details: {
        expectedDefinition: expectedDef,
        providedParams: paramObj,
        typeMismatches,
      },
    };
  }

  return { ok: true, code: targetCode, validatedParams };
}

/**
 * Build a typed warning payload for a calculation exception so callers can
 * assert the body shape against FINANCIAL_REPORT_ERROR_DEFINITIONS.
 */
export function reportCalculationException(
  operation: string,
  reason: string,
  rowIndex?: number
): ParameterValidationFailure {
  const parameters: Record<string, unknown> = { operation, reason };
  if (rowIndex !== undefined) {
    parameters.rowIndex = rowIndex;
  }

  return {
    ok: false,
    error: `Calculation exception during '${operation}': ${reason}`,
    code: ERROR_CODES.CALCULATION_EXCEPTION,
    details: {
      expectedDefinition: FINANCIAL_REPORT_ERROR_DEFINITIONS.find(
        (d) => d.code === ERROR_CODES.CALCULATION_EXCEPTION
      ),
      providedParams: parameters,
      reason,
      context: { operation, rowIndex },
    },
  };
}

function parseAmount(value: unknown, label: string): ParameterValidationResult & { value?: bigint } {
  if (typeof value === "bigint") {
    return { ok: true, validatedParams: { [label]: value }, value };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      return reportCalculationException("parseAmount", `${label} must be a finite integer`);
    }
    return { ok: true, validatedParams: { [label]: value }, value: BigInt(value) };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      return reportCalculationException(
        "parseAmount",
        `${label} must be an integer numeric value`
      );
    }
    return { ok: true, validatedParams: { [label]: trimmed }, value: BigInt(trimmed) };
  }
  return reportCalculationException(
    "parseAmount",
    `${label} has unsupported type ${getActualType(value)}`
  );
}

/**
 * Validate calculation context before aggregating transaction totals.
 */
export function validateCalculationParameters(
  context: CalculationContext
): ParameterValidationResult {
  if (context === null || typeof context !== "object") {
    return {
      ok: false,
      error: "Calculation context must be a valid non-null object",
      code: ERROR_CODES.PARAM_STRUCTURE_MISMATCH,
      details: { context },
    };
  }

  if (context.amounts !== undefined) {
    if (!Array.isArray(context.amounts)) {
      return reportCalculationException(
        context.operation ?? "validateCalculationParameters",
        "amounts must be an array"
      );
    }
    for (let i = 0; i < context.amounts.length; i++) {
      const parsed = parseAmount(context.amounts[i], `amounts[${i}]`);
      if (!parsed.ok) {
        return {
          ...parsed,
          details: {
            ...parsed.details,
            context,
          },
        };
      }
    }
  }

  if (context.expectedTotal !== undefined) {
    const parsed = parseAmount(context.expectedTotal, "expectedTotal");
    if (!parsed.ok) {
      return {
        ...parsed,
        details: {
          ...parsed.details,
          context,
        },
      };
    }
  }

  return {
    ok: true,
    validatedParams: context as Record<string, unknown>,
  };
}

function escapeCsvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

/**
 * Export transaction log rows to a CSV spreadsheet block, summing amounts and
 * reporting calculation exceptions via detailed parameter warning codes.
 */
export function exportTransactionLogs(
  rows: TransactionLogRow[],
  options?: { expectedTotal?: string | number | bigint }
): ExportOutcome {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      ok: false,
      error: "Transaction log rows must be a non-empty array",
      code: ERROR_CODES.EMPTY_DATA,
    };
  }

  const calcCheck = validateCalculationParameters({
    operation: "exportTransactionLogs",
    amounts: rows.map((r) => r.amount),
    expectedTotal: options?.expectedTotal,
  });
  if (!calcCheck.ok) {
    return calcCheck;
  }

  let total = 0n;
  const lines: string[] = [
    "transaction_id,contract_id,amount,currency,event_type,timestamp",
  ];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== "object") {
      return {
        ok: false,
        error: `Invalid transaction row at index ${i}`,
        code: ERROR_CODES.INVALID_ROW,
        details: { reason: "row is not an object", context: { rowIndex: i } },
      };
    }
    if (typeof row.transactionId !== "string" || typeof row.contractId !== "string") {
      return {
        ok: false,
        error: `Invalid transaction row at index ${i}: missing transactionId or contractId`,
        code: ERROR_CODES.INVALID_ROW,
        details: {
          reason: "missing required string fields",
          context: { rowIndex: i },
        },
      };
    }

    const parsed = parseAmount(row.amount, `rows[${i}].amount`);
    if (!parsed.ok || parsed.value === undefined) {
      return {
        ...parsed,
        details: {
          ...parsed.details,
          context: { rowIndex: i, row },
        },
      } as ParameterValidationFailure;
    }

    total += parsed.value;
    lines.push(
      [
        escapeCsvCell(row.transactionId),
        escapeCsvCell(row.contractId),
        escapeCsvCell(parsed.value.toString()),
        escapeCsvCell(row.currency ?? ""),
        escapeCsvCell(row.eventType ?? ""),
        escapeCsvCell(row.timestamp ?? ""),
      ].join(",")
    );
  }

  if (options?.expectedTotal !== undefined) {
    const expected = parseAmount(options.expectedTotal, "expectedTotal");
    if (!expected.ok || expected.value === undefined) {
      return expected as ParameterValidationFailure;
    }
    if (expected.value !== total) {
      const mismatchBody = {
        code: ERROR_CODES.SUM_MISMATCH,
        parameters: {
          expected: expected.value.toString(),
          actual: total.toString(),
          column: "amount",
        },
      };
      const structure = validateErrorStructure(mismatchBody);
      if (!structure.ok) {
        return structure;
      }
      return {
        ok: false,
        error: `Spreadsheet totals mismatch: expected ${expected.value}, got ${total}`,
        code: ERROR_CODES.SUM_MISMATCH,
        details: {
          expectedDefinition: FINANCIAL_REPORT_ERROR_DEFINITIONS.find(
            (d) => d.code === ERROR_CODES.SUM_MISMATCH
          ),
          providedParams: mismatchBody.parameters,
        },
      };
    }
  }

  return {
    ok: true,
    csv: lines.join("\n") + "\n",
    rowCount: rows.length,
    totalAmount: total,
  };
}

/**
 * Convenience helper: shape a warning response body and validate it against
 * the exporter's error definition list.
 */
export function buildAndValidateWarningBody(
  code: FinancialReportErrorCode,
  parameters: Record<string, unknown>
): ParameterValidationResult {
  const body = { code, parameters };
  return validateErrorStructure(body, FINANCIAL_REPORT_ERROR_DEFINITIONS);
}
