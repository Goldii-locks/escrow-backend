import { stablecoin_cents_multiplier } from '../src/stablecoin_cents_multiplier';

describe('stablecoin_cents_multiplier', () => {
  it('returns the input unchanged for whole-dollar amounts', () => {
    expect(stablecoin_cents_multiplier(0)).toBe(0);
    expect(stablecoin_cents_multiplier(1)).toBe(100);
    expect(stablecoin_cents_multiplier(5)).toBe(500);
    expect(stablecoin_cents_multiplier(100)).toBe(10000);
  });

  it('converts typical fractional dollar amounts to integer cents', () => {
    expect(stablecoin_cents_multiplier(0.01)).toBe(1);
    expect(stablecoin_cents_multiplier(0.1)).toBe(10);
    expect(stablecoin_cents_multiplier(0.25)).toBe(25);
    expect(stablecoin_cents_multiplier(1.5)).toBe(150);
    expect(stablecoin_cents_multiplier(12.34)).toBe(1234);
    expect(stablecoin_cents_multiplier(99.99)).toBe(9999);
  });

  it('handles precision-sensitive inputs without floating point drift', () => {
    expect(stablecoin_cents_multiplier(0.1 + 0.2)).toBe(30);
    expect(stablecoin_cents_multiplier(1.005)).toBe(101);
    expect(stablecoin_cents_multiplier(2.675)).toBe(268);
    expect(stablecoin_cents_multiplier(0.07)).toBe(7);
    expect(stablecoin_cents_multiplier(0.29)).toBe(29);
    expect(stablecoin_cents_multiplier(1.13)).toBe(113);
  });

  it('rounds half-cent values consistently', () => {
    expect(stablecoin_cents_multiplier(0.005)).toBe(1);
    expect(stablecoin_cents_multiplier(0.004)).toBe(0);
    expect(stablecoin_cents_multiplier(0.015)).toBe(2);
    expect(stablecoin_cents_multiplier(0.014)).toBe(1);
  });

  it('handles large amounts within safe integer range', () => {
    expect(stablecoin_cents_multiplier(1000)).toBe(100000);
    expect(stablecoin_cents_multiplier(100000)).toBe(10000000);
    expect(stablecoin_cents_multiplier(90071992547409.91)).toBe(9007199254740991);
  });

  it('handles negative amounts symmetrically', () => {
    expect(stablecoin_cents_multiplier(-1)).toBe(-100);
    expect(stablecoin_cents_multiplier(-0.01)).toBe(-1);
    expect(stablecoin_cents_multiplier(-12.34)).toBe(-1234);
    expect(stablecoin_cents_multiplier(-0.005)).toBe(-1);
  });

  it('returns integer results for all tested inputs', () => {
    const inputs = [0, 0.01, 0.1, 0.25, 1.5, 12.34, 99.99, 1.005, 2.675, -1, -0.01, -12.34];
    for (const input of inputs) {
      expect(Number.isInteger(stablecoin_cents_multiplier(input))).toBe(true);
    }
  });
});
