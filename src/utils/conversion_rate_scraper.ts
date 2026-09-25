/**
 * Oracle conversion-rate scraper helpers with overflow / digit-limit validation,
 * in-process rate limiting, CSV format export, and split-sum assertions.
 * Rejects rates and notionals whose digit count would risk unsafe numeric overflow.
 */

/** Max decimal digits allowed for a conversion rate or notional (below Number.MAX_SAFE_INTEGER). */
export const MAX_SAFE_DIGITS = 15;

export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "OVERFLOW_EXCESSIVE_DIGITS",
  INVALID_RATE: "OVERFLOW_INVALID_RATE",
  PRODUCT_OVERFLOW: "OVERFLOW_PRODUCT_EXCEEDED",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  INVALID_CSV_INPUT: "INVALID_CSV_INPUT",
  SUM_MISMATCH: "SUM_MISMATCH",
  INVALID_AMOUNT: "INVALID_AMOUNT",
} as const;

export type OverflowErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ValidationResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: OverflowErrorCode };

// ---------------------------------------------------------------------------
// TASK 1 – In-process rate limiter for conversion-rate scraper calls
// ---------------------------------------------------------------------------

type RateBucket = {
  count: number;
  resetAt: number;
};

const conversionRateBuckets = new Map<string, RateBucket>();

/**
 * Reset all in-process rate-limit buckets. Intended for use in tests only.
 */
export function resetConversionRateLimitBuckets(): void {
  conversionRateBuckets.clear();
}

function resolveConversionRateWindowMs(): number {
  const configured = Number(
    process.env.CONVERSION_RATE_WINDOW_MS ?? "60000"
  );
  return Number.isFinite(configured) && configured > 0 ? configured : 60000;
}

function resolveConversionRateMax(): number {
  const configured = Number(
    process.env.CONVERSION_RATE_MAX ?? "30"
  );
  return Number.isFinite(configured) && configured > 0 ? configured : 30;
}

export type RateLimitResult =
  | { allowed: true; remaining: number; resetAt: number }
  | { allowed: false; remaining: 0; resetAt: number; code: typeof ERROR_CODES.RATE_LIMIT_EXCEEDED };

/**
 * Check whether the caller identified by `clientKey` (e.g. an IP address or
 * API-key fingerprint) has exceeded the configured conversion-rate scraper
 * request budget for the current sliding window.
 *
 * Returns `{ allowed: true }` when the request is within budget, or
 * `{ allowed: false, code: "RATE_LIMIT_EXCEEDED" }` when the budget is
 * exhausted so the caller can return HTTP 429.
 */
export function checkConversionRateLimit(clientKey: string): RateLimitResult {
  const windowMs = resolveConversionRateWindowMs();
  const maxRequests = resolveConversionRateMax();
  const now = Date.now();

  let bucket = conversionRateBuckets.get(clientKey);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    conversionRateBuckets.set(clientKey, bucket);
  }

  bucket.count += 1;

  if (bucket.count > maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: bucket.resetAt,
      code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
    };
  }

  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - bucket.count),
    resetAt: bucket.resetAt,
  };
}

function digitCount(normalized: string): number {
  const digits = normalized.replace(/^-/, "").replace(/^0+(?=\d)/, "");
  return digits.length === 0 ? 1 : digits.length;
}

function parseIntegerInput(
  input: string | number | bigint,
  label: string,
  invalidCode: OverflowErrorCode
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
  } else {
    raw = input.trim();
    if (!/^-?\d+$/.test(raw)) {
      return {
        ok: false,
        error: `${label} must be an integer numeric value`,
        code: invalidCode,
      };
    }
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

// ---------------------------------------------------------------------------
// TASK 2 – CSV format exporters
// ---------------------------------------------------------------------------

/** A single row in a conversion-rate CSV export. */
export interface ConversionRateRow {
  /** Human-readable asset pair label, e.g. "XLM/USDC". */
  pair: string;
  /** Integer-scaled rate value (fixed-point). */
  rate: string | number | bigint;
  /** Optional Unix timestamp (seconds) when the rate was observed. */
  timestamp?: number;
}

export type CsvExportResult =
  | { ok: true; csv: string }
  | { ok: false; error: string; code: OverflowErrorCode };

/**
 * Escape a single CSV cell value.
 * Wraps the value in double-quotes if it contains a comma, double-quote, or
 * newline, and escapes embedded double-quotes by doubling them.
 */
function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Serialize an array of conversion-rate rows to RFC 4180-compatible CSV text.
 *
 * Columns: pair, rate, timestamp (omitted when none of the rows carry one).
 *
 * Each `rate` value is validated against the digit-limit before serialization;
 * the function short-circuits and returns an error result if any rate is
 * invalid, so the caller never writes a file with malformed data.
 */
export function exportConversionRatesToCsv(
  rows: ConversionRateRow[]
): CsvExportResult {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      ok: false,
      error: "rows must be a non-empty array",
      code: ERROR_CODES.INVALID_CSV_INPUT,
    };
  }

  const includeTimestamp = rows.some((r) => r.timestamp !== undefined);
  const headerCols = includeTimestamp
    ? ["pair", "rate", "timestamp"]
    : ["pair", "rate"];
  const lines: string[] = [headerCols.join(",")];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    if (typeof row.pair !== "string" || row.pair.trim() === "") {
      return {
        ok: false,
        error: `rows[${i}].pair must be a non-empty string`,
        code: ERROR_CODES.INVALID_CSV_INPUT,
      };
    }

    const rateCheck = validateConversionRate(row.rate);
    if (!rateCheck.ok) {
      return {
        ok: false,
        error: `rows[${i}].rate: ${rateCheck.error}`,
        code: rateCheck.code,
      };
    }

    const cells: string[] = [
      escapeCsvCell(row.pair.trim()),
      escapeCsvCell(rateCheck.value.toString()),
    ];

    if (includeTimestamp) {
      const ts = row.timestamp;
      if (ts !== undefined) {
        if (
          typeof ts !== "number" ||
          !Number.isFinite(ts) ||
          !Number.isInteger(ts) ||
          ts < 0
        ) {
          return {
            ok: false,
            error: `rows[${i}].timestamp must be a non-negative integer`,
            code: ERROR_CODES.INVALID_CSV_INPUT,
          };
        }
        cells.push(String(ts));
      } else {
        cells.push("");
      }
    }

    lines.push(cells.join(","));
  }

  return { ok: true, csv: lines.join("\r\n") };
}

