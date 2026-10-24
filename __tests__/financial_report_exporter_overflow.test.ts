import {
  ERROR_CODES,
  FINANCIAL_REPORT_ERROR_DEFINITIONS,
  MAX_TRANSACTION_LOG_AMOUNT_DIGITS,
  exportTransactionLogs,
  reportAmountOverflow,
  validateCalculationParameters,
  validateErrorStructure,
  type TransactionLogRow,
} from "../src/utils/financial_report_exporter.js";
import { MAX_AMOUNT, MIN_AMOUNT } from "../src/utils/digit-limit-validator.js";

const row = (amount: TransactionLogRow["amount"], id = "tx-1"): TransactionLogRow => ({
  transactionId: id,
  contractId: "CABC",
  amount,
});

describe("financial_report_exporter — overflow validation limits (#201)", () => {
  it("accepts amounts at the exact i128 boundaries", () => {
    const result = exportTransactionLogs([row(MAX_AMOUNT.toString()), row(MIN_AMOUNT, "tx-2")]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.totalAmount).toBe(-1n);
  });

  it("blocks digit strings longer than the i128 digit limit", () => {
    const huge = "9".repeat(MAX_TRANSACTION_LOG_AMOUNT_DIGITS + 1);
    const result = exportTransactionLogs([row(huge)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.AMOUNT_OVERFLOW);
      expect(result.error).toMatch(/digits/);
    }
  });

  it("blocks values just outside the i128 range", () => {
    for (const value of [(MAX_AMOUNT + 1n).toString(), MIN_AMOUNT - 1n]) {
      const result = exportTransactionLogs([row(value)]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(ERROR_CODES.AMOUNT_OVERFLOW);
    }
  });

  it("blocks unsafe JavaScript numbers that already lost precision", () => {
    const result = exportTransactionLogs([row(Number.MAX_SAFE_INTEGER + 2)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.AMOUNT_OVERFLOW);
      expect(result.error).toMatch(/MAX_SAFE_INTEGER/);
    }
  });

  it("blocks a running total that overflows i128 even when each row fits", () => {
    const result = exportTransactionLogs([
      row(MAX_AMOUNT.toString(), "tx-1"),
      row("1", "tx-2"),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODES.AMOUNT_OVERFLOW);
      expect(result.details?.context).toEqual({ rowIndex: 1 });
    }
  });

  it("blocks an excessive expectedTotal", () => {
    const result = validateCalculationParameters({
      amounts: ["1"],
      expectedTotal: "1" + "0".repeat(60),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ERROR_CODES.AMOUNT_OVERFLOW);
  });

  it("produces an overflow body that matches its registered error definition", () => {
    const failure = reportAmountOverflow("amount", "1".repeat(50), "exceeds limit");
    expect(failure.details?.expectedDefinition).toBe(
      FINANCIAL_REPORT_ERROR_DEFINITIONS.find((d) => d.code === ERROR_CODES.AMOUNT_OVERFLOW)
    );
    const structure = validateErrorStructure({
      code: failure.code,
      parameters: failure.details?.providedParams,
    });
    expect(structure.ok).toBe(true);
  });
});
