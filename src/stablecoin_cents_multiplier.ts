/**
 * Stablecoin cents multiplier.
 *
 * Integer precision conversion helper used to convert between human-readable
 * stablecoin amounts and their integer (cents) representation.
 */

export interface CentsMultiplierOptions {
  /** Number of decimal places used by the stablecoin (defaults to 2). */
  decimals?: number;
  /** Rounding mode applied when scaling fractional amounts. */
  rounding?: 'floor' | 'ceil' | 'round';
}

const DEFAULT_DECIMALS = 2;

/**
 * Resolve the integer multiplier for a given number of decimals.
 * e.g. 2 decimals -> 100, 6 decimals -> 1_000_000.
 */
export function centsMultiplier(decimals: number = DEFAULT_DECIMALS): number {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`decimals must be a non-negative integer, received ${decimals}`);
  }
  return Math.pow(10, decimals);
}

/**
 * Convert a human-readable stablecoin amount into its integer cents value.
 */
export function toCents(
  amount: number | string,
  options: CentsMultiplierOptions = {},
): number {
  const decimals = options.decimals ?? DEFAULT_DECIMALS;
  const rounding = options.rounding ?? 'round';
  const multiplier = centsMultiplier(decimals);

  const numeric = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(numeric)) {
    throw new TypeError(`amount must be a finite number, received ${amount}`);
  }

  const scaled = numeric * multiplier;
  switch (rounding) {
    case 'floor':
      return Math.floor(scaled);
    case 'ceil':
      return Math.ceil(scaled);
    case 'round':
    default:
      return Math.round(scaled);
  }
}

/**
 * Convert an integer cents value back into a human-readable amount.
 */
export function fromCents(
  cents: number | string,
  options: CentsMultiplierOptions = {},
): number {
  const decimals = options.decimals ?? DEFAULT_DECIMALS;
  const multiplier = centsMultiplier(decimals);

  const numeric = typeof cents === 'string' ? Number(cents) : cents;
  if (!Number.isFinite(numeric)) {
    throw new TypeError(`cents must be a finite number, received ${cents}`);
  }

  return numeric / multiplier;
}

/**
 * A single row of a serialized stablecoin amount table.
 */
export interface CentsFormatRow {
  /** Human-readable amount. */
  amount: number;
  /** Integer cents representation. */
  cents: number;
}

/**
 * Escape a single CSV field, quoting it when it contains a delimiter,
 * quote, or newline character.
 */
export function escapeCsvField(value: string | number): string {
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Build the CSV header block for a serialized amount table.
 */
export function buildCsvHeader(columns: string[] = ['amount', 'cents']): string {
  return columns.map(escapeCsvField).join(',');
}

/**
 * Build a single CSV row block from a format row.
 */
export function buildCsvRow(row: CentsFormatRow): string {
  return [row.amount, row.cents].map(escapeCsvField).join(',');
}

/**
 * Serialize a list of amounts into a CSV formatting block.
 *
 * The produced block always starts with a header row followed by one row per
 * amount, using `\n` line endings and a trailing newline.
 */
export function exportCentsCsv(
  amounts: Array<number | string>,
  options: CentsMultiplierOptions = {},
): string {
  const rows = amounts.map((amount) => {
    const numeric = typeof amount === 'string' ? Number(amount) : amount;
    return {
      amount: numeric,
      cents: toCents(numeric, options),
    };
  });

  const lines = [buildCsvHeader(), ...rows.map(buildCsvRow)];
  return `${lines.join('\n')}\n`;
}

/**
 * Serialize a list of amounts into a fixed-width table block.
 */
export function exportCentsTable(
  amounts: Array<number | string>,
  options: CentsMultiplierOptions = {},
): string {
  const rows = amounts.map((amount) => {
    const numeric = typeof amount === 'string' ? Number(amount) : amount;
    return {
      amount: numeric,
      cents: toCents(numeric, options),
    };
  });

  const header = ['amount', 'cents'];
  const widths = header.map((column, index) =>
    Math.max(
      column.length,
      ...rows.map((row) => String(index === 0 ? row.amount : row.cents).length),
    ),
  );

  const formatLine = (cells: Array<string | number>): string =>
    cells
      .map((cell, index) => String(cell).padEnd(widths[index]))
      .join('  ')
      .trimEnd();

  const lines = [
    formatLine(header),
    ...rows.map((row) => formatLine([row.amount, row.cents])),
  ];

  return `${lines.join('\n')}\n`;
}

/**
 * A single verified numeric expectation for the cents multiplier math.
 *
 * Each case pairs a human-readable `amount` with the exact integer `cents`
 * value that the conversion helpers must produce, so the math can be checked
 * against hand-calculated outcomes.
 */
export interface CentsMultiplierCase {
  /** Human-readable stablecoin amount. */
  amount: number;
  /** Expected integer cents value for the default (2 decimal) multiplier. */
  cents: number;
  /** Optional non-default decimal precision for this case. */
  decimals?: number;
  /** Optional rounding mode for this case. */
  rounding?: 'floor' | 'ceil' | 'round';
}

/**
 * Verified numeric test data for `stablecoin_cents_multiplier`.
 *
 * The values below are hand-calculated against the default 2-decimal
 * multiplier (100) unless a case overrides `decimals`/`rounding`.
 */
export const CENTS_MULTIPLIER_CASES: CentsMultiplierCase[] = [
  // Typical values: amount * 100.
  { amount: 0, cents: 0 },
  { amount: 1, cents: 100 },
  { amount: 1.5, cents: 150 },
  { amount: 12.34, cents: 1234 },
  { amount: 99.99, cents: 9999 },
  { amount: 100, cents: 10000 },
  { amount: 1234.56, cents: 123456 },
  // Boundary values.
  { amount: 0.01, cents: 1 },
  { amount: 0.1, cents: 10 },
  { amount: 0.001, cents: 0 },
  { amount: 0.005, cents: 1 },
  { amount: 0.004, cents: 0 },
  // Precision-sensitive inputs.
  { amount: 0.1 + 0.2, cents: 30 },
  { amount: 1.005, cents: 100 },
  { amount: 2.675, cents: 268 },
  // Non-default decimal precision (6-decimal stablecoin).
  { amount: 1, cents: 1000000, decimals: 6 },
  { amount: 0.000001, cents: 1, decimals: 6 },
  { amount: 12.345678, cents: 12345678, decimals: 6 },
  // Explicit rounding modes.
  { amount: 1.005, cents: 100, rounding: 'floor' },
  { amount: 1.001, cents: 101, rounding: 'ceil' },
  { amount: 1.004, cents: 100, rounding: 'round' },
];

/**
 * Compute the expected integer cents value for a verified case.
 *
 * This mirrors the documented math (`amount * 10^decimals` with the selected
 * rounding mode) so tests can assert the helper output against an independent
 * calculation rather than a hard-coded duplicate.
 */
export function expectedCents(testCase: CentsMultiplierCase): number {
  const decimals = testCase.decimals ?? DEFAULT_DECIMALS;
  const rounding = testCase.rounding ?? 'round';
  const scaled = testCase.amount * centsMultiplier(decimals);
  switch (rounding) {
    case 'floor':
      return Math.floor(scaled);
    case 'ceil':
      return Math.ceil(scaled);
    case 'round':
    default:
      return Math.round(scaled);
  }
}
