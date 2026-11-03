import { describe, expect, it } from 'vitest';
import { formatPrice } from './format';

describe('formatPrice', () => {
  it('formats cents with default currency', () => {
    expect(formatPrice(1850)).toBe('18.50 USD');
  });
  it('pads small fractions', () => {
    expect(formatPrice(305, 'EUR')).toBe('3.05 EUR');
  });
});
