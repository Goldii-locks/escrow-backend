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
 *
 * All scaling is done with bigint arithmetic on the decimal digits, so binary
 * floating-point error (e.g. `0.29 * 100 === 28.999999999999996`) can never
 * leak into the result. The rounding mode is applied to the discarded digits,
 * not to a float. Number inputs are converted via their decimal string form,
 * so `0.29` is parsed as `"0.29"`.
 *
 * Returns a number, throwing a RangeError when the exact result exceeds
 * Number.MAX_SAFE_INTEGER.
 */
export function toCents(
  amount: number | string,
  options: CentsMultiplierOptions = {},
): number {
  const decimals = options.decimals ?? DEFAULT_DECIMALS;
  const rounding = options.rounding ?? 'round';
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`decimals must be a non-negative integer, received ${decimals}`);
  }

  const text = typeof amount === 'string' ? amount : numberToDecimalString(amount);
  const parsed = parseSignedDecimal(text, 'amount');
  const scaled = scaleDecimal(parsed, decimals, rounding);

  if (scaled > BigInt(Number.MAX_SAFE_INTEGER) || scaled < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `converted cents value exceeds Number.MAX_SAFE_INTEGER; use a smaller amount or fewer decimals`,
    );
  }
  return Number(scaled);
}

/**
 * Convert an integer cents value back into a human-readable amount.
 *
 * Uses exact decimal arithmetic (no float division), so e.g.
 * `fromCents(7)` is exactly `0.07`.
 */
export function fromCents(
  cents: number | string,
  options: CentsMultiplierOptions = {},
): number {
  const decimals = options.decimals ?? DEFAULT_DECIMALS;
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`decimals must be a non-negative integer, received ${decimals}`);
  }

  const text = typeof cents === 'string' ? cents : numberToDecimalString(cents);
  const parsed = parseSignedDecimal(text, 'cents');

  // Represent cents * 10^-decimals exactly as a decimal string, then convert.
  const negative = parsed.sign < 0;
  const digits = `${parsed.int}${parsed.frac}`;
  const pointAt = digits.length - parsed.frac.length - decimals;
  let decimal: string;
  if (pointAt >= digits.length) {
    decimal = `${digits}${'0'.repeat(pointAt - digits.length)}`;
  } else if (pointAt > 0) {
    decimal = `${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
  } else {
    decimal = `0.${'0'.repeat(-pointAt)}${digits}`;
  }
  decimal = decimal.replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  if (decimal === '' || decimal === '0.') decimal = '0';
  return Number(`${negative ? '-' : ''}${decimal}`);
}

/** Parsed signed decimal: sign (+1/-1), integer and fraction digit strings. */
interface SignedDecimal {
  sign: 1 | -1;
  int: string;
  frac: string;
}

/**
 * Parse a decimal literal into sign/integer/fraction parts.
 * Accepts an optional leading sign and at most one decimal point.
 */
function parseSignedDecimal(text: string, label: string): SignedDecimal {
  const trimmed = text.trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
    throw new TypeError(`${label} must be a finite number, received ${text}`);
  }
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) {
    throw new TypeError(`${label} must be a finite number, received ${text}`);
  }
  return {
    sign: match[1] === '-' ? -1 : 1,
    int: match[2] === '' ? '0' : match[2].replace(/^0+(?=\d)/, ''),
    frac: match[3] ?? '',
  };
}

/**
 * Render a finite number in plain decimal notation, expanding exponents
 * (e.g. `1e-7` -> `"0.0000001"`) so digit parsing stays exact.
 */
function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(`amount must be a finite number, received ${value}`);
  }
  let text = String(value);
  if (!/[eE]/.test(text)) {
    return text;
  }
  const negative = text.startsWith('-');
  if (negative) text = text.slice(1);
  const [mantissa, expPart] = text.split(/[eE]/);
  const exponent = parseInt(expPart, 10);
  const dotIndex = mantissa.indexOf('.');
  const digits = mantissa.replace('.', '');
  const pointIndex = (dotIndex === -1 ? mantissa.length : dotIndex) + exponent;
  let expanded: string;
  if (pointIndex <= 0) {
    expanded = `0.${'0'.repeat(-pointIndex)}${digits}`;
  } else if (pointIndex >= digits.length) {
    expanded = `${digits}${'0'.repeat(pointIndex - digits.length)}`;
  } else {
    expanded = `${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
  }
  return `${negative ? '-' : ''}${expanded}`;
}

/**
 * Scale a parsed decimal by 10^decimals with bigint arithmetic, applying the
 * rounding mode to the discarded fraction digits.
 */
function scaleDecimal(
  parsed: SignedDecimal,
  decimals: number,
  rounding: 'floor' | 'ceil' | 'round',
): bigint {
  const kept = (parsed.frac + '0'.repeat(decimals)).slice(0, decimals);
  const discarded = parsed.frac.slice(decimals);
  const magnitude = BigInt(`${parsed.int}${kept}`);
  const hasRemainder = /[1-9]/.test(discarded);
  if (!hasRemainder) {
    return parsed.sign < 0 ? -magnitude : magnitude;
  }

  const first = discarded[0];
  const rest = discarded.slice(1);
  const aboveHalf = first > '5' || (first === '5' && /[1-9]/.test(rest));
  const isHalf = first === '5' && !/[1-9]/.test(rest);

  let roundUpMagnitude: boolean;
  switch (rounding) {
    case 'floor':
      // Toward -infinity: only negative values round away from zero.
      roundUpMagnitude = parsed.sign < 0;
      break;
    case 'ceil':
      // Toward +infinity: only positive values round away from zero.
      roundUpMagnitude = parsed.sign > 0;
      break;
    case 'round':
    default:
      // Half-up (matches Math.round: ties go toward +infinity).
      roundUpMagnitude = aboveHalf || (isHalf && parsed.sign > 0);
      break;
  }

  const rounded = roundUpMagnitude ? magnitude + 1n : magnitude;
  return parsed.sign < 0 ? -rounded : rounded;
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
  // Precision-sensitive inputs (exact decimal behavior, not float error).
  { amount: 0.1 + 0.2, cents: 30 },
  { amount: 1.005, cents: 101 },
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
 * Uses exact decimal-string arithmetic (independent of `toCents`) so tests
 * assert the helper output against a separately derived expectation rather
 * than a hard-coded duplicate of float math.
 */
export function expectedCents(testCase: CentsMultiplierCase): number {
  const decimals = testCase.decimals ?? DEFAULT_DECIMALS;
  const rounding = testCase.rounding ?? 'round';
  const text = String(testCase.amount);
  const dot = text.indexOf('.');
  const int = dot === -1 ? text : text.slice(0, dot);
  const frac = dot === -1 ? '' : text.slice(dot + 1);
  const kept = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const discarded = frac.slice(decimals);
  let base = BigInt(`${int}${kept}`);
  if (/[1-9]/.test(discarded)) {
    const first = discarded[0];
    const rest = discarded.slice(1);
    const aboveHalf = first > '5' || (first === '5' && /[1-9]/.test(rest));
    const isHalf = first === '5' && !/[1-9]/.test(rest);
    if (rounding === 'ceil' || (rounding === 'round' && (aboveHalf || isHalf))) {
      base += 1n;
    }
  }
  return Number(base);
}
