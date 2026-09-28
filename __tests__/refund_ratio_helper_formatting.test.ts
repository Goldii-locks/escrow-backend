import fs from "fs";
import os from "os";
import path from "path";
import {
  MAX_SAFE_DIGITS,
  ERROR_CODES,
  DEFAULT_REFUND_ASSET_CONFIG,
  KNOWN_REFUND_ASSETS,
  REFUND_CSV_HEADERS,
  REFUND_DB_COLUMN_SCHEMAS,
  resolveRefundAssetTicker,
  getRefundAssetFormatConfig,
  formatRefundValueForDb,
  parseRefundDbValue,
  formatRefundRowForDb,
  buildRefundCsvBlock,
  writeRefundCsvFile,
  type FormattedRefundRow,
} from "../src/utils/refund_ratio_helper.js";
import { parseCSVContent } from "../src/utils/csv-serializer.js";

function rowFor(amount: unknown, ratio: unknown, ticker?: unknown): FormattedRefundRow {
  const result = formatRefundRowForDb({ amount, ratio, ticker });
  if (!result.ok) {
    throw new Error(`expected a formatted row, got ${result.code}: ${result.error}`);
  }
  return result.row;
}

describe("refund_ratio_helper unknown asset ticker fallbacks (#469)", () => {
  it.each(Object.keys(KNOWN_REFUND_ASSETS))("resolves registered ticker %s", (ticker) => {
    const resolution = resolveRefundAssetTicker(ticker);
    expect(resolution).toEqual({
      known: true,
      fallback: false,
      ticker,
      config: KNOWN_REFUND_ASSETS[ticker],
    });
  });

  it("normalizes case and surrounding whitespace on known tickers", () => {
    const resolution = resolveRefundAssetTicker("  usdc ");
    expect(resolution.known).toBe(true);
    expect(resolution.ticker).toBe("USDC");
  });

  it.each([undefined, null, "", "   ", 42, {}, "BAD-CODE", "TOOLONGASSETCODE"])(
    "applies the default configuration when the ticker is missing or malformed (%p)",
    (ticker) => {
      const resolution = resolveRefundAssetTicker(ticker);
      expect(resolution.known).toBe(false);
      expect(resolution.fallback).toBe(true);
      expect(resolution.config).toEqual(DEFAULT_REFUND_ASSET_CONFIG);
      expect(getRefundAssetFormatConfig(ticker)).toEqual({
        ticker: DEFAULT_REFUND_ASSET_CONFIG.ticker,
        decimals: DEFAULT_REFUND_ASSET_CONFIG.decimals,
      });
    }
  );

  it("keeps an unfamiliar but well-formed ticker name with default formatting", () => {
    const resolution = resolveRefundAssetTicker("aqua");
    expect(resolution).toEqual({
      known: false,
      fallback: true,
      ticker: "AQUA",
      config: { ...DEFAULT_REFUND_ASSET_CONFIG, ticker: "AQUA" },
    });
    expect(getRefundAssetFormatConfig("aqua")).toEqual({ ticker: "AQUA", decimals: 7 });
  });

  it("does not resolve prototype keys as registered assets", () => {
    expect(resolveRefundAssetTicker("constructor").known).toBe(false);
    expect(resolveRefundAssetTicker("toString").known).toBe(false);
  });

  it("returns copies so callers cannot mutate the shared defaults", () => {
    const resolution = resolveRefundAssetTicker(undefined);
    resolution.config.decimals = 2;
    expect(DEFAULT_REFUND_ASSET_CONFIG.decimals).toBe(7);
  });

  it("formats refund rows for an unknown ticker with the default precision", () => {
    const row = rowFor(12_345_678, 2_500, "SHINY");
    expect(row.asset_ticker).toBe("SHINY");
    expect(row.decimals).toBe(DEFAULT_REFUND_ASSET_CONFIG.decimals);
    expect(row.amount).toBe("1.2345678");
  });
});

