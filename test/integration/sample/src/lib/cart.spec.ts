import { describe, expect, it } from 'vitest';
import { Cart } from './cart';

describe('Cart', () => {
  it('sums items', () => {
    const cart = Cart.empty();
    cart.add({ id: 'a', name: 'Espresso', priceCents: 300, qty: 2 });
    expect(cart.total()).toBe('6.00 USD');
  });
  it('removes items', () => {
    const cart = Cart.empty();
    cart.add({ id: 'a', name: 'Espresso', priceCents: 300, qty: 1 });
    cart.remove('a');
    expect(cart.total()).toBe('0.00 USD');
  });
});
