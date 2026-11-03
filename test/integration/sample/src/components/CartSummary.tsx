import { useState } from 'react';
import { Cart } from '../lib';

export default function CartSummary() {
  const [cart] = useState(() => Cart.empty());
  const [total, setTotal] = useState(cart.total());

  function addBeans() {
    cart.add({ id: 'beans-1kg', name: 'House beans 1kg', priceCents: 1850, qty: 1 });
    setTotal(cart.total());
  }

  function dynamicAccess() {
    (cart as any).remove('x');
    const key = 'total';
    return (cart as unknown as Record<string, unknown>)[key];
  }

  return (
    <div className="cart">
      <button onClick={addBeans}>Add beans</button>
      <button onClick={dynamicAccess}>Probe</button>
      <span>Total: {total}</span>
    </div>
  );
}
