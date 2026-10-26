import {
  formatDecimalForDb,
  parseDecimalDbValue,
  formatRefundValueForDb,
  parseRefundDbValue,
  formatAmountForDatabase,
  parseAmountFromDatabase,
  validateDbPrecisionSchema,
  formatForDbStorage,
  formatRawForDbStorage,
  formatHumanForDbStorage,
  configureFormatColumns,
} from "../src/utils/db-precision.js";
import * as token from "../src/utils/token_decimals_converter.js";
import { formatReportValueForDb } from "../src/utils/financial_report_exporter.js";
import { formatLedgerValueForDb } from "../src/utils/audit_ledger_sum_checker.js";
import { formatForDb } from "../src/utils/conversion_rate_math.js";
import * as refund from "../src/utils/refund_ratio_helper.js";
import * as allocator from "../src/utils/partial-payment-allocator.js";

describe("formatDecimalForDb", () => {
  it.each([
    [10_000_000n, 7, "1.0000000"],
    [12_345_678n, 7, "1.2345678"],
    [1n, 7, "0.0000001"],
    [0n, 7, "0.0000000"],
    [-5_000_000n, 7, "-0.5000000"],
    [100n, 0, "100"],
    [-100n, 0, "-100"],
    [2n ** 127n - 1n, 18, "170141183460469231731.687303715884105727"],
  ])("formats %s at %i decimals as %s", (value, decimals, expected) => {
    expect(formatDecimalForDb(value, decimals)).toBe(expected);
  });

  it("trims trailing zeroes when fixedScale is false", () => {
    expect(formatDecimalForDb(15_000_000n, 7, { fixedScale: false })).toBe("1.5");
    expect(formatDecimalForDb(10_000_000n, 7, { fixedScale: false })).toBe("1");
    expect(formatDecimalForDb(0n, 7, { fixedScale: false })).toBe("0");
  });

  it("names the caller in thrown errors", () => {
    expect(() => formatDecimalForDb(1 as unknown as bigint, 2, { label: "fn" })).toThrow(
      new TypeError("fn: value must be a bigint"),
    );
    expect(() => formatDecimalForDb(1n, -1, { label: "fn" })).toThrow(
      new RangeError("fn: decimals must be a non-negative integer, got -1"),
    );
    expect(() => formatDecimalForDb(1n, 1.5)).toThrow(RangeError);
  });

  it("is the implementation behind every module-specific formatter", () => {
    for (const [value, decimals] of [
      [25_000_000n, 7],
      [-1n, 3],
      [42n, 0],
    ] as const) {
      const expected = formatDecimalForDb(value, decimals);
      expect(formatRefundValueForDb(value, decimals)).toBe(expected);
      expect(formatReportValueForDb(value, decimals)).toBe(expected);
      expect(formatLedgerValueForDb(value, decimals)).toBe(expected);
      expect(formatForDb(value, decimals)).toBe(expected);
    }
    expect(() => formatRefundValueForDb(1n, -1)).toThrow(/^formatRefundValueForDb:/);
    expect(() => formatReportValueForDb(1n, -1)).toThrow(/^formatReportValueForDb:/);
    expect(() => formatLedgerValueForDb(1n, -1)).toThrow(/^formatLedgerValueForDb:/);
    expect(() => formatForDb(1n, -1)).toThrow(/^formatForDb:/);
  });
});

describe("parseDecimalDbValue / parseRefundDbValue", () => {
  it("round-trips fixed-scale values", () => {
    for (const value of [0n, 1n, -1n, 25_000_000n, 2n ** 100n]) {
      expect(parseDecimalDbValue(formatDecimalForDb(value, 7), 7)).toBe(value);
      expect(parseRefundDbValue(formatRefundValueForDb(value, 7), 7)).toBe(value);
    }
    expect(parseDecimalDbValue("-42", 0)).toBe(-42n);
  });

  it("rejects values at the wrong precision", () => {
    expect(() => parseDecimalDbValue("1.5", 7)).toThrow(SyntaxError);
    expect(() => parseRefundDbValue("1.50", 1)).toThrow(
      'parseRefundDbValue: "1.50" does not match 1-decimal precision',
    );
    expect(() => parseDecimalDbValue("1.0", 0)).toThrow(SyntaxError);
  });
});