/**
 * Parse a CSV string produced by `exportConversionRatesToCsv` back into an
 * array of `ConversionRateRow` objects. Each rate value is re-validated on
 * the way in so round-tripped data is guaranteed to be within the digit limit.
 */
export function parseConversionRatesCsv(
  csv: string
): { ok: true; rows: ConversionRateRow[] } | { ok: false; error: string; code: OverflowErrorCode } {
  if (typeof csv !== "string" || csv.trim() === "") {
    return {
      ok: false,
      error: "csv must be a non-empty string",
      code: ERROR_CODES.INVALID_CSV_INPUT,
    };
  }

  const rawLines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (rawLines.length < 2) {
    return {
      ok: false,
      error: "csv must contain a header row and at least one data row",
      code: ERROR_CODES.INVALID_CSV_INPUT,
    };
  }

  const header = rawLines[0].split(",").map((h) => h.trim());
  const hasPair = header[0] === "pair";
  const hasRate = header[1] === "rate";
  const hasTimestamp = header[2] === "timestamp";

  if (!hasPair || !hasRate) {
    return {
      ok: false,
      error: "csv header must start with 'pair,rate'",
      code: ERROR_CODES.INVALID_CSV_INPUT,
    };
  }

  const rows: ConversionRateRow[] = [];

  for (let i = 1; i < rawLines.length; i++) {
    const cols = rawLines[i].split(",");

    const pair = cols[0]?.trim() ?? "";
    if (pair === "") {
      return {
        ok: false,
        error: `row ${i}: pair must be a non-empty string`,
        code: ERROR_CODES.INVALID_CSV_INPUT,
      };
    }

    const rateRaw = cols[1]?.trim() ?? "";
    const rateCheck = validateConversionRate(rateRaw);
    if (!rateCheck.ok) {
      return {
        ok: false,
        error: `row ${i}: rate: ${rateCheck.error}`,
        code: rateCheck.code,
      };
    }

    const row: ConversionRateRow = {
      pair,
      rate: rateCheck.value.toString(),
    };

    if (hasTimestamp && cols[2] !== undefined && cols[2].trim() !== "") {
      const ts = Number(cols[2].trim());
      if (!Number.isFinite(ts) || !Number.isInteger(ts) || ts < 0) {
        return {
          ok: false,
          error: `row ${i}: timestamp must be a non-negative integer`,
          code: ERROR_CODES.INVALID_CSV_INPUT,
        };
      }
      row.timestamp = ts;
    }

    rows.push(row);
  }

  return { ok: true, rows };
}

// ---------------------------------------------------------------------------
// TASK 3 – Split-sum assertions
// ---------------------------------------------------------------------------

export type SumCheckResult =
  | { ok: true; total: bigint; isMatch: boolean }
  | { ok: false; error: string; code: OverflowErrorCode };

/**
 * Assert that a set of split amounts adds up to an expected base amount.
 *
 * Each split value and the base amount are individually validated against the
 * digit limit before any arithmetic so the function never silently operates on
 * unsafe integers. When `strict` is true (the default) the function returns
 * `{ isMatch: false }` — rather than an error — whenever the sum does not
 * equal the base; callers that want to treat a mismatch as a hard failure
 * should check `isMatch` and act accordingly.
 */
export function assertConversionSplitSum(
  splits: Array<string | number | bigint>,
  expectedBase: string | number | bigint
): SumCheckResult {
  if (!Array.isArray(splits) || splits.length === 0) {
    return {
      ok: false,
      error: "splits must be a non-empty array",
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }

  const baseCheck = parseIntegerInput(
    expectedBase,
    "expectedBase",
    ERROR_CODES.INVALID_AMOUNT
  );
  if (!baseCheck.ok) {
    return baseCheck;
  }

  let total = 0n;

  for (let i = 0; i < splits.length; i++) {
    const splitCheck = parseIntegerInput(
      splits[i],
      `splits[${i}]`,
      ERROR_CODES.INVALID_AMOUNT
    );
    if (!splitCheck.ok) {
      return splitCheck;
    }

    const next = total + splitCheck.value;
    // Guard against the running total itself overflowing the digit limit.
    if (digitCount(next.toString()) > MAX_SAFE_DIGITS) {
      return {
        ok: false,
        error: `split total exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
        code: ERROR_CODES.PRODUCT_OVERFLOW,
      };
    }

    total = next;
  }

  return {
    ok: true,
    total,
    isMatch: total === baseCheck.value,
  };
}
