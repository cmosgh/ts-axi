import { describe, expect, it } from 'vitest';
import { Cart } from '../lib';
import { reduceCart, type CartAction } from './useCart';

const beans = { id: 'beans-1kg', name: 'House beans 1kg', priceCents: 1850, qty: 1 };

describe('reduceCart', () => {
  it('adds an item', () => {
    expect(reduceCart(Cart.empty(), 'add', beans).total()).toBe('18.50 USD');
  });
  it('removes an item', () => {
    const action: CartAction = 'remove';
    const filled = reduceCart(Cart.empty(), 'add', beans);
    const cart = reduceCart(filled, action, beans);
    expect(cart.total()).toBe('0.00 USD');
  });
});