describe("refund_ratio_helper DB column formatting (#470)", () => {
  it("declares a column schema for every persisted row attribute", () => {
    expect(Object.keys(REFUND_DB_COLUMN_SCHEMAS).sort()).toEqual([...REFUND_CSV_HEADERS].sort());
    for (const [key, schema] of Object.entries(REFUND_DB_COLUMN_SCHEMAS)) {
      expect(schema.field).toBe(key);
      expect(schema.nullable).toBe(false);
    }
    expect(REFUND_DB_COLUMN_SCHEMAS.refund_amount).toEqual(
      expect.objectContaining({ format: "TEXT", maxDigits: MAX_SAFE_DIGITS })
    );
  });

  it.each([
    [0n, 7, "0.0000000"],
    [1n, 7, "0.0000001"],
    [25_000_000n, 7, "2.5000000"],
    [-15n, 2, "-0.15"],
    [123n, 0, "123"],
  ])("formats %s at %s decimals as %s", (value, decimals, expected) => {
    expect(formatRefundValueForDb(value, decimals)).toBe(expected);
    expect(parseRefundDbValue(expected, decimals)).toBe(value);
  });

  it("rejects invalid formatter inputs", () => {
    expect(() => formatRefundValueForDb(1 as unknown as bigint, 7)).toThrow(TypeError);
    expect(() => formatRefundValueForDb(1n, -1)).toThrow(RangeError);
    expect(() => formatRefundValueForDb(1n, 1.5)).toThrow(RangeError);
    expect(() => parseRefundDbValue("1.25", 7)).toThrow(SyntaxError);
    expect(() => parseRefundDbValue("1e5", 0)).toThrow(SyntaxError);
  });

  it("writes row attributes that preserve full precision", () => {
    const row = rowFor("123456789012345", 3_333, "XLM");
    expect(row).toEqual({
      asset_ticker: "XLM",
      decimals: 7,
      ratio_bps: 3_333,
      amount: "12345678.9012345",
      refund_amount: "4114814.7777815",
      remaining_amount: "8230864.1234530",
      amount_raw: "123456789012345",
      refund_raw: "41148147777815",
      remaining_raw: "82308641234530",
      precision_preserved: true,
    });

    for (const column of ["amount", "refund_amount", "remaining_amount"] as const) {
      const raw = column === "amount" ? row.amount_raw : column === "refund_amount" ? row.refund_raw : row.remaining_raw;
      expect(parseRefundDbValue(row[column], row.decimals)).toBe(BigInt(raw));
    }
    expect(BigInt(row.refund_raw) + BigInt(row.remaining_raw)).toBe(BigInt(row.amount_raw));
  });

  it("keeps the maximum supported amount exact at 100%", () => {
    const max = "9".repeat(MAX_SAFE_DIGITS);
    const row = rowFor(max, 10_000, "USDC");
    expect(row.refund_raw).toBe(max);
    expect(row.remaining_raw).toBe("0");
    expect(row.refund_amount).toBe("99999999.9999999");
    expect(row.remaining_amount).toBe("0.0000000");
  });

  it("propagates validation errors instead of writing a row", () => {
    const badAmount = formatRefundRowForDb({ amount: -5, ratio: 100 });
    expect(badAmount).toEqual(expect.objectContaining({ ok: false, code: ERROR_CODES.INVALID_AMOUNT }));

    const badRatio = formatRefundRowForDb({ amount: 5, ratio: 10_001 });
    expect(badRatio).toEqual(expect.objectContaining({ ok: false, code: ERROR_CODES.INVALID_RATIO }));

    const missing = formatRefundRowForDb({ amount: 5, ratio: undefined });
    expect(missing).toEqual(expect.objectContaining({ ok: false, code: ERROR_CODES.MISSING_PARAMETER }));
  });
});

describe("refund_ratio_helper CSV exporters (#472)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow-refund-csv-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const rows = () => [
    rowFor(10_000_000, 2_500, "XLM"),
    rowFor(8_000, 7_500, "usdc"),
    rowFor(3, 5_000, undefined),
  ];

  it("builds a CSV block with a header line and one line per row", () => {
    expect(buildRefundCsvBlock(rows())).toBe(
      [
        REFUND_CSV_HEADERS.join(","),
        "XLM,7,2500,1.0000000,0.2500000,0.7500000,10000000,2500000,7500000",
        "USDC,7,7500,0.0008000,0.0006000,0.0002000,8000,6000,2000",
        "UNKNOWN,7,5000,0.0000003,0.0000002,0.0000001,3,2,1",
        "",
      ].join("\n")
    );
  });

  it("omits the header line when requested", () => {
    const csv = buildRefundCsvBlock(rows().slice(0, 1), { includeHeaders: false });
    expect(csv).toBe("XLM,7,2500,1.0000000,0.2500000,0.7500000,10000000,2500000,7500000\n");
  });

  it("escapes cells containing CSV control characters", () => {
    const row = { ...rowFor(100, 100, "XLM"), asset_ticker: 'X,"Y"' };
    const [line] = parseCSVContent(buildRefundCsvBlock([row]), true);
    expect(line[0]).toBe('X,"Y"');
    expect(buildRefundCsvBlock([row])).toContain('"X,""Y"""');
  });

  it("refuses to build an empty table", () => {
    expect(() => buildRefundCsvBlock([])).toThrow(/non-empty/);
    expect(() => writeRefundCsvFile(path.join(tempDir, "empty.csv"), [])).toThrow(/non-empty/);
    expect(fs.existsSync(path.join(tempDir, "empty.csv"))).toBe(false);
  });

  it("writes a file containing the correct table output", () => {
    const filePath = path.join(tempDir, "nested", "refunds.csv");
    const source = rows();

    expect(writeRefundCsvFile(filePath, source)).toBe(source.length);

    const content = fs.readFileSync(filePath, "utf8");
    const [header, ...body] = content.trimEnd().split("\n");
    expect(header.split(",")).toEqual([...REFUND_CSV_HEADERS]);
    expect(body).toHaveLength(source.length);

    const table = parseCSVContent(content, true);
    table.forEach((cells, i) => {
      const expected = REFUND_CSV_HEADERS.map((column) => String(source[i][column]));
      expect(cells).toEqual(expected);
      const record = Object.fromEntries(REFUND_CSV_HEADERS.map((c, j) => [c, cells[j]]));
      const decimals = Number(record.decimals);
      expect(parseRefundDbValue(record.refund_amount, decimals)).toBe(BigInt(record.refund_raw));
      expect(parseRefundDbValue(record.remaining_amount, decimals)).toBe(BigInt(record.remaining_raw));
    });
  });

  it("overwrites an existing export instead of appending", () => {
    const filePath = path.join(tempDir, "refunds.csv");
    writeRefundCsvFile(filePath, rows());
    writeRefundCsvFile(filePath, rows().slice(0, 1), { includeHeaders: false });
    expect(fs.readFileSync(filePath, "utf8")).toBe(
      "XLM,7,2500,1.0000000,0.2500000,0.7500000,10000000,2500000,7500000\n"
    );
  });
});
