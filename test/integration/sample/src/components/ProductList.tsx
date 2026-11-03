import { useMemo } from 'react';
import { useCart } from '../hooks/useCart';
import type { CartItem } from '../lib';
import { ProductCard } from './ProductCard';

export default function ProductList() {
  const { add, total } = useCart();
  const items = useMemo<CartItem[]>(
    () => [
      { id: 'beans-1kg', name: 'House beans 1kg', priceCents: 1850, qty: 1 },
      { id: 'filter-100', name: 'Paper filters x100', priceCents: 640, qty: 1 },
      { id: 'mug-lantern', name: 'Lantern mug', priceCents: 1400, qty: 1 },
    ],
    [],
  );

  return (
    <section className="products">
      {items.map((item) => (
        <ProductCard key={item.id} item={item} onAdd={add} />
      ))}
      <p>Cart: {total}</p>
    </section>
  );
}
