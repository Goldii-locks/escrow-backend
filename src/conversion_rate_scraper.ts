import { ConversionRate } from './types';

export enum ConversionRateScraperError {
  NEGATIVE_PARAMETER = 'NEGATIVE_PARAMETER',
  INVALID_PARAMETER = 'INVALID_PARAMETER',
}

export class ConversionRateScraperErrorException extends Error {
  public readonly code: ConversionRateScraperError;

  constructor(code: ConversionRateScraperError, message: string) {
    super(message);
    this.name = 'ConversionRateScraperErrorException';
    this.code = code;
  }
}

export interface ConversionRateScraperParams {
  amount: number;
  fromCurrency: string;
  toCurrency: string;
}

function assertNonNegative(value: number, name: string): void {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new ConversionRateScraperErrorException(
      ConversionRateScraperError.INVALID_PARAMETER,
      `Parameter "${name}" must be a valid number`,
    );
  }

  if (value < 0) {
    throw new ConversionRateScraperErrorException(
      ConversionRateScraperError.NEGATIVE_PARAMETER,
      `Parameter "${name}" must not be negative`,
    );
  }
}

export function validateConversionRateScraperParams(
  params: ConversionRateScraperParams,
): void {
  assertNonNegative(params.amount, 'amount');
}

export async function conversion_rate_scraper(
  params: ConversionRateScraperParams,
): Promise<ConversionRate> {
  validateConversionRateScraperParams(params);

  // Existing scraping/loading logic continues below.
  return loadConversionRate(params);
}

async function loadConversionRate(
  params: ConversionRateScraperParams,
): Promise<ConversionRate> {
  throw new Error('Not implemented');
}
