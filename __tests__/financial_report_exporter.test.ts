import {
  ERROR_CODES,
  FINANCIAL_REPORT_ERROR_DEFINITIONS,
  validateErrorStructure,
  validateCalculationParameters,
  reportCalculationException,
  exportTransactionLogs,
  buildAndValidateWarningBody,
  type ErrorDefinition,
  type TransactionLogRow,
} from "../src/utils/financial_report_exporter.js";

describe("financial_report_exporter — mismatched parameter error structures (#512)", () => {
  const sampleDefinitions: ErrorDefinition[] = [
    ...FINANCIAL_REPORT_ERROR_DEFINITIONS,
    {
      code: "ORDERED_CALC_ERROR",
      message: "Ordered calc error",
      parameters: [
        { name: "notional", type: "string", required: true },
        { name: "rate", type: "string", required: true },
      ],
      ordered: true,
    },
  ];

  it("accepts a response body whose parameters match the error definition list", () => {
    const body = {
      code: ERROR_CODES.CALCULATION_EXCEPTION,
      parameters: {
        operation: "exportTransactionLogs",
        reason: "amount overflow",
        rowIndex: 2,
      },
    };

    const result = validateErrorStructure(body, sampleDefinitions);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toBe(ERROR_CODES.CALCULATION_EXCEPTION);
      expect(result.validatedParams).toEqual(body.parameters);
    }
  });

  it("detects missing required parameters", () => {
    const body = {
      code: ERROR_CODES.SUM_MISMATCH,
      parameters: {
        expected: "100",
        // missing actual + column
      },
    };

    const result = validateErrorStructure(body, sampleDefinitions);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.MISSING_PARAMETER);
      expect(result.details?.missingParams).toEqual(
        expect.arrayContaining(["actual", "column"])
      );
    }
  });

  it("detects unexpected extra parameters", () => {
    const body = {
      code: ERROR_CODES.INVALID_AMOUNT,
      parameters: {
        field: "amount",
        value: "x",
        extra: true,
      },
    };

    const result = validateErrorStructure(body, sampleDefinitions);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.EXTRA_PARAMETER);
      expect(result.details?.extraParams).toContain("extra");
    }
  });

  it("detects parameter type mismatches", () => {
    const body = {
      code: ERROR_CODES.INVALID_ROW,
      parameters: {
        rowIndex: "0",
        reason: "bad",
      },
    };

    const result = validateErrorStructure(body, sampleDefinitions);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.INVALID_PARAMETER_TYPE);
      expect(result.details?.typeMismatches?.[0]).toMatchObject({
        param: "rowIndex",
        expected: "number",
        actual: "string",
      });
    }
  });

  it("detects parameter order mismatches for ordered definitions", () => {
    const outOfOrderKeysBody = {
      code: "ORDERED_CALC_ERROR",
      parameters: {
        rate: "5",
        notional: "100",
      },
    };

    const orderResult = validateErrorStructure(
      outOfOrderKeysBody,
      sampleDefinitions
    );
    expect(orderResult.ok).toBe(false);
    if (!orderResult.ok) {
      expect(orderResult.code).toBe(ERROR_CODES.INVALID_PARAMETER_ORDER);
      expect(orderResult.error).toMatch(/Parameter order mismatch/i);
    }

    const outOfOrderArrayBody = {
      code: "ORDERED_CALC_ERROR",
      parameters: [
        { name: "rate", value: "5" },
        { name: "notional", value: "100" },
      ],
    };

    const orderResult2 = validateErrorStructure(
      outOfOrderArrayBody,
      sampleDefinitions
    );
    expect(orderResult2.ok).toBe(false);
    if (!orderResult2.ok) {
      expect(orderResult2.code).toBe(ERROR_CODES.INVALID_PARAMETER_ORDER);
    }

    const correctOrderBody = {
      code: "ORDERED_CALC_ERROR",
      parameters: {
        notional: "100",
        rate: "5",
      },
    };
    expect(validateErrorStructure(correctOrderBody, sampleDefinitions).ok).toBe(
      true
    );
  });

  it("returns UNKNOWN_ERROR_DEFINITION for unknown codes", () => {
    const result = validateErrorStructure(
      { code: "NON_EXISTENT_CODE", parameters: {} },
      sampleDefinitions
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.UNKNOWN_ERROR_DEFINITION);
    }
  });

  it("returns PARAM_STRUCTURE_MISMATCH for non-object response bodies", () => {
    const result = validateErrorStructure("string_body", sampleDefinitions);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.PARAM_STRUCTURE_MISMATCH);
      expect(result.error).toMatch(/must be a non-null object/i);
    }
  });

  it("reportCalculationException emits a body shape matching the definition list", () => {
    const warning = reportCalculationException("sumRows", "overflow", 3);
    expect(warning.ok).toBe(false);
    expect(warning.code).toBe(ERROR_CODES.CALCULATION_EXCEPTION);

    const body = {
      code: warning.code,
      parameters: warning.details?.providedParams,
    };
    const validated = validateErrorStructure(body, FINANCIAL_REPORT_ERROR_DEFINITIONS);
    expect(validated.ok).toBe(true);
  });

  it("buildAndValidateWarningBody asserts shapes against definition lists", () => {
    const ok = buildAndValidateWarningBody(ERROR_CODES.SUM_MISMATCH, {
      expected: "10",
      actual: "9",
      column: "amount",
    });
    expect(ok.ok).toBe(true);

    const bad = buildAndValidateWarningBody(ERROR_CODES.SUM_MISMATCH, {
      expected: 10 as unknown as string,
      actual: "9",
      column: "amount",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe(ERROR_CODES.INVALID_PARAMETER_TYPE);
    }
  });

  it("validateCalculationParameters reports calculation exceptions with warning codes", () => {
    const result = validateCalculationParameters({
      operation: "aggregate",
      amounts: ["not-a-number"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.CALCULATION_EXCEPTION);
      expect(result.error).toMatch(/Calculation exception/i);
    }
  });

  it("exportTransactionLogs writes CSV and totals amounts", () => {
    const rows: TransactionLogRow[] = [
      {
        transactionId: "tx1",
        contractId: "C1",
        amount: "100",
        currency: "USDC",
        eventType: "funded",
        timestamp: "2026-01-01T00:00:00Z",
      },
      {
        transactionId: "tx2",
        contractId: "C1",
        amount: 50,
        currency: "USDC",
      },
    ];

    const result = exportTransactionLogs(rows, { expectedTotal: 150 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rowCount).toBe(2);
      expect(result.totalAmount).toBe(150n);
      expect(result.csv).toContain("transaction_id,contract_id,amount");
      expect(result.csv).toContain("tx1,C1,100,USDC,funded,");
    }
  });

  it("exportTransactionLogs returns SUM_MISMATCH when totals diverge", () => {
    const rows: TransactionLogRow[] = [
      { transactionId: "tx1", contractId: "C1", amount: "10" },
      { transactionId: "tx2", contractId: "C1", amount: "10" },
    ];

    const result = exportTransactionLogs(rows, { expectedTotal: 99 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.SUM_MISMATCH);
      const body = {
        code: result.code,
        parameters: result.details?.providedParams,
      };
      expect(validateErrorStructure(body).ok).toBe(true);
    }
  });

  it("exportTransactionLogs reports calculation exception for bad amounts", () => {
    const rows: TransactionLogRow[] = [
      { transactionId: "tx1", contractId: "C1", amount: "12.5" },
    ];
    const result = exportTransactionLogs(rows);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.CALCULATION_EXCEPTION);
    }
  });

  it("keeps warning codes stable across mismatched structures", () => {
    const codes = [
      validateErrorStructure(null),
      validateErrorStructure({ code: "NOPE", parameters: {} }),
      validateErrorStructure({
        code: ERROR_CODES.INVALID_AMOUNT,
        parameters: { field: 1, value: "x" },
      }),
      reportCalculationException("op", "reason"),
    ].map((r) => (r as { code: string }).code);

    expect(codes).toEqual([
      ERROR_CODES.PARAM_STRUCTURE_MISMATCH,
      ERROR_CODES.UNKNOWN_ERROR_DEFINITION,
      ERROR_CODES.INVALID_PARAMETER_TYPE,
      ERROR_CODES.CALCULATION_EXCEPTION,
    ]);
  });
});
