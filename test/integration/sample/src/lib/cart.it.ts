import { describe, expect, it } from 'vitest';
import { Cart, formatPrice } from './index';

describe('cart + format integration', () => {
  it('total matches formatPrice of the sum', () => {
    const cart = Cart.empty();
    cart.add({ id: 'b', name: 'Beans', priceCents: 1850, qty: 2 });
    expect(cart.total()).toBe(formatPrice(3700));
  });
});
