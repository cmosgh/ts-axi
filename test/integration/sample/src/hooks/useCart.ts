import { Cart, type CartItem } from '../lib';
import { useLocalStorage } from './useLocalStorage';

export type CartAction = 'add' | 'remove';

export interface UseCartResult {
  cart: Cart;
  add: (item: CartItem) => void;
  remove: (id: string) => void;
  total: string;
}

/** Applies one action to the cart and returns it (Cart mutates in place). */
export function reduceCart(cart: Cart, action: CartAction, item: CartItem): Cart {
  if (action === 'add') {
    cart.add(item);
  } else {
    cart.remove(item.id);
  }
  return cart;
}

export function useCart(): UseCartResult {
  const [items, setItems] = useLocalStorage<CartItem[]>('lantern-cart', []);
  const cart = items.reduce((c, i) => reduceCart(c, 'add', i), Cart.empty());

  function dispatch(action: CartAction, item: CartItem) {
    setItems(action === 'add' ? [...items, item] : items.filter((i) => i.id !== item.id));
  }

  return {
    cart,
    add: (item) => dispatch('add', item),
    remove: (id) => dispatch('remove', { id, name: '', priceCents: 0, qty: 0 }),
    total: cart.total(),
  };
}