describe("formatAmountForDatabase / parseAmountFromDatabase", () => {
  it("round-trips integer amounts without precision loss", () => {
    const big = 2n ** 127n - 1n;
    expect(formatAmountForDatabase(big)).toBe(big.toString());
    expect(parseAmountFromDatabase(formatAmountForDatabase(big))).toBe(big);
  });

  it("rejects malformed amounts", () => {
    expect(() => parseAmountFromDatabase("1.5")).toThrow(
      "Invalid database amount format: 1.5",
    );
  });
});

describe("validateDbPrecisionSchema", () => {
  it("accepts valid schemas", () => {
    expect(validateDbPrecisionSchema({})).toEqual({ ok: true });
    expect(validateDbPrecisionSchema({ scale: 7, precision: 20 })).toEqual({ ok: true });
  });

  it.each([
    [{ scale: -1 }, token.ERROR_CODES.INVALID_DECIMALS],
    [{ scale: 19 }, token.ERROR_CODES.INVALID_DECIMALS],
    [{ precision: 0 }, token.ERROR_CODES.INVALID_SCHEMA],
    [{ precision: 1.5 }, token.ERROR_CODES.INVALID_SCHEMA],
    [{ precision: 1000 }, token.ERROR_CODES.INVALID_SCHEMA],
    [{ scale: 7, precision: 5 }, token.ERROR_CODES.INVALID_SCHEMA],
  ])("rejects %j with %s", (schema, code) => {
    const res = validateDbPrecisionSchema(schema);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(code);
  });
});

describe("formatForDbStorage family", () => {
  it("formats raw integer input", () => {
    const res = formatForDbStorage(15_000_000n, 7);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.row.raw_amount).toBe("15000000");
      expect(res.row.formatted_amount).toBe("1.5000000");
      expect(res.row.trimmed_amount).toBe("1.5");
      expect(res.row.decimals).toBe(7);
    }
  });

  it("treats decimal strings as human input in auto mode", () => {
    const res = formatForDbStorage("1.5", 7);
    expect(res.ok && res.row.raw_amount).toBe("15000000");
  });

  it("forces the input type for the raw / human variants", () => {
    const raw = formatRawForDbStorage("15", 1);
    const human = formatHumanForDbStorage("15", 1);
    expect(raw.ok && raw.row.formatted_amount).toBe("1.5");
    expect(human.ok && human.row.raw_amount).toBe("150");
  });

  it("maps custom column names and enforces precision", () => {
    const res = formatForDbStorage(1n, 2, { columns: { rawAmount: "amt" } });
    expect(res.ok && res.row.amt).toBe("1");

    const tooWide = formatForDbStorage(123456n, 2, { precision: 3 });
    expect(tooWide.ok).toBe(false);
    if (!tooWide.ok) expect(tooWide.code).toBe(token.ERROR_CODES.EXCESSIVE_DIGITS);
  });

  it("rejects negative amounts", () => {
    expect(formatForDbStorage("-1", 2).ok).toBe(false);
    expect(formatForDbStorage(-1, 2).ok).toBe(false);
  });

  it("applies configured defaults", () => {
    const fmt = configureFormatColumns({ scale: 2 });
    const res = fmt.format(150n);
    expect(res.ok && res.row.formatted_amount).toBe("1.50");
  });
});

describe("re-exports keep existing import paths working", () => {
  it("token_decimals_converter re-exports the db-precision implementations", () => {
    expect(token.formatForDbStorage).toBe(formatForDbStorage);
    expect(token.formatRawForDbStorage).toBe(formatRawForDbStorage);
    expect(token.formatHumanForDbStorage).toBe(formatHumanForDbStorage);
    expect(token.validateDbPrecisionSchema).toBe(validateDbPrecisionSchema);
    expect(token.configureFormatColumns).toBe(configureFormatColumns);
  });

  it("refund_ratio_helper and partial-payment-allocator re-export their helpers", () => {
    expect(refund.formatRefundValueForDb).toBe(formatRefundValueForDb);
    expect(refund.parseRefundDbValue).toBe(parseRefundDbValue);
    expect(allocator.formatAmountForDatabase).toBe(formatAmountForDatabase);
    expect(allocator.parseAmountFromDatabase).toBe(parseAmountFromDatabase);
  });
});
