import { stablecoinCentsMultiplier } from '../src/utils/stablecoin_cents_multiplier';

describe('stablecoinCentsMultiplier', () => {
  it('converts whole-dollar amounts to cents', () => {
    expect(stablecoinCentsMultiplier(1)).toBe(100);
    expect(stablecoinCentsMultiplier(25)).toBe(2500);
  });

  it('preserves fractional cents precision', () => {
    expect(stablecoinCentsMultiplier(1.005)).toBe(100.5);
    expect(stablecoinCentsMultiplier(0.01)).toBe(1);
  });

  it('returns integer cents for DB storage without losing precision', () => {
    const result = stablecoinCentsMultiplier(12.34);
    expect(Number.isInteger(result)).toBe(true);
    expect(result).toBe(1234);
  });

  it('rounds to the nearest cent when sub-cent precision is present', () => {
    expect(stablecoinCentsMultiplier(1.234)).toBe(123);
    expect(stablecoinCentsMultiplier(1.235)).toBe(124);
  });

  it('handles zero and negative amounts', () => {
    expect(stablecoinCentsMultiplier(0)).toBe(0);
    expect(stablecoinCentsMultiplier(-1.5)).toBe(-150);
  });

  it('asserts written row attributes preserve full precision', () => {
    const row = { amount_cents: stablecoinCentsMultiplier(99.99) };
    expect(row.amount_cents).toBe(9999);
    expect(Number.isInteger(row.amount_cents)).toBe(true);
  });
});
